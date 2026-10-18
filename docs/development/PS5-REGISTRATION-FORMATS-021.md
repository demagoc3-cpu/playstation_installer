# Folder registration wait and lost format readiness

Development work on 2026-10-12; local commits only, no push. Root ELF 020 and native PS5 01.000.042 / PS4 2.06 application binaries unchanged.

## Folder wait

A matching `published` receipt proves publication, not system registration. WEB persists the first observation as `folderPublishedAt`. After two minutes without a matching `registered` receipt, the task becomes `unconfirmed` with an explanation and a ShadowMount check hint. The worker continues read-only reconciliation. It does not resend files or repeat publication, mark the game installed, or advance the queue on a timeout. A later exact registration receipt completes the task and allows the next item to run.

Tests cover persistence across worker restart, the timeout boundary, no mutation requests during waiting and eventual exact registration recovery. Folder production, queue and registration regression suites pass; Nuxt production build passes.

## Hardware diagnosis

Avatar completed all 188587020676 bytes. Its durable receipt was `published`, with matching title, manifest and metadata hashes. ShadowMount's log reported a missing AppInstallAll hook / unavailable internal TitleDir bridge; both registration attempts failed and the backend reached its retry limit. This was not an incomplete transfer. The reason the hook disappeared has not been established.

A guarded handoff to the same pinned ShadowMountPlus 1.7beta3 restored the bridge. No Avatar files were resent or removed. Root ELF 020 remained PID 194; ShadowMount changed 125 to 200. A fresh authenticated Folder status then returned `registered` for PPSA01576, and WEB recorded version 01.011.000 as installed. Avatar launch/functionality is not claimed by this registration check.

## Formats

Deletion of `/data/packageflow-ps5` removed the image qualification marker. Separately, the loopback PKG companion was unavailable. The implemented format handlers were still present, but live admission correctly advertised only Folder.

Restored the exact image qualification previously backed by all four registration and user-confirmed launch tests on 2026-10-10, on the same firmware 13.60 and pinned ShadowMountPlus 1.7beta3. Marker staging and final readbacks matched; this does not qualify other firmware or backends. Started the independently hardware-qualified Installer 1.4.0 once from its pinned ELF SHA256 c0d208f2b340266bb0177622e60b1685ce9c7941ad51f95d808d764f50748f93, with the queue paused. It is a separate loopback-only PKG companion, not a second root PackageFlow instance. Existing root, ShadowMount, kstuff and active application processes were preserved.

Authenticated readiness subsequently reported PKG, Folder and UFS2/exFAT/PFS/FFPFSC routes ready. These routes still depend on their live backend prerequisites. PKG `exactVersionReceipt` remains false; submission must not be presented as verified installation or launch.

## Installed Windows verification

Replaced the installed WEB in `%LOCALAPPDATA%/Programs/PackageFlow/server/.output`, not a separate test instance. Archive SHA256 15606475707c3a10d71d5faf03dc6b372c87a80112eea5117c29bd0fb281f85c; previous WEB and queue backup retained. Queue ID, both transfer IDs and Avatar's 188587020676 bytes / installed receipt survived. Public Windows WEB profile returned online/paired and all six formats. Playwright devices and expanded tasks screens had no page errors.

A resume request returned HTTP 500; subsequent durable-state inspection proved the queue was already running and ASTRO advanced, so no resume or installation command was replayed. The exact concurrent cause of that HTTP response was not established. ASTRO first entered source verification and then transferred 641728512 bytes. A later observation showed its task cancelled and the queue completed. No cancellation was sent by this recovery procedure; the cancelled task was not restarted. This establishes resumed queue progress, not completed PKG installation or launch.
