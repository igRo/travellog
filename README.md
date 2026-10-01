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

## VPS deployment with GitHub Actions

The `Deploy` workflow builds and packages the app on GitHub, then uploads a release over SSH. The VPS only needs to run the production Node service; it does not compile the frontend. Push to `main` to deploy, or run the workflow manually on `main`.

Prepare an Ubuntu VPS with Node.js 22, Caddy, `curl`, and `tar`. Point your domain at the VPS and allow inbound ports 80 and 443 for Caddy's automatic HTTPS. Create a service account and a separate SSH deployment account whose primary group is `travellog`:

```sh
sudo groupadd --system travellog
sudo useradd --system --gid travellog --home-dir /var/lib/travellog --create-home --shell /usr/sbin/nologin travellog
sudo useradd --create-home --gid travellog --shell /bin/bash deploy
sudo install -d -o deploy -g travellog -m 0750 /opt/travellog
sudo install -d -o deploy -g travellog -m 0750 /opt/travellog/releases
sudo install -d -o travellog -g travellog -m 0750 /var/lib/travellog
```

Install an SSH public key for `deploy`. Allow that account to restart only this service by adding the following line with `sudo visudo -f /etc/sudoers.d/travellog-deploy`:

```text
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart travellog
```

Create `/etc/systemd/system/travellog.service`:

```ini
[Unit]
Description=Travel log
After=network.target

[Service]
Type=simple
User=travellog
Group=travellog
WorkingDirectory=/opt/travellog/current
Environment=NODE_ENV=production
Environment=PORT=3001
Environment=ATLAS_DATA_FILE=/var/lib/travellog/trips.json
ExecStart=/usr/bin/node /opt/travellog/current/server.mjs
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/travellog

[Install]
WantedBy=multi-user.target
```

Generate a password hash with Caddy's `caddy hash-password` command, then configure your Caddy site. Replace the example domain and hash; use the same hash in both auth blocks:

```caddyfile
travel.example.com {
	@admin path /admin /admin/*
	@tripWrite {
		path /api/trips
		method PUT
	}

	basicauth @admin {
		admin <bcrypt-hash-from-caddy>
	}
	basicauth @tripWrite {
		admin <bcrypt-hash-from-caddy>
	}

	reverse_proxy 127.0.0.1:3001
}
```

Caddy obtains and renews HTTPS certificates automatically. Keep port 3001 closed to the internet; the Node service should only be reachable through Caddy.

Add these GitHub Actions repository secrets:

- `VPS_HOST`: VPS IP address or hostname.
- `VPS_USER`: `deploy`.
- `VPS_SSH_KEY`: private key matching the public key installed for `deploy`.
- `VPS_KNOWN_HOSTS`: verified SSH host-key line(s) for the VPS.

After adding the service unit, run `sudo systemctl daemon-reload && sudo systemctl enable travellog`. The first successful workflow deployment creates the app release and starts the service. Back up `/var/lib/travellog/trips.json` separately; it is intentionally not included in releases.

City autocomplete uses the GeoNames Gazetteer via `cities.json`, licensed under CC BY 4.0.

## Checks

```sh
npm run check
```

This runs the linter and production build, including the TypeScript check.