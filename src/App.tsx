import { feature } from 'topojson-client'
import { geoEquirectangular, geoPath } from 'd3-geo'
import countryCodeLookup from 'country-code-lookup'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { GlobeMethods } from 'react-globe.gl'
import { ArrowUpRight, ChevronRight, Compass, Globe2, LoaderCircle, MapPin, PanelRightClose, PanelRightOpen, Pencil, Plus, Trash2, X } from 'lucide-react'
import atlas from 'world-atlas/countries-50m.json'
import hitAtlas from 'world-atlas/countries-110m.json'
import './GlobeAtlas.css'

const Globe = lazy(() => import('react-globe.gl'))

type Trip = {
  id: string
  city: string
  country: string
  state?: string
  lat: number
  lng: number
  starred?: boolean
  sources?: string[]
}

type StoredPlace = Omit<Trip, 'starred' | 'sources'>
type StoredHome = StoredPlace & { visits: StoredPlace[] }

type CountryShape = {
  properties?: { name?: string }
  geometry: { type: string; coordinates: number[] }
}

type CitySuggestion = { name: string; country: string; state?: string; lat: number; lng: number }
type TripStore = { name: string; homes: StoredHome[]; starredCountries: string[] }
type StoreConflict = { store: TripStore; revision: string }
type NewEntryContext = { source?: Trip; isHome?: boolean }

type Draft = Omit<Trip, 'id' | 'lat' | 'lng' | 'starred' | 'sources'> & {
  lat: string
  lng: string
  starred: boolean
  sources: string[]
}

const countryFeatures = feature(
  atlas as never,
  (atlas as unknown as { objects: { countries: never } }).objects.countries,
) as unknown as { features: CountryShape[] }
const countries = countryFeatures.features
const hitCountryFeatures = feature(
  hitAtlas as never,
  (hitAtlas as unknown as { objects: { countries: never } }).objects.countries,
) as unknown as { features: CountryShape[] }
const countryHitAreas = hitCountryFeatures.features
const landFeatures = feature(
  atlas as never,
  (atlas as unknown as { objects: { land: never } }).objects.land,
) as unknown as { features: CountryShape[] }
const landShape = landFeatures.features[0]
const initialView = { lat: 24, lng: 10, altitude: 2.15 }
const emptyDraft: Draft = { city: '', country: '', lat: '', lng: '', starred: false, sources: [] }

function formatPlaceLabel(place: Pick<Trip, 'city' | 'country' | 'state'>): string {
  if (place.state) return `${place.city}, ${place.state}`
  const countryCode = countryCodeLookup.byCountry(place.country)?.iso2
  return `${place.city}, ${countryCode ?? place.country}`
}

function toStoredPlace(trip: Trip): StoredPlace {
  return {
    id: trip.id,
    city: trip.city,
    country: trip.country,
    state: trip.state,
    lat: trip.lat,
    lng: trip.lng,
  }
}

function flattenStore(store: TripStore): Trip[] {
  return store.homes.flatMap(({ visits, ...home }) => [
    { ...home, starred: true, sources: [] },
    ...visits.map((visit) => ({ ...visit, starred: false, sources: [home.id] })),
  ])
}

function serializeStore(trips: Trip[], starredCountries: string[], name: string): TripStore {
  const homes = trips.filter((trip) => trip.starred).map((home) => ({
    ...toStoredPlace(home),
    visits: trips.filter((trip) => !trip.starred && trip.sources?.[0] === home.id).map(toStoredPlace),
  }))
  return { name, homes, starredCountries }
}

