# Installed package protection (2026-10-11)

The library row keeps platform, format and FW tags under its title next to the
cover. Title ID and package versions stay in individual expanded package rows.

## Device presence, never WEB marks

Installation preflight and undispatched queue items read the destination console.
Saved installation marks, delivered files and old completed queue entries cannot
prove that a package is installed. Accepted jobs retain their recovery path and
are not dispatched again. Snapshots are shared only within one preflight.

PS4: complete, revision-consistent `/apps/title/<TITLE_ID>` inventory. A component
matches kind and Content ID; base and patch also need a matching version. A base
of another version is protected from implicit replacement. A newer patch blocks
implicit downgrade. Missing endpoints, incoherent identity, unreadable metadata,
incomplete snapshots and communication failures cannot prove absence. Standalone
PyLoader must pair with PackageFlowService for this check; it never falls back to
local WEB installation marks.

PS5: read the complete device catalog and `/api/v1/console/info`. Registration
alone is insufficient: the current physical source must be available. Missing
source or unsupported info returns unknown and pauses dispatch. Live Content ID
and version are used for the base/current patch. The current protocol does not
provide a complete physical DLC inventory; DLC under an existing game remains
unknown instead of being skipped based on WEB marks. Folder/image replacement is
not supported through the installation modal.

The library activity API also uses live replies, with a five-second memory cache
for visible packages only. An offline profile returns no installed proof. Preview
and submission always bypass that cache.

## Exact selection and explicit decisions

The modal captures an immutable selection. It displays a table of all selected
packages; removing unwanted rows refreshes the preview. Changing library search
clears the old selection; a successfully accepted batch clears its selection.
Completed queue items never count as already queued. Old active tasks are shown
in a separate table and require explicit acknowledgment before appending a new
selection. Neither old queue items nor another game's components are added to the
selected-package table or reinstall plan.

Already installed packages appear in a separate scrollable table. Checked rows
mean reinstall; unchecked rows mean skip. The user must confirm that table (or
explicitly use the bulk reinstall checkbox) before installation. Per-console
choices, selected package IDs and a hash of the live component/queue snapshot
are bound to the idempotent batch request. A changed device/queue snapshot requires
new review. Free space is re-read before dispatch; the estimate includes new data,
selected replacements, existing active tasks and an installation reserve.

PS4 replacements use the existing console removal API. All preflight plans are
validated before any removal. Source PARAM identity, version, firmware and source
size are checked, and running games block replacement. A base removal is allowed
only when all of its affected patches/DLC are selected for replacement too; the
modal lists that effect. Each removal has its own persisted request ID and live
revision, and recovery only reads its result. Partial/unknown removal blocks
installation. After confirmed removals, a queue starts with only the frozen new
and approved replacement packages, ordered by game/base/patch/DLC. A Nitro worker
continues the maintenance flow without requiring the browser to remain open.
Preview reads do not resume old PS4 queues. If a WEB restart leaves the outcome of
a removal unknown, recovery polls the original request and never repeats its POST.
A queue that finishes with failed or unconfirmed items does not count as a
successful reinstallation.

## Removing stopped tasks (2026-10-11)

Game reinstallation queues are user-managed, including a failed queue with an
undispatched pending tail. They keep per-package cancellation checkboxes and
branch removal controls. Service-update queues remain protected. Completed,
cancelled and failed rows can be hidden individually or by branch; receipts,
queue indices, source files and installed games remain intact. A stale queue ID
cannot change a new queue, and every operation is scoped to its console.

Removing a branch first cancels its undispatched packages. An accepted live PS4
job stays visible until cancellation is confirmed. An active system installation
on PS5 cannot be hidden or cancelled through this control. Stopping a replacement
while removal is pending suppresses future deletions and installation, polls the
original accepted removal, and never repeats that command. The worker checks the
stop intent again after network waits before crossing a dispatch boundary.

Before dispatching a new PS4 package, WEB checks the daemon's active reservation.
If a prior job still owns it, the next package waits without a new POST. Older
services without the active-job endpoint retain their original dispatch behavior.

## Validation

Production-code fixtures exercise the reported two-game case, insufficient space,
stale local marks, changed review snapshots, exact component matching, mixed
skip/install, PS4 component replacement, omission of unselected Little Nightmares,
UI review gating and lost-reply idempotency. Existing queue/maintenance/PS5
regressions and the Nuxt build are also checked. No user game was removed or
installed during these tests; console replies are simulated.
The replacement fixture reloads the production modules while a removal is pending,
then verifies recovery from disk, one removal POST, and the exact selected queue.
