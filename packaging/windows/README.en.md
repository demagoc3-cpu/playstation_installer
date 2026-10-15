# PackageFlow Windows 1.10.15

Windows is Native only. .NET remains self-contained; Node/WEB and the local Vue/WebView2 frontend remain bundled. There is no Windows Docker/Compose execution, Docker installer link or container configuration. The main WEB project's independent Docker deployment is unaffected.

Build with Node 22/npm, .NET SDK 8 and NSIS:

```sh
PF_PS5_BUNDLE=/path/to/verified-console-bundle bash packaging/windows/build.sh --version 1.10.15
```

```powershell
./packaging/windows/build.ps1 -Version 1.10.15 -Ps5Bundle C:\verified-console-bundle
```

Both entrypoints default to Windows Node 22.23.3 (`PF_NODE_VERSION` / `-NodeVersion`). Skip-Web options reuse an already current `.output`; Vue is always rebuilt with its own lockfile. BundleCheck verifies Windows/Core versions. The payload audit verifies frontend/console hashes and rejects offline Runtime/container artifacts. Incremental staging removes previous owned build files.

No WebView2 installer is bundled. A supported installed Runtime bypasses all dependency downloads/installations. Otherwise the official pinned 1,860,304-byte Evergreen bootstrapper is downloaded over restricted HTTPS, checked by size/SHA256 and Valid Microsoft Authenticode, held read-only and run without elevation. Microsoft then downloads the matching Runtime. Per-user support depends on Windows policies. SDK verification after setup is mandatory; exit 0 is not sufficient. A native preparation panel gives download progress and an indeterminate Microsoft-install stage, actionable failures, manual retry/check and close. Journalled unconfirmed installations are never replayed or forcibly terminated. [Microsoft guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution).

UI/assets stay local. Internet is required only to provision a missing UI Runtime and for enabled component downloads/external features. Runtime is required even when torrents are declined; FlareSolverr's Chromium is a separate dependency. qBittorrent/Prowlarr/FlareSolverr remain on-demand downloads.

Old container-mode profiles require review before Native startup. The original settings are backed up exactly before saving; library, LAN/ports, credentials, pairs, autostart and torrent consent survive. Close the old launcher and manually finish jobs/stop the former WEB before upgrading. No old container is adopted or stopped, and occupied ports block the guard. The new UI can copy a known bind directory or a complete Windows export of `/app/.data` including hidden files/keys into a separate Native import. Volumes, containers and original data are not changed. Only known mount paths are rewritten; unknown local paths, missing vault keys, invalid/changing exports are rejected. An empty external-volume substitute is not accepted. An empty detected bind requires explicit acknowledgement. Review network sources in WEB afterward.

Windows 1.10.18 bundles PS4 2.14, PS5 ELF 027 and the new PS5 app revision 01.000.044/6c32b25. Artifact sizes, hashes and the app Build ID are verified; the console binaries are not rebuilt. Version 1.10.17 retains the previous 5122c1f app revision. Updating Windows does not automatically install the app on PS5. NSIS preserves user data and busy guards, and removes only known former distribution files by exact hashes under the install folder. Shared Runtime, Downloads, volumes and Docker Desktop are untouched. [Detailed Russian build/migration notes](README.md).
