# Overview and architecture

[← Contents](index.md) · [Русский](../ru/overview.md)

PackageFlow installs PS4 PKG/FPKG files over your local network and manages the console from WEB. Files stay in their original library folder. The PS4 downloads them directly over HTTP; the application does not create another library copy on the computer.

## Available features

- Group games, patches, backports and DLC by title ID; display covers and metadata.
- Install sequentially through PackageFlowService, or use PyLoader as a fallback.
- Inspect installed games and components, remove them with confirmation, launch/stop games and reinstall from the library.
- Browse console files, upload/download with resume, edit small UTF-8 text files, copy/move, use trash and permanently delete.
- Back up and restore save slots with a rollback step.
- Manage qBittorrent downloads and auto-install completed PKGs; search a configured Torznab source.
- Use the native Full HD PS4 application with a shared installation queue and persistent RU/EN selection.

## Data flow

WEB runs on the computer at port 3000. PackageFlowService runs on PS4 at port 12801 and receives authenticated installation and management requests. The console's system installer downloads PKGs from WEB and reports installation stages through the service.

PyLoader at port 9090 receives a payload and connects back to WEB. This method reports transfer progress, not the final installation result. Check PS4 Downloads for the outcome.

The native app reads catalog metadata and covers from WEB. Selecting Install requests the same queue used by the browser. It does not download torrents itself.

## Current limits

PS4 only; HEN must already be active. Native catalog snapshots currently contain up to 24 games and 128 packages per game. Favorites in the PS4 app are not yet persistent. The native On console screen is a placeholder; management is available in WEB. External JSON catalogs, the native torrent client, multiple independent PS4 queues and Internet tunneling are planned. Remote screen work is paused. Use packages and sources you are entitled to use.