function createGlobeTexture(
  visitedCountries: Set<string>,
  starredCountries: string[],
  selectedCountry: string | null,
): string {
  const canvas = document.createElement('canvas')
  canvas.width = 2048
  canvas.height = 1024
  const context = canvas.getContext('2d')
  if (!context) return ''

  const projection = geoEquirectangular()
    .scale(canvas.width / (2 * Math.PI))
    .translate([canvas.width / 2, canvas.height / 2])
    .clipExtent([[0, 0], [canvas.width, canvas.height]])
  const path = geoPath(projection, context)
  context.fillStyle = '#173e39'
  context.fillRect(0, 0, canvas.width, canvas.height)

  context.beginPath()
  path(landShape as never)
  context.fillStyle = '#64a893'
  context.fill()

  for (const country of countries) {
    const name = country.properties?.name ?? ''
    context.beginPath()
    path(country as never)
    context.fillStyle = name === selectedCountry ? '#f4a77a'
      : starredCountries.includes(name) ? '#f3ca80'
        : visitedCountries.has(name) ? '#e48469' : '#64a893'
    context.fill()
  }

  context.lineJoin = 'round'
  context.lineCap = 'round'
  context.lineWidth = 1.15
  for (const country of countries) {
    const name = country.properties?.name ?? ''
    context.beginPath()
    path(country as never)
    context.strokeStyle = name === selectedCountry || starredCountries.includes(name)
      ? 'rgba(255, 224, 177, 0.96)'
      : 'rgba(183, 222, 199, 0.58)'
    context.stroke()
  }

  return canvas.toDataURL('image/png')
}

