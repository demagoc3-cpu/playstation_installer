# Library and installation

[← Contents](index.md) · [Русский](../ru/library.md)

Open **Settings** in WEB to select the PS4 IP, pair the service and choose an installation method. PackageFlowService is the default; PyLoader is a fallback. This preference also applies to automatic torrent installation. A running queue keeps the transport it was created with.

## Add files

Choose folder opens a picker on the **server's computer**, not a remote browser device. **Settings → Scan PC path** scans an existing server folder directly. Docker paths must be container paths such as `/games`. Scanning reads PKG/FPKG metadata, groups by CUSA and caches covers under `.data`; source files are not copied or modified.

## Pages and library search

WEB requests only the current page: **25 game cards by default**, or **50 / 100**. The browser remembers the page size. Navigation above the list supports first, last and numbered pages. Only the list scrolls inside the library card; search, installation buttons and paging controls stay visible. Connection settings are on a separate page and compact rows leave more room for packages.

Library search checks the entire index by title, CUSA, Content ID, file name, package type and version before paginating the results. When any package matches, the result contains its **complete CUSA branch**, including differently named patches and DLC. Library statistics cover the full collection.

Packages remain grouped by CUSA; each game branch stays on one page. **Per page** selects only the visible packages in a branch. Selection survives page changes and searches; **Clear selection** clears it. **Install all / All DLC** use the complete library, and a branch's **DLC** action includes add-ons on other pages.

![Search and pagination in a 2800-package test library](../screenshots/library-pagination-scroll.png)

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

## Library in the PS4 service

Service **2.01** requests **10/20/30 game groups** at a time; **R2** cycles 10/20/30 cards and table view. The chosen view persists across restarts and updates. Moving below the last row loads
the next batch; moving above the first row loads the previous one. Other games
and their covers stay out of console memory. The counter and scrollbar reflect
the entire filtered library. Triangle search runs on WEB across all titles,
CUSA, content IDs and filenames. Favorites persist across restarts and updates; bulk installation includes their packages from every page. Update WEB and install PackageFlowService **2.01**.


## WEB tasks

**Tasks** shows the shared WEB/PS4 installation queue and qBittorrent downloads. Active jobs stay pinned above the list and the current installation is also shown below the header logo. Checkboxes show or hide all, active, queued, completed and failed categories; pinned active jobs remain visible.

Uncheck a pending package or use **Remove from queue** without affecting the remaining queue, cancel a single active package, or cancel the whole queue. The service confirms cancellation through PS4. PyLoader interrupts delivery; check Notifications → Downloads on the console if needed. qBittorrent supports stopping, resuming and removing a task without deleting downloaded files.

**Tree** groups tasks by game, with patches, backports and DLC as children. **Table** is a compact list of states, progress and actions. The view preference is remembered. Reinstallation progress is displayed in Tasks and the header, leaving the library unobstructed.

The previous ten installation queues are retained. Table pages contain 50 rows; tree pages contain up to 50 complete game branches without splitting them. The library's **Transferred to PS4** counter covers checked packages only and opens their exact file names. Manual installed markers and cancelled packages do not count as transfers.

## Consistent display

Library, presets and tasks share the same game tree, PKG metadata, notification fonts and status colours. **Clear** hides completed and failed entries while keeping active and waiting jobs. On PS4 use **L1** to clear and **R1** to change history pages. See [presets and controls](presets.md).
