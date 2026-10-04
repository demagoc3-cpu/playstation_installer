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

Use WEB → System information for service release checks and installation. Close the PS4 graphical app before replacing its PKG. The paired service handles normal updates; WEB → PyLoader is a fallback when unavailable. Follow the update task and launch the app after installation to check the service version. Do not resend a mutating request just because a reply was lost.

Native 1.68's Cancel game control needs the updated WEB command handler; update both parts. PKG installation does not activate HEN automatically.

## Wallet settings

`NUXT_PUBLIC_DONATION_BTC` and `NUXT_PUBLIC_DONATION_USDT_TRC20` set public donation addresses. Empty values hide the corresponding wallet. WEB supplies addresses and QR matrices to the PS4 app, so updating them does not require a new PKG.
