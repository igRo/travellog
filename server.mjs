import express from 'express'
import cityCatalog from 'cities.json' with { type: 'json' }
import countryCodeLookup from 'country-code-lookup'
import { createHash } from 'node:crypto'
import { access, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { feature } from 'topojson-client'
import atlas from 'world-atlas/countries-110m.json' with { type: 'json' }

const root = dirname(fileURLToPath(import.meta.url))
const dataFile = resolve(process.env.ATLAS_DATA_FILE ?? resolve(root, 'data/trips.json'))
const seedFile = resolve(root, 'data/trips.example.json')
const port = Number(process.env.PORT ?? 3001)
const app = express()
const atlasCountries = feature(atlas, atlas.objects.countries).features
const countryNamesByCode = new Map(atlasCountries.flatMap((country) => {
  const match = countryCodeLookup.byIso(Number(country.id))
  const name = country.properties?.name
  return match && name ? [[match.iso2, name]] : []
}))
const cityIndex = new Map()
const usStatesByPlace = new Map()

for (const city of cityCatalog) {
  const name = city.name?.trim()
  const country = countryNamesByCode.get(city.country)
  if (!name || !country || !Number.isFinite(Number(city.lat)) || !Number.isFinite(Number(city.lng))) continue
  const state = city.country === 'US' ? city.admin1 : undefined
  const entry = { name, country, ...(state ? { state } : {}), lat: Number(city.lat), lng: Number(city.lng) }
  if (state) usStatesByPlace.set(`${name.toLowerCase()}|${entry.lat}|${entry.lng}`, state)
  const prefix = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().slice(0, 2)
  const entries = cityIndex.get(prefix) ?? []
  entries.push(entry)
  cityIndex.set(prefix, entries)
}

app.use(express.json({ limit: '256kb' }))

await mkdir(dirname(dataFile), { recursive: true })
try {
  await access(dataFile)
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
  if (dataFile !== seedFile) await copyFile(seedFile, dataFile)
}

function normalizeStore(saved) {
  const normalizePlace = (place) => {
    const normalized = { ...place }
    delete normalized.year
    if (!normalized.state && typeof normalized.city === 'string') {
      const key = `${normalized.city.toLowerCase()}|${Number(normalized.lat)}|${Number(normalized.lng)}`
      const state = usStatesByPlace.get(key)
      if (state) normalized.state = state
    }
    return normalized
  }

  if (Array.isArray(saved?.homes)) {
    return {
      name: typeof saved.name === 'string' ? saved.name : '',
      homes: saved.homes.map((home) => ({
        ...normalizePlace(home),
        visits: (Array.isArray(home.visits) ? home.visits : []).map(normalizePlace),
      })),
      starredCountries: Array.isArray(saved.starredCountries) ? saved.starredCountries : [],
    }
  }

  const trips = Array.isArray(saved) ? saved : Array.isArray(saved?.trips) ? saved.trips : []
  const homes = trips.filter((trip) => trip.starred).map((trip) => {
    const place = normalizePlace(trip)
    delete place.starred
    delete place.sources
    return { ...place, visits: [] }
  })
  const homesById = new Map(homes.map((home) => [home.id, home]))

  for (const trip of trips.filter((item) => !item.starred)) {
    const place = normalizePlace(trip)
    const sources = Array.isArray(place.sources) ? place.sources : []
    delete place.starred
    delete place.sources
    const parents = [...new Set(sources)]
      .filter((source) => homesById.has(source))
    if (!parents.length) throw new Error(`Legacy place ${trip.city} has no home assignment.`)
    for (const parent of parents) {
      const home = homesById.get(parent)
      home.visits.push({ ...place, id: parents.length > 1 ? `${trip.id}-${parent}` : trip.id })
    }
  }

  return {
    name: typeof saved.name === 'string' ? saved.name : '',
    homes,
    starredCountries: Array.isArray(saved.starredCountries) ? saved.starredCountries : [],
  }
}

function revisionFor(contents) {
  return `"${createHash('sha256').update(contents).digest('hex')}"`
}

async function readStore() {
  const contents = await readFile(dataFile, 'utf8')
  return { store: normalizeStore(JSON.parse(contents)), revision: revisionFor(contents) }
}

function validateStore(body) {
  if (!body || !Array.isArray(body.homes) || !Array.isArray(body.starredCountries)) {
    throw new Error('Expected homes and starredCountries arrays.')
  }
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 80)) {
    throw new Error('Name must be a string of 80 characters or fewer.')
  }

  const ids = new Set()
  const validatePlace = (place) => {
    const lat = place?.lat
    const lng = place?.lng
    const state = typeof place?.state === 'string' ? place.state.trim() : ''
    if (!place || typeof place.id !== 'string' || !place.id || ids.has(place.id) || typeof place.city !== 'string' || !place.city.trim()
      || typeof place.country !== 'string' || !place.country.trim()
      || (place.state !== undefined && (typeof place.state !== 'string' || place.state.length > 80))
      || typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90
      || typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      throw new Error('Each place needs a valid id, city, country, and coordinates.')
    }
    ids.add(place.id)
    return {
      id: place.id,
      city: place.city.trim(),
      country: place.country.trim(),
      ...(state ? { state } : {}),
      lat,
      lng,
    }
  }

  const homes = body.homes.map((home) => {
    if (!Array.isArray(home?.visits)) throw new Error('Each home must contain a visits array.')
    return { ...validatePlace(home), visits: home.visits.map(validatePlace) }
  })
  const visitedCountries = new Set(homes.flatMap((home) => [home.country, ...home.visits.map((visit) => visit.country)]))
  const starredCountries = [...new Set(body.starredCountries)]
    .filter((country) => typeof country === 'string' && visitedCountries.has(country))

  return { name: typeof body.name === 'string' ? body.name.trim() : '', homes, starredCountries }
}

