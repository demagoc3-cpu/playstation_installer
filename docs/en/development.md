# API and development

[← Contents](index.md) · [Русский](../ru/development.md)

WEB uses Nuxt/Vue, Nitro, Node.js and TypeScript. It builds independently of the private PackageFlowService source. Native UI/model/renderer and the daemon live in the separate service project; old prototypes are under its experiments directory.

## Main API groups

| Purpose | Routes |
|---|---|
| Library | `/api/packages`, scan, per-package delivery/reset/installed state, branch removal |
| System installer manifest | `/json/:id.json`; PKG streaming `/api/packages/:id` supports Range |
| Queue/status | `/api/ps4/installation`, cancel, status/settings/launch |
| Service pairing | `/api/ps4/service-status`, `POST /api/ps4/service-key` with `{ ip, code }` |
| Console apps | `/api/ps4/apps`, details, icon, runtime, operation, remove/control; `/api/ps4/reinstall` |
| Files | `/api/ps4/files/*`: listing/stat, downloads, resumable uploads, operations and local installation |
| Saves | `/api/ps4/saves/*`: users/titles/slots, export/archive, restore/finalize/rollback |
| Updates | `/api/ps4/service-update/*`: check, package/github, install, restart/recover; `/service-update/manifest/:id.json` and `/service-update/package/:id.pkg` |
| Torrents/search | `/api/torrents/*`, settings/files, `/api/search` and search/settings |
| Logs | `GET /api/logs?after=`, `DELETE /api/logs` |

See each route's source for method, validation and request shape; a group entry is not a promise that every verb is accepted.

## Native app protocol

`GET /api/catalog/v1?lang=ru|en` returns WEB library metadata, bounded package lists and cover URLs. It does not expose file paths or service keys. External magnets are currently null.

`POST /api/catalog/v1/command` uses a persisted, unique request ID. Read its result with GET instead of resubmitting after a lost reply. Actions include all/selected/patches/dlc, reinstall-preview/reinstall, cancel-current/cancel-all/cancel-game. Cancellation binds to a queue ID; current cancellation also binds to the package ID. Cancel game preserves other groups and marks only its unfinished packages for cancellation.

`GET /api/catalog/v1/activity?ip=...&source=install|web|local` exposes the shared queue or WEB torrents; local PS4 torrents are explicitly not yet available. This route can advance an existing maintenance flow, so it is not a passive version check. `GET /api/catalog/v1/support` returns public wallet settings and QR matrices.

The PS4 frontend uses loopback-only service routes for pairing/revocation and base-game presence. It never stores a bearer token. Revocation is persistent, rejects unfinished operations and requires a fresh key during re-pairing. Local endpoints are not exposed to remote LAN clients. These protections do not turn the local WEB into an authenticated Internet service.

## Source layout

`app/`: browser UI/components/locales. `server/api/`: validated handlers; `server/utils/`: PKG parsing, queues, service client, qBittorrent and Torznab; `server/routes/`: manifests/update streaming; `shared/types/`: contracts; `public/`: PyLoader payload; `docs/ru` and `docs/en`: user guides.

To run file integration checks with a private service checkout:

```sh
PACKAGEFLOW_SERVICE_SOURCE=/path/to/PackageFlowService node server/tests/console-files.test.mjs
```

Without that variable, tests look for the neighboring service repository. Explicitly invalid paths fail; an unavailable default repository skips that integration check. Native build/CLion instructions are maintained in the private project's README.
