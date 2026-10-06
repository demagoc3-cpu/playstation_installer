# Updates, persistent data and settings

[← Contents](index.md) · [Русский](../ru/updates-data.md)

## Preserve state

WEB uses JSON files under `.data` (ignored by Git), with no separate database. Important files include:

| Path | Purpose |
|---|---|
| `package-library.json` | Library and transfer state |
| `installation-queue.json` | Shared installation queue |
| `ps4.json` | Last console IP |
| `ps4-service-keys.json` | Pairing keys by IP |
| `ps4-remove-operations.json`, `console-*.json` | Console/maintenance operations |
| `console-files/` | File/trash operation records |
| `service-updates/` | Validated update PKGs |
| `qbittorrent.json` | qBittorrent settings; password stored in plain text |
| `search-providers.json` | Torznab settings, including API keys |
| `torrent-library.json` | Imported/auto-installed torrents |
| `package-cache/` | Scan cache and extracted covers |

Stop WEB before copying its state. Keep source PKGs too. A complete reset by removing `.data` requires pairing and configuration again. Treat this directory as private and do not share credentials.

## Update WEB

Keep `.data`, stop the server, obtain the desired release, install dependencies and build with `pnpm install && pnpm build`. Restart from the repository root. For Docker, recreate with the same persistent volume; see [Docker updates](docker.md#update).

## Update PS4 app

### On the PS4 (from version 1.82)

1. Open **Settings → Update** and press Cross. The service checks the latest published stable GitHub release.
2. If a newer version is available, press Cross again and confirm with **Options**. Circle cancels the confirmation.
3. The PS4 downloads the PKG itself; Settings displays download progress. After verification, the background service installs it: the interface closes automatically and the new version starts itself.

The PS4 needs internet access; WEB and pairing are not required. Finish installations and file transfers and keep the PS4 powered on. Versions are compared using the service PKG, not the WEB release tag. Older and identical versions are skipped.

The updater accepts `PackageFlowService-<version>.pkg` from `demagoc3-cpu/playstation_installer` releases, up to 25 MiB, with a SHA-256 digest in GitHub metadata. It verifies HTTPS, size, checksum, application identifiers and the version inside the PKG. After an interrupted download, check again. Do not resend installation if its outcome is uncertain; inspect it in WEB instead.

### Through WEB

**System information → PackageFlowService update** still supports GitHub checks, local PKG upload, installation and restart. Close the PS4 interface before replacing the PKG. The paired service handles normal updates; **WEB → PyLoader** is a fallback when the service is unavailable. After installation, launch the app and verify its version.

Install PKG **1.82** through WEB or manually to get the independent updater for the first time. Installing a PKG does not activate HEN.

## Wallet settings

`NUXT_PUBLIC_DONATION_BTC` and `NUXT_PUBLIC_DONATION_USDT_TRC20` set public donation addresses. Empty values hide the corresponding wallet. WEB supplies addresses and QR matrices to the PS4 app, so updating them does not require a new PKG.