let writeQueue = Promise.resolve()

function writeStore(store, expectedRevision) {
  const write = writeQueue.then(async () => {
    const currentContents = await readFile(dataFile, 'utf8')
    const currentRevision = revisionFor(currentContents)
    if (currentRevision !== expectedRevision) {
      return { conflict: true, store: normalizeStore(JSON.parse(currentContents)), revision: currentRevision }
    }

    const contents = `${JSON.stringify(store, null, 2)}\n`
    const temporaryFile = `${dataFile}.${process.pid}.tmp`
    await writeFile(temporaryFile, contents)
    await rename(temporaryFile, dataFile)
    return { conflict: false, revision: revisionFor(contents) }
  })
  writeQueue = write.catch(() => {})
  return write
}

app.get('/api/trips', async (_request, response) => {
  try {
    response.set('Cache-Control', 'no-store')
    const { store, revision } = await readStore()
    response.set('ETag', revision)
    response.json(store)
  } catch (error) {
    console.error('Could not read atlas data:', error)
    response.status(500).json({ error: 'Atlas data is unavailable.' })
  }
})

app.get('/api/cities', (request, response) => {
  const query = String(request.query.q ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
  if (query.length < 2) return response.json([])

  const matches = (cityIndex.get(query.slice(0, 2)) ?? [])
    .filter((city) => city.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().startsWith(query))
    .sort((left, right) => left.name.localeCompare(right.name)
      || left.country.localeCompare(right.country)
      || (left.state ?? '').localeCompare(right.state ?? ''))
    .slice(0, 12)

  response.set('Cache-Control', 'public, max-age=3600')
  response.json(matches)
})

app.put('/api/trips', async (request, response) => {
  try {
    const expectedRevision = request.get('If-Match')
    if (!expectedRevision) return response.status(428).json({ error: 'A file revision is required to save atlas data.' })
    const store = validateStore(request.body)
    const result = await writeStore(store, expectedRevision)
    response.set('ETag', result.revision)
    if (result.conflict) return response.status(409).json({ error: 'Atlas data changed since it was loaded.', store: result.store })
    return response.json(store)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not save atlas data.'
    response.status(400).json({ error: message })
  }
})

const dist = resolve(root, 'dist')
app.use(express.static(dist))
app.get('*path', (request, response, next) => {
  if (request.path === '/api' || request.path.startsWith('/api/')) return next()
  response.sendFile(resolve(dist, 'index.html'), (error) => {
    if (error) next(error)
  })
})

app.listen(port, '127.0.0.1', () => {
  console.log(`Travel log API listening on http://127.0.0.1:${port}`)
})