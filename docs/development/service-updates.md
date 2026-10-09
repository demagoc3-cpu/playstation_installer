# Device service updates and installation attempts

The Devices page displays the API version and, on PS4, the installed launcher PKG
version. Each row opens its own updater; it does not change the selected console.

PS4 accepts a locally validated, newer PackageFlowService PKG. Starting with
PKG 2.03, an open PFLS00001 interface is stopped using its exact application ID.
The command receipt and runtime must both confirm closure before installation.
PFLS00002 and system applications remain protected. Older launchers require a
one-time manual interface close. The existing restart action replaces the daemon
only after the exact update job has finished; pairing is retained.

PS5 update support is a local candidate, awaiting UI 034 and hardware validation.
The WEB release catalog uses a fixed ELF filename, architecture/size checks,
SHA256, version, build ID and firmware. The candidate requires an explicit UI
exit acknowledgement, idle operations, and a connected loader before shutdown.
It sends the payload once, then checks a new PID, matching version/build and the
existing pairing key. A lost shutdown/upload receipt leaves `unconfirmed` and
blocks replay. No PS5 release is staged or sent as part of this change.
The existing PS5 service first needs migration to the new update protocol.

The normal Tasks view shows the newest attempt for each file on each console.
“Attempt history” exposes previous attempts without erasing their journals.
Different patch files and different consoles remain separate. Queue deduplication
and cancellation are independent of this display filter.

PS5 content routes stay distinct: staged PS4 CNT PKG, staged PS5 FIH PKG,
folder publication/registration, and UFS2/exFAT/PFS/FFPFSC mount/registration.
The current public installation driver admits PKG only; previously verified
image and folder experiments remain documented in the PS5 installation matrix.
Catalog v2 reports installation readiness/reason alongside supported formats.

## Verification

- `node --test server/tests/ps5-service-update.test.mjs server/tests/task-attempt-history.test.mjs`
- Node with TypeScript support: `node --experimental-strip-types server/tests/console-maintenance.test.ts`
- `node server/tests/console-platform.test.mjs`
- Nuxt production build and a real browser check of both device updater panels.

Windows WEB deployments replace only `web/`, retain `data/` and the existing
runtime/task, and keep a recoverable previous build. Inspect queue JSON locally
before restart; do not use a queue API read that could wake pending installations.
