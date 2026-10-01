# Travel log

A shared travel atlas with a public read-only view and an admin editor.

## Development

```sh
npm ci
npm run dev
```

Vite runs the UI and proxies `/api` to the JSON service on port 3001. The service stores places and country highlights in `data/trips.json`.

The personal data file is excluded from Git. Fresh checkouts initialize it from the empty `data/trips.example.json` template. Keep personal travel data out of public commits and back it up separately. The public `GET /api/trips` endpoint and visitor map expose the saved atlas, so only use data you intend to share on a deployed instance.

## Production

```sh
npm run build
npm start
```

The service serves `dist` and the API on `PORT` (default 3001). Set `ATLAS_DATA_FILE` to a persistent writable JSON file outside the release directory when deploying, for example `/var/lib/elsewhere/trips.json`. On first start, that file is initialized from the empty `data/trips.example.json` template.

Admin reads include a revision for the saved file. Writes include that revision, so a change made since loading is detected instead of silently overwritten. The editor lets you keep local edits, use the saved version, or re-read the current state.

Configure the reverse proxy to:

- Require HTTP Basic Auth for `/admin` and `/admin/`.
- Allow public `GET /api/trips` for the visitor map.
- Require the same Basic Auth for `PUT /api/trips`.
- Proxy the app and API to the local service on port 3001.

The app intentionally does not implement its own login. The reverse proxy is the security boundary; do not expose the service publicly without protecting the admin route and API writes.

City autocomplete uses the GeoNames Gazetteer via `cities.json`, licensed under CC BY 4.0.

## Checks

```sh
npm run check
```

This runs the linter and production build, including the TypeScript check.