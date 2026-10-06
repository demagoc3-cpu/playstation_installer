# PackageFlow for Windows — first test version

## Status and setup activity

Every page displays separate WEB, PS4 pairing, qBittorrent, Prowlarr and FlareSolverr status cards. API checks run when the wizard opens, after actions and every 15 seconds. Not configured, Not checked and Unavailable are distinct: a stopped WEB cannot confirm qBittorrent connectivity. FlareSolverr API readiness does not confirm that a tracker challenge has passed.

The bottom panel shows the current stage, download percentage and recent timestamped events. Component extraction runs off the UI thread. Automatic startup reports each component and when WEB becomes ready.

Windows uses visible Chromium for RuTracker compatibility. Source descriptions try HTTP first; background search never opens the browser. Opening a card can request verification through FlareSolverr. An expired browser session is recreated once, and the ordinary Cloudflare script on an accessible page is not treated as a challenge failure.

## Install and start

1. Run `PackageFlowSetup-0.1.7-x64.exe` on Windows 10/11 x64. Node.js and .NET are bundled.
2. Choose Windows mode or Docker Compose in the setup wizard.
3. Select your PKG folder and the computer's LAN IPv4. Default ports: WEB 3000, PS4 callback 3001.
4. Save and start. Use **Allow PS4 access** to create private-network, local-subnet firewall rules; this step requests administrator permission.
5. Enter the console IP and the pairing code from PackageFlow → Connections on PS4. Pairing can be done later.

Persistent data lives in `%LOCALAPPDATA%\PackageFlow\data`. Closing the window leaves the launcher in the tray and the server running. Explicit stop/update is blocked by active transfers, installations and unverified operations.

## RuTracker search

Install managed Prowlarr or connect an existing instance using its address and API key (Settings → General). Enter RuTracker credentials to add and test the indexer. The wizard connects its Torznab endpoint and PS4 category to PackageFlow. Existing indexers can be reused without overwriting their settings.

The launcher restores the RuTracker username and saved password. Saved launcher passwords and API keys use current-user Windows protection (DPAPI). Passwords are masked until Show is checked. When Prowlarr returns only a password mask, the wizard shows Saved in Prowlarr rather than treating that mask as a real password. Launcher API keys are protected for the current Windows user. Prowlarr and WEB retain keys in their own configuration files; do not publish the data directory. Additional tracker authentication or proxy configuration is available through **Open Prowlarr**. Search setup can be skipped.

### FlareSolverr returns 500 during its proxy test

Prowlarr tests the proxy by requesting `https://prowlarr.servarr.com/v1/ping`. A Cloudflare block for that address in the FlareSolverr log does not prove that RuTracker is blocked or the tracker password is incorrect. A `200` response from the local FlareSolverr homepage only confirms that the component is running.

In installer 0.1.6, **Connect selected to WEB** tests an existing indexer without reinstalling its proxy or changing its tags. FlareSolverr setup has a separate button. If the standard proxy test fails, the wizard separately probes the test site and RuTracker through local FlareSolverr. Only a confirmed Cloudflare block on the test site combined with a successful RuTracker response permits Prowlarr `forceSave=true`, with an explanatory message. Other errors stop setup. Indexer authentication and search still undergo their normal test before connecting to WEB.

## Downloads

Connect an existing qBittorrent with Web UI enabled. The download button opens the official website; qBittorrent installation is currently separate. Map its download directory to the games directory visible to PackageFlow.

## Docker Compose

Install and start Docker Desktop separately. The wizard checks Docker/Compose, generates a configuration and starts containers. Prowlarr is optional. Games are mounted read-only at `/games`; persistent WEB/Prowlarr data remains in the user directory. Prowlarr is published only on `127.0.0.1:9696`.

Compose creates a local image from the ready-built WEB bundled in the installer and a Node.js base image. No source checkout, npm installation or separately published preview image is needed. The first launch requires container-registry access for the base image and selected components. Packaging rejects platform-specific `.node` modules in the WEB output.

Existing Windows services must be reachable from containers via `host.docker.internal`; binding solely to loopback can prevent this. Use a reachable address or managed Prowlarr inside Compose.

## Updates and removal

Updates check the latest stable GitHub Release for `PackageFlowSetup-<version>-x64.exe`, verify its size and GitHub SHA-256 digest, and start the installer only after stopping safely. PS4 service updates remain available in WEB and on the console. Removing the Windows application preserves settings, library, pairing, downloaded components and games.

## Developer build

Windows requirements: Node.js 22, .NET SDK 8, NSIS 3.

```powershell
./packaging/windows/build.ps1 -Version 0.1.7 -DockerImage demagoc3/packageflow:latest
```

GitHub Actions → Windows installer also produces installer/checksum artifacts without publishing a release. Sources: `apps/windows-launcher`; packaging: `packaging/windows`. These documentation drafts are uncommitted for review.

Compilation and automated tests do not constitute a real Windows test. Verify first launch, tray, firewall, Compose networking, tracker login, pairing and upgrade over an existing installation.

## Changes in 0.1.1

The search step installs FlareSolverr from the official verified Windows x64 release or via Docker Compose, tests its Prowlarr proxy, and applies a dedicated tag to RuTracker while preserving other indexers. Pairing publishes the new computer LAN address and WEB port to PS4; PKG 1.92 reloads it without restarting the interface. Settings open maximized with sidebar navigation and a fixed action area.

## Changes in 0.1.6

PS4 pairing is checked separately after WEB; a stored key alone is not treated as a verified connection. The header links to 4PDA and GitHub. Dropdown lifetime is fixed and language changes preserve entered values. Installation settings use three columns and actions share one row. Games and qBittorrent folders have a browse button; container or remote paths can still be typed manually. The finish page offers a desktop shortcut.

## Changes in 0.1.7

Apply saves edits and immediately indexes the selected folder. Native Windows folder and autostart edits apply without stopping WEB. Mode, port and host address changes use a safe restart blocked by active jobs. A changed WEB address is published to the paired PS4; failed attempts are reported and retained for retry. Edited RuTracker settings are tested before saving and preserve proxy tags. An open WEB refreshes its library when focused and every 10 seconds on the library page. Reduced windows retain full labels and status card boundaries. Equal-height 4PDA and GitHub logos appear in the header. WEB version and stars load from GitHub with cached values available offline.