function App() {
  const isAdmin = window.location.pathname.replace(/\/+$/, '') === '/admin'
  const [trips, setTrips] = useState<Trip[]>([])
  const [atlasName, setAtlasName] = useState('')
  const [starredCountries, setStarredCountries] = useState<string[]>([])
  const [storeConflict, setStoreConflict] = useState<StoreConflict | null>(null)
  const [apiStatus, setApiStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [apiError, setApiError] = useState<string | null>(null)
  const [tableCollapsed, setTableCollapsed] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null)
  const [expandedCountry, setExpandedCountry] = useState<string | null>(null)
  const [expandedAdminHomes, setExpandedAdminHomes] = useState<Set<string>>(() => new Set())
  const [editingTrip, setEditingTrip] = useState<Trip | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [formError, setFormError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [citySuggestionResult, setCitySuggestionResult] = useState<{ query: string; cities: CitySuggestion[] }>({ query: '', cities: [] })
  const [globeReady, setGlobeReady] = useState(false)
  const [globeSize, setGlobeSize] = useState({ width: 720, height: 540 })
  const globePointerInsideRef = useRef(false)
  const hoveredPinRef = useRef(false)
  const globeRef = useRef<GlobeMethods | undefined>(undefined)
  const stageRef = useRef<HTMLDivElement>(null)
  const tripDialogRef = useRef<HTMLDialogElement>(null)
  const cityInputRef = useRef<HTMLInputElement>(null)
  const dialogOpenerRef = useRef<HTMLElement | null>(null)
  const storeRevisionRef = useRef<string | null>(null)
  const storeConflictRef = useRef<StoreConflict | null>(null)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const saveGenerationRef = useRef(0)

  const visitedCountries = useMemo(() => new Set(trips.map((trip) => trip.country)), [trips])
  const mapPlaces = useMemo(() => {
    const uniquePlaces = new Map<string, Trip>()
    for (const trip of trips) {
      const key = `${trip.city.toLowerCase()}|${trip.country.toLowerCase()}`
      const current = uniquePlaces.get(key)
      if (!current || trip.starred) uniquePlaces.set(key, trip)
    }
    return [...uniquePlaces.values()]
  }, [trips])
  const countryList = useMemo(() => [...new Set(mapPlaces.map((trip) => trip.country))].sort(), [mapPlaces])
  const homeCities = trips.filter((trip) => trip.starred)
  const selectedTrip = trips.find((trip) => trip.id === selectedId)
  const citySuggestions = citySuggestionResult.query === draft.city.trim() ? citySuggestionResult.cities : []
  const globeTexture = useMemo(() => createGlobeTexture(visitedCountries, starredCountries, selectedCountry), [selectedCountry, starredCountries, visitedCountries])
  const routeArcs = useMemo(() => trips.flatMap((destination) => {
    const sourceId = destination.sources?.[0]
    const source = sourceId ? trips.find((trip) => trip.id === sourceId) : undefined
    return source && source.id !== destination.id ? [{ start: source, end: destination }] : []
  }), [trips])

  useEffect(() => {
    const name = atlasName.trim()
    document.title = isAdmin ? 'Travel log editor' : name ? `${name}'s travel log` : 'Travel log'
  }, [atlasName, isAdmin])

  const applyStore = useCallback((store: TripStore, revision: string) => {
    const loadedTrips = flattenStore(store)
    storeRevisionRef.current = revision
    setAtlasName(typeof store.name === 'string' ? store.name : '')
    setTrips(loadedTrips)
    setStarredCountries(Array.isArray(store.starredCountries) ? store.starredCountries : [])
    if (isAdmin) {
      const firstHome = loadedTrips.find((trip) => trip.starred)
      setExpandedAdminHomes(new Set(firstHome ? [firstHome.id] : []))
    }
  }, [isAdmin])

  function recordConflict(conflict: StoreConflict) {
    storeConflictRef.current = conflict
    saveGenerationRef.current += 1
    setStoreConflict(conflict)
  }

  async function saveStore(store: TripStore) {
    const expectedRevision = storeRevisionRef.current
    if (!expectedRevision) {
      setApiError('The current file revision is unavailable. Re-read the saved data before editing.')
      return
    }

    try {
      const response = await fetch('/api/trips', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'If-Match': expectedRevision },
        body: JSON.stringify(store),
      })
      if (response.status === 409) {
        const revision = response.headers.get('ETag')
        const result = await response.json() as { store: TripStore }
        if (!revision) throw new Error('The updated file revision is unavailable.')
        recordConflict({ store: result.store, revision })
        return
      }
      if (!response.ok) throw new Error('Your changes could not be saved. Check admin access to /api/trips.')
      const revision = response.headers.get('ETag')
      if (!revision) throw new Error('The saved file revision is unavailable.')
      storeRevisionRef.current = revision
      setApiError(null)
    } catch (error: unknown) {
      setApiError(error instanceof Error ? error.message : 'Your changes could not be saved.')
    }
  }

  function keepLocalVersion() {
    if (!storeConflict) return
    storeRevisionRef.current = storeConflict.revision
    storeConflictRef.current = null
    saveGenerationRef.current += 1
    setStoreConflict(null)
  }

  async function rereadCurrentState() {
    try {
      const response = await fetch('/api/trips')
      if (!response.ok) throw new Error('The current atlas data could not be re-read.')
      const revision = response.headers.get('ETag')
      if (!revision) throw new Error('The current file revision is unavailable.')
      const store = await response.json() as TripStore
      applyStore(store, revision)
      storeConflictRef.current = null
      saveGenerationRef.current += 1
      setStoreConflict(null)
      setApiError(null)
    } catch (error: unknown) {
      setApiError(error instanceof Error ? error.message : 'The current atlas data could not be re-read.')
    }
  }

  useEffect(() => {
    let active = true
    fetch('/api/trips')
      .then(async (response) => {
        if (!response.ok) throw new Error('The shared atlas could not be loaded.')
        const revision = response.headers.get('ETag')
        if (!revision) throw new Error('The current file revision is unavailable.')
        return { store: await response.json() as TripStore, revision }
      })
      .then(({ store, revision }) => {
        if (!active) return
        applyStore(store, revision)
        setApiStatus('ready')
      })
      .catch((error: unknown) => {
        if (!active) return
        setApiError(error instanceof Error ? error.message : 'The shared atlas could not be loaded.')
        setApiStatus('error')
      })
    return () => { active = false }
  }, [applyStore, isAdmin])

  useEffect(() => {
    const query = draft.city.trim()
    if (!isAdmin || !formOpen || query.length < 2 || (draft.lat !== '' && draft.lng !== '')) return
    const controller = new AbortController()
    const timeout = window.setTimeout(() => {
      fetch(`/api/cities?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error('City suggestions are unavailable.')
          return await response.json() as CitySuggestion[]
        })
        .then((cities) => setCitySuggestionResult({ query, cities }))
        .catch(() => { if (!controller.signal.aborted) setCitySuggestionResult({ query, cities: [] }) })
    }, 180)
    return () => {
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [draft.city, draft.lat, draft.lng, formOpen, isAdmin])

  useEffect(() => {
    if (!isAdmin || apiStatus !== 'ready' || storeConflict) return
    const generation = saveGenerationRef.current
    const store = serializeStore(trips, starredCountries, atlasName)
    const timeout = window.setTimeout(() => {
      saveQueueRef.current = saveQueueRef.current.then(async () => {
        if (generation !== saveGenerationRef.current || storeConflictRef.current) return
        await saveStore(store)
      })
    }, 150)
    return () => window.clearTimeout(timeout)
  }, [apiStatus, atlasName, isAdmin, starredCountries, storeConflict, trips])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const observer = new ResizeObserver(([entry]) => {
      setGlobeSize({ width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) })
    })
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!globeReady) return
    if (selectedTrip) {
      globeRef.current?.pointOfView({ lat: selectedTrip.lat, lng: selectedTrip.lng, altitude: 0.9 }, 900)
      return
    }
    const countryTrips = trips.filter((trip) => trip.country === selectedCountry)
    if (countryTrips.length) {
      const center = countryTrips.reduce((total, trip) => ({ lat: total.lat + trip.lat, lng: total.lng + trip.lng }), { lat: 0, lng: 0 })
      globeRef.current?.pointOfView({ lat: center.lat / countryTrips.length, lng: center.lng / countryTrips.length, altitude: 1.55 }, 900)
    }
  }, [globeReady, selectedCountry, selectedTrip, trips])

  function openNewForm(context: NewEntryContext = {}) {
    dialogOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setEditingTrip(null)
    setDraft({ ...emptyDraft, starred: Boolean(context.isHome), sources: context.source ? [context.source.id] : [] })
    setFormError(null)
    setFormOpen(true)
  }

  function chooseCitySuggestion(suggestion: CitySuggestion) {
    const savedTrip = trips.find((trip) => trip.city === suggestion.name
      && trip.country === suggestion.country && trip.state === suggestion.state)
    setDraft((current) => ({
      ...current,
      city: suggestion.name,
      country: suggestion.country,
      state: suggestion.state,
      lat: String(savedTrip?.lat ?? suggestion.lat),
      lng: String(savedTrip?.lng ?? suggestion.lng),
    }))
    setCitySuggestionResult({ query: '', cities: [] })
  }

  function openEditForm(trip: Trip) {
    dialogOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setEditingTrip(trip)
    setDraft({ city: trip.city, country: trip.country, state: trip.state, lat: String(trip.lat), lng: String(trip.lng), starred: Boolean(trip.starred), sources: trip.sources ?? [] })
    setFormError(null)
    setFormOpen(true)
  }

  function saveTrip(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const latitude = Number(draft.lat)
    const longitude = Number(draft.lng)
    if (!draft.city.trim() || !draft.country.trim() || !draft.lat || !draft.lng
      || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      setFormError('Choose a city from the suggestions.')
      return
    }
    const matchingHome = !editingTrip && draft.starred
      ? trips.find((trip) => trip.starred && trip.city.toLowerCase() === draft.city.trim().toLowerCase() && trip.country === draft.country)
      : undefined
    const starred = Boolean(draft.starred || matchingHome?.starred)
    const source = starred ? undefined : editingTrip?.sources?.[0] ?? draft.sources[0]
    if (!starred && (!source || !homeCities.some((home) => home.id === source))) {
      setFormError('Choose the home this visit belongs to.')
      return
    }
    const nextTrip: Trip = {
      id: editingTrip?.id ?? matchingHome?.id ?? `${draft.city.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${crypto.randomUUID()}`,
      city: draft.city.trim(),
      country: draft.country,
      state: draft.state,
      lat: latitude,
      lng: longitude,
      starred,
      sources: source ? [source] : [],
    }
    setTrips((current) => {
      const updated = editingTrip
        ? current.map((trip) => trip.id === editingTrip.id ? nextTrip : trip)
        : matchingHome
          ? current.map((trip) => trip.id === matchingHome.id ? nextTrip : trip)
          : [nextTrip, ...current]
      return updated
    })
    setSelectedId(nextTrip.id)
    setSelectedCountry(nextTrip.country)
    setExpandedCountry(nextTrip.country)
    const parentHome = nextTrip.starred ? nextTrip.id : nextTrip.sources?.[0]
    if (parentHome) setExpandedAdminHomes((current) => new Set(current).add(parentHome))
    setFormOpen(false)
  }

  function removeTrip(id: string) {
    const removedTrip = trips.find((trip) => trip.id === id)
    if (!removedTrip) return
    const childVisits = removedTrip.starred ? trips.filter((trip) => (trip.sources ?? []).includes(id)) : []
    if (childVisits.length && !window.confirm(`Delete ${removedTrip.city} and its ${childVisits.length} nested visit${childVisits.length === 1 ? '' : 's'}?`)) return
    const removedIds = new Set([id, ...childVisits.map((trip) => trip.id)])
    const remainingTrips = trips.filter((trip) => !removedIds.has(trip.id)).map((trip) => ({ ...trip, sources: (trip.sources ?? []).filter((source) => !removedIds.has(source)) }))
    setTrips(remainingTrips)
    if (selectedId === id) setSelectedId(null)
    setExpandedAdminHomes((current) => {
      const next = new Set(current)
      next.delete(id)
      return next
    })
    if (removedTrip && !remainingTrips.some((trip) => trip.country === removedTrip.country)) {
      setSelectedCountry((current) => current === removedTrip.country ? null : current)
      setStarredCountries((current) => current.filter((country) => country !== removedTrip.country))
    }
  }

  function focusCountry(country: string) {
    if (!countryList.includes(country)) return
    if (selectedCountry === country && !selectedId) {
      setSelectedId(null)
      setSelectedCountry(null)
      setExpandedCountry(null)
      return
    }
    setSelectedId(null)
    setSelectedCountry(country)
    setExpandedCountry(country)
  }

  function focusTrip(trip: Trip) {
    setSelectedId(trip.id)
    setSelectedCountry(trip.country)
    setExpandedCountry(trip.country)
    const parentHome = trip.starred ? trip.id : trip.sources?.[0]
    if (parentHome) setExpandedAdminHomes((current) => new Set(current).add(parentHome))
  }

  function resetGlobeView() {
    setSelectedId(null)
    setSelectedCountry(null)
    setExpandedCountry(null)
    globeRef.current?.pointOfView(initialView, 1000)
  }

  function handleGlobePointerEnter() {
    globePointerInsideRef.current = true
    const controls = globeRef.current?.controls()
    if (controls) controls.autoRotate = false
  }

  function handleGlobePointerLeave() {
    globePointerInsideRef.current = false
    const controls = globeRef.current?.controls()
    if (controls) controls.autoRotate = true
  }

  function prepareGlobe() {
    const controls = globeRef.current?.controls()
    if (controls) {
      controls.autoRotate = !globePointerInsideRef.current
      controls.autoRotateSpeed = 0.22
    }
    globeRef.current?.pointOfView(initialView)
    setGlobeReady(true)
  }

  useEffect(() => {
    const dialog = tripDialogRef.current
    if (!formOpen || !dialog) return
    dialog.showModal()
    cityInputRef.current?.focus()
    return () => {
      if (dialog.open) dialog.close()
      dialogOpenerRef.current?.focus()
      dialogOpenerRef.current = null
    }
  }, [formOpen])

  const entryKind = draft.starred ? 'home' : draft.sources.length ? 'visit' : 'place'
  const entryTitle = editingTrip ? `Edit ${entryKind}` : entryKind === 'home' ? 'Add home' : `Add ${entryKind === 'place' ? 'a place' : 'a visit'}`
  const tripModal = formOpen && isAdmin && <dialog ref={tripDialogRef} className="trip-modal" aria-labelledby="trip-modal-title" onCancel={() => setFormOpen(false)} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setFormOpen(false) } }}>
    <form noValidate onChangeCapture={() => setFormError(null)} onSubmit={saveTrip}>
      <div className="modal-top"><h2 id="trip-modal-title">{entryTitle}</h2><button type="button" className="modal-close" onClick={() => setFormOpen(false)} aria-label="Close form"><X size={19} /></button></div>
      {formError && <p className="form-error" role="alert">{formError}</p>}
      <label className="form-field city-autocomplete">City<input ref={cityInputRef} required autoComplete="off" role="combobox" aria-autocomplete="list" aria-expanded={citySuggestions.length > 0} aria-controls="city-suggestions" value={draft.city} onChange={(event) => setDraft((current) => ({ ...current, city: event.target.value, state: undefined, lat: '', lng: '' }))} placeholder="Search cities worldwide" />{citySuggestions.length > 0 && <div className="city-suggestions" id="city-suggestions" role="listbox">{citySuggestions.map((suggestion) => <button type="button" role="option" aria-selected="false" className="city-suggestion" key={`${suggestion.name}-${suggestion.country}-${suggestion.state ?? ''}-${suggestion.lat}`} onClick={() => chooseCitySuggestion(suggestion)}><span>{formatPlaceLabel({ city: suggestion.name, country: suggestion.country, state: suggestion.state })}</span><small>{suggestion.state ? 'US' : suggestion.country}</small></button>)}</div>}</label>
      <div className="form-field country-readonly"><span>{draft.state ? 'State / country' : 'Country'}</span><output>{draft.country ? [draft.state, draft.country].filter(Boolean).join(', ') : '—'}</output></div>
      <div className="modal-actions"><button type="button" className="cancel-button" onClick={() => setFormOpen(false)}>Cancel</button><button type="submit" className="save-button">{editingTrip ? 'Save changes' : 'Add'} <ArrowUpRight size={16} /></button></div>
    </form>
  </dialog>

  if (isAdmin) {
    const visitRows = (visits: Trip[]) => visits.length ? visits.map((trip) => <tr key={trip.id}>
      <td><button className="ledger-city" onClick={() => focusTrip(trip)}>{formatPlaceLabel(trip)}</button></td>
      <td className="ledger-actions"><button className="ledger-edit-button" onClick={() => openEditForm(trip)} aria-label={`Edit ${trip.city}`} title={`Edit ${trip.city}`}><Pencil size={14} /></button><button className="ledger-delete-button" onClick={() => removeTrip(trip.id)} aria-label={`Delete ${trip.city}`} title={`Delete ${trip.city}`}><Trash2 size={14} /></button></td>
    </tr>) : <tr><td className="ledger-empty" colSpan={2}>No visited places logged yet</td></tr>
    const visitTable = (visits: Trip[], home: Trip) => <div className="ledger-scroll"><table className="admin-table"><thead><tr><th>Visited places</th><th><button className="ledger-add-button" disabled={apiStatus !== 'ready'} aria-label={`Add visit to ${home.city}`} title={`Add visit to ${home.city}`} onClick={() => openNewForm({ source: home })}><Plus size={15} /></button></th></tr></thead><tbody>{visitRows(visits)}</tbody></table></div>

    return <div className="admin-page">
      <header className="admin-header"><h1>Travel log editor</h1><label className="owner-name-field"><span>Name</span><input aria-label="Name" maxLength={80} value={atlasName} disabled={apiStatus !== 'ready'} onChange={(event) => setAtlasName(event.target.value)} placeholder="Your name" /></label><a href="/">Open public view <ArrowUpRight size={15} /></a></header>
      {apiError && <p className="admin-status admin-error" role="alert">{apiError}</p>}
      {storeConflict && <section className="store-conflict" aria-labelledby="store-conflict-title" aria-live="assertive">
        <div><h2 id="store-conflict-title">The saved file changed</h2><p>Discard your local changes and reload, or overwrite the saved file with your current version.</p></div>
        <div className="store-conflict-actions"><button className="warning-button" onClick={() => void rereadCurrentState()}>Discard local changes and reload</button><button className="warning-button" onClick={keepLocalVersion}>Overwrite disk with my version</button></div>
      </section>}
      <main className="admin-content">
        <div className="ledger-top-add"><button className="save-button" aria-label="Add home city" title="Add home city" disabled={apiStatus !== 'ready'} onClick={() => openNewForm({ isHome: true })}><Plus size={15} />Add home city</button></div>
        {apiStatus === 'loading' && <div className="admin-loading" role="status" aria-label="Loading shared data"><LoaderCircle size={22} strokeWidth={1.7} aria-hidden="true" /></div>}
        {apiStatus === 'ready' && <>
        {homeCities.map((home) => {
          const homeVisits = trips.filter((trip) => !trip.starred && (trip.sources ?? []).includes(home.id))
          const homeExpanded = expandedAdminHomes.has(home.id)
          return <section className="admin-home-group" key={home.id}>
            <div className="admin-home-heading">
              <button className="admin-home-toggle" aria-expanded={homeExpanded} onClick={() => setExpandedAdminHomes((current) => { const next = new Set(current); if (next.has(home.id)) next.delete(home.id); else next.add(home.id); return next })}><span>{formatPlaceLabel(home)}</span><ChevronRight className={homeExpanded ? 'admin-chevron-open' : ''} size={14} /></button>
              <div className="ledger-home-actions"><button className="ledger-edit-button" onClick={() => openEditForm(home)} aria-label={`Edit ${home.city}`} title={`Edit ${home.city}`}><Pencil size={14} /></button><button className="ledger-delete-button" onClick={() => removeTrip(home.id)} aria-label={`Delete ${home.city}`} title={`Delete ${home.city}`}><Trash2 size={14} /></button></div>
            </div>
            {homeExpanded && <div className="admin-home-visits">{visitTable(homeVisits, home)}</div>}
          </section>
        })}
        {!homeCities.length && <div className="ledger-empty-state">Your travel log is empty.</div>}
        </>}
      </main>
      {tripModal}
    </div>
  }

  return (
    <div className="app-shell">
      <main className="main-content" id="atlas">
        <div className="atlas-layout">
          <section className="globe-column">
            <div className="map-card">
              <div className="map-topline" role="toolbar" aria-label="Globe controls">
                <button className="map-action" onClick={resetGlobeView} aria-label="Reset globe view" title="Reset globe view"><Compass size={16} /></button>
                <button className="table-toggle" onClick={() => setTableCollapsed((collapsed) => !collapsed)} aria-label={tableCollapsed ? 'Expand country table' : 'Collapse country table'} aria-expanded={!tableCollapsed} aria-controls="country-index" title={tableCollapsed ? 'Expand country table' : 'Collapse country table'}>
                  {tableCollapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
                </button>
              </div>
              <div className="globe-stage" ref={stageRef} onPointerEnter={handleGlobePointerEnter} onPointerLeave={handleGlobePointerLeave}>
                <div className="globe-halo" />
                  <Suspense fallback={<div className="globe-loading" style={{ width: globeSize.width, height: globeSize.height }}><span className="loading-globe"><Globe2 size={28} strokeWidth={1.4} /></span></div>}>
                  <Globe
                    ref={globeRef}
                    width={globeSize.width}
                    height={globeSize.height}
                    backgroundColor="rgba(0,0,0,0)"
                    globeImageUrl={globeTexture}
                    showAtmosphere
                    atmosphereColor="#8fcfc2"
                    atmosphereAltitude={0.14}
                    showGraticules
                    polygonsData={countryHitAreas}
                    polygonCapColor={() => 'rgba(0, 0, 0, 0)'}
                    polygonSideColor={() => 'rgba(0, 0, 0, 0)'}
                    polygonAltitude={0.001}
                    polygonStrokeColor={() => false}
                    polygonLabel={(polygon) => hoveredPinRef.current ? '' : (polygon as CountryShape).properties?.name ?? ''}
                    onPolygonHover={(polygon) => { if (polygon) handleGlobePointerEnter() }}
                    onPolygonClick={(polygon, event) => {
                      if (hoveredPinRef.current || (event.target instanceof Element && event.target.closest('.city-map-marker'))) return
                      const country = (polygon as CountryShape).properties?.name
                      if (country) focusCountry(country)
                    }}
                    htmlElementsData={mapPlaces}
                    htmlLat={(point) => (point as Trip).lat}
                    htmlLng={(point) => (point as Trip).lng}
                    htmlAltitude={0.008}
                    htmlElement={(point) => {
                      const trip = point as Trip
                      const marker = document.createElement('button')
                      marker.type = 'button'
                      marker.className = `city-map-marker${trip.starred ? ' is-starred' : ''}${trip.id === selectedId ? ' is-selected' : ''}`
                      marker.style.pointerEvents = 'auto'
                      const placeLabel = formatPlaceLabel(trip)
                      marker.setAttribute('aria-label', `${placeLabel}${trip.starred ? ', starred' : ''}`)
                      marker.dataset.tooltip = placeLabel
                      marker.addEventListener('pointerenter', () => {
                        hoveredPinRef.current = true
                        handleGlobePointerEnter()
                      })
                      marker.addEventListener('pointerleave', () => { hoveredPinRef.current = false })
                      const pin = document.createElement('span')
                      pin.className = 'city-pin-shape'
                      const center = document.createElement('span')
                      center.className = trip.starred ? 'city-pin-star' : 'city-pin-center'
                      if (trip.starred) center.textContent = '★'
                      pin.append(center)
                      marker.append(pin)
                      marker.addEventListener('click', (event) => {
                        event.stopPropagation()
                        focusTrip(trip)
                      })
                      return marker
                    }}
                    htmlTransitionDuration={350}
                    arcsData={routeArcs}
                    arcStartLat={(arc) => (arc as typeof routeArcs[number]).start.lat}
                    arcStartLng={(arc) => (arc as typeof routeArcs[number]).start.lng}
                    arcEndLat={(arc) => (arc as typeof routeArcs[number]).end.lat}
                    arcEndLng={(arc) => (arc as typeof routeArcs[number]).end.lng}
                    arcColor={() => 'rgba(255, 205, 143, 0.72)'}
                    arcStroke={0.22}
                    arcDashLength={0.32}
                    arcDashGap={0.22}
                    arcDashAnimateTime={3200}
                    arcsTransitionDuration={450}
                    onGlobeReady={prepareGlobe}
                  />
                </Suspense>
              </div>
            </div>
          </section>

          <aside className={`places-panel ${tableCollapsed ? 'table-collapsed' : ''}`} aria-label="Visited places">
            <div className="panel-heading" />
            {apiStatus === 'loading' && !tableCollapsed && <div className="api-loading" role="status" aria-label="Loading shared data"><LoaderCircle size={22} strokeWidth={1.7} aria-hidden="true" /></div>}
            {apiError && <div className="api-message" role="alert">{apiError}</div>}
            {apiStatus === 'ready' && !tableCollapsed &&
            <div className="country-accordion" id="country-index">
              {countryList.map((country, index) => {
                const countryTrips = mapPlaces.filter((trip) => trip.country === country)
                const expanded = expandedCountry === country
                return <section className={`country-entry ${selectedCountry === country ? 'country-selected' : ''}`} key={country}>
                  <div className="country-entry-head"><button className="country-entry-toggle" aria-expanded={expanded} onClick={() => focusCountry(country)}>
                    <span className="country-entry-number">{String(index + 1).padStart(2, '0')}</span><span className="country-entry-name">{country}</span><span className="country-entry-count">{String(countryTrips.length).padStart(2, '0')}</span><ChevronRight className={expanded ? 'country-chevron-open' : ''} size={15} />
                  </button></div>
                  {expanded && <div className="country-city-list">{countryTrips.map((trip) => <article className={`country-city-row ${selectedId === trip.id ? 'city-selected' : ''}`} key={trip.id}>
                    <button className="country-city-button" onClick={() => focusTrip(trip)}><MapPin size={13} /><span>{trip.state ? `${trip.city}, ${trip.state}` : trip.city}</span></button>
                  </article>)}</div>}
                </section>
              })}
              {!countryList.length && <div className="empty-state"><span>No places logged yet</span></div>}
            </div>
            }
            {!tableCollapsed && <footer className={`atlas-footer ${apiStatus === 'loading' ? 'is-loading' : ''}`} aria-hidden={apiStatus === 'loading'}><span>{String(countryList.length).padStart(2, '0')} countries</span><span>{String(mapPlaces.length).padStart(2, '0')} cities</span></footer>}
          </aside>
        </div>
      </main>

    </div>
  )
}

export default App
