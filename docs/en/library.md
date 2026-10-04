# Library and installation

[← Contents](index.md) · [Русский](../ru/library.md)

In WEB, select the PS4 IP and an installation method. PackageFlowService is the default; PyLoader is a fallback. This preference also applies to automatic torrent installation. A running queue keeps the transport it was created with.

## Add files

Choose folder opens a picker on the **server's computer**, not a remote browser device. Enter path scans an existing server folder directly. Docker paths must be container paths such as `/games`. Scanning reads PKG/FPKG metadata, groups by CUSA and caches covers under `.data`; source files are not copied or modified.

## Install

- Install on a package row: one package.
- Install selected: checked packages.
- DLC / All DLC: add-ons only, for a game or library.
- Install all: sequential library installation.
- Cancel installation: stop the queue; accepted PS4 jobs need console confirmation.
- Reset: return a package to a ready-to-send state.

PackageFlowService confirms installation through PS4 state. PyLoader reports file transfer only. The service route checks firmware requirements and available space before dispatch. Incompatible or unreadable game/patch requirements are skipped; the next packages continue. DLC compatibility is determined by PS4. An automatic compatibility check is not proof that a game launches successfully.

An installed package may be marked manually in the WEB library. This is a saved library marker; the native card's base-game status is checked on the console separately.

## Library maintenance

Mark installed, remove an item with ×, reindex a game after replacing files, or remove its branch from the list. Removing a library entry does not delete its source PKG. Reinstallation is a separate confirmed operation; see [console management](console.md).

If PS4 retains a failed/stopped download, inspect Notifications → Downloads before retrying. Lost replies are not permission to submit another installation automatically.

## Standalone PS4 applications

PackageFlowService 1.69 supports `PS4GDE` mini apps such as GameBaTo through the shared library queue. They are standalone applications and do not require a base game. Existing applications are not silently overwritten. An explicitly zero `SYSTEM_VER` is read as `0.00`; missing or unreadable requirements remain unknown, and a newer SDK still blocks installation.
