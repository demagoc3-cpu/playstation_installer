# PS4 app and WEB pairing

[← Contents](index.md) · [Русский](../ru/ps4-app.md)

## Pairing check in app 1.72

At startup the app checks whether the console accepts this WEB server's saved key. Until confirmed, only **Settings**, **Connections** and **Support** are available. The header distinguishes checking, not paired, WEB unavailable and paired. Other sections become available after successful pairing; losing connectivity returns the app to Connections. The new [Files](files.md) section shares WEB's existing operations.

## Install and pair

1. Enable HEN and install the PackageFlow PKG from Releases. WEB can send it through PyLoader as a fallback.
2. Launch PackageFlow. One PKG contains the graphical app and its background service.
3. Select the PS4 IP in WEB. Open **Connections** on PS4, obtain the code and enter it using **Pair again** in WEB Settings.
4. The code expires after five minutes and is single-use. A saved key authenticates subsequent WEB commands; the frontend never receives that key.

Close only the graphical app using Circle to leave a game card, then Options → Cross. The daemon continues running. After a PS4 reboot, enable HEN and launch PackageFlow again.

## Menu and controls

Full HD rendering is 1920×1080 with 10/20/30 catalog cards selected with R2. Covers and metadata come from WEB; keep it reachable.

| Screen | Controls / purpose |
|---|---|
| Catalog | D-pad / left stick to navigate, Cross to open, Square for favorites |
| Search | Triangle to search by name or CUSA; PS4 system keyboard, with fallback input if initialization fails |
| Favorites | Marked games persist across restarts and updates; the top button installs all favorites |
| Tasks | Filters and compact rows; L1 clears finished/failed entries, R1 changes history pages, Cross removes a waiting package; current/all cancellation remains available |
| Presets | Shared WEB/PS4 collections; Cross opens, the top button installs a preset, Options confirms |
| Downloads | Separate WEB qBittorrent and future local PS4 tabs; native torrents are not connected yet |
| On console | Native controls are planned; use WEB's On console screen now |
| Settings | Square toggles RU/EN and persists it; Cross refreshes catalog |
| Connections | Pairing code and pairing revocation |
| Support | Public BTC and USDT/TRC20 wallets; only the selected QR can be shown |

The raised header cards show PS4 IP, firmware, free internal disk space and language. The PKG version is beside the logo.

## Game card

Cover on the left, description and packages on the right. L1/R1 page through packages; Triangle displays the original filename. Cross toggles a package or activates a focused button. Options installs the selected packages.

Install all, Selected, Patches and DLC use the shared WEB queue. Reinstall all shows the actual removal contents first: Options confirms and Circle cancels. Removal must succeed before the complete game → patches/backports → DLC sequence starts.

Version 1.68 adds a live stage/progress bar in the card and Cancel package / Cancel game buttons. Cancel game affects only this game's unfinished packages, preserving other games. Cancel package works only when this game's package is current. A fully transferred file is not an installation confirmation. When WEB is unavailable the last received snapshot is identified as stale.

The header's installed status checks the **base game** directly on PS4. It does not assert that every DLC/patch is present.

## Revoke WEB pairing

Connections → Right → Revoke pairing → Options. This revokes the **shared key of all paired WEB clients**. Synchronization stops and the old key remains invalid after restart. Obtain a new code and use Pair again in WEB to create a fresh key.

Finish/cancel installations and removals, and finish file uploads, including paused uploads, before disconnecting. The daemon rejects revocation while these operations are unfinished. It does not power off PS4 or stop the service.

## Configure the catalog server

The app uses `/data/PackageFlowUI/server-url.txt` when present, otherwise the server address bundled in the PKG. Write a full LAN address such as `http://192.168.1.10:3000` and reopen the app. `127.0.0.1` on PS4 points to PS4 itself. Editing this setting through the native menu is not yet available. Language is stored separately in `/data/PackageFlowUI/language.txt`.

## Verification status

The user confirmed the PS4 system keyboard, pairing revocation and renewed pairing in 1.67. Version 1.68 changes system keyboard confirmation to Cross and requires a console check after installation. Card progress and cancellation pass automated checks; a complete install/cancel scenario on PS4 is still being verified.

New **1.95** features pass automated checks and packaging; a real-console check is still required. [Presets, favorites and controls](presets.md).
