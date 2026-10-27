# homeass_dash

A pixel-art "HOMELAB" dashboard for Home Assistant: climate (temp + humidity), CO₂ with a 12-hour history, and light toggles.

A tiny zero-dependency Node server serves the page and proxies a small allowlist of Home Assistant REST calls. That keeps your access token out of the browser and avoids CORS setup.

## Setup

Requires Node 21.7+.

1. In Home Assistant, open your profile → **Security** → **Long-lived access tokens** and create a token.
2. `cp .env.example .env` and set `HA_URL` and `HA_TOKEN`.
3. `npm start`, then open http://127.0.0.1:8080.

To view it from a tablet or phone on your network, set `HOST=0.0.0.0` in `.env`. Anyone who can reach the port can toggle your lights.

## Choosing entities

With no `config.json`, everything is auto-discovered:

- **Climate**: every `sensor` with `device_class: temperature`, paired with the matching `…humidity` sensor if one exists
- **CO₂**: every entity with `device_class: carbon_dioxide`
- **Lights**: every `light.*` entity, labelled with its HA area

To pick entities and names yourself, `cp config.example.json config.json` and edit it. Any section set to an array is used as-is; leave a section out, or set it to `"auto"`, to keep auto-discovery for it. Lights can also be `switch.*` entities.

| Key | Default | |
|---|---|---|
| `title` | `HOMELAB` | Header text |
| `refreshSeconds` | `5` | State polling interval |
| `historyRefreshMinutes` | `5` | CO₂ history refresh |
| `scanlines` | `true` | CRT scanline overlay |
| `theme` | `"auto"` | Seasonal theme: `auto` picks by date (October → `halloween`, November through Thanksgiving → `fall`, the day after Thanksgiving through December → `christmas`, otherwise none). Set a name to force one, or `"none"` to turn themes off. Add `?theme=christmas` to the URL to preview one |
| `effects` | `true` | Theme overlays: cobwebs for `halloween`, falling leaves for `fall`, falling snow for `christmas`. Set `false` to keep only the colors |
| `buttons` | `[]` | Tiles at the start of the lights grid that run an `automation.*` (trigger), `script.*` or `scene.*`: `{ "entity", "name", "room" }` |
| `exclude` | `[]` | Entity IDs to skip during auto-discovery; `*` is a wildcard (e.g. `sensor.outdoor_weather_*`) |

## Deploying to a Podman host

`./deploy.sh user@host http://<HA IP>:8123` copies the app over and builds the image. It then installs a rootless [Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html) service, so the dashboard starts at boot and shows up on Cockpit's **Podman containers** page.

- The HA URL argument is only used the first time, to create the server's `.env` from your local one. Use an IP, because containers often can't resolve `homeassistant.local`.
- Re-run `./deploy.sh user@host` to ship updates. It also re-copies `config.json`.
- Logs are in Cockpit, or run `journalctl --user -u homeass-dash -f` on the host.

Docker users can run `docker compose up -d --build` instead.
