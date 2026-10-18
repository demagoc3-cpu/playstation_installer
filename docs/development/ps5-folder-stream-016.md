# Folder streaming: WEB + ELF 016

Implemented and tested on PS5 Slim 13.60, 2026-10-12. Development candidate,
not a published release. Native applications were not edited or rebuilt.

## Contract

The source review is recorded in [ps5upload-review-2026-10-12.md](ps5upload-review-2026-10-12.md).
We adopt streaming checksums, background verification and same-volume rename,
not the complete AVA1 transport (encryption, packed small files and conversion
of remote sources remain separate work).

- Negotiate `folder.streamProtocol=folder-stream-v2`, `storageCopies=1` and
  `streamingHash=true`, only with the tested Folder readiness on 13.60.
- New plans use PF_FOLDER2. Preparation inventories paths and file stamps and
  reads PARAM; it does not read the whole game to obtain hashes. Source files
  are checked for changes before, during and after transmission.
- Begin binds transfer ID to immutable source identity and size. Source
  identity is not a content checksum. Sender and receiver calculate BLAKE3 as
  bytes pass through them. Commit seals with the final content hash; publication
  refuses an unsealed, incomplete or mismatched file.
- Hash checkpoints are bound to the source and the device's durable offset.
  WEB saves checkpoints every 16 MiB and at EOF. A lost/bad checkpoint may
  require reading an already sent prefix on recovery; normal first upload has
  no preliminary full read. Final hashes are also saved in the source cache.
- Verification window 2 lets the next file upload while a worker finishes the
  previous file. Final publication waits for every verification result.
- ELF journals ownership before moving received inodes into the private tree.
  Source, stage and destination must be on the same device. Publication uses
  rename, not a second full copy. A retry cannot replace a foreign title/stage.
- WEB requires one source size plus max(512 MiB, 2% of streamed Folder bytes).
  Saved progress does not reduce this estimate without a live device receipt.
  PKG, images, old ELF and persisted PF_FOLDER1 plans retain the old estimate
  and path. Old plans are not silently converted.

## Verification

- Full standalone ELF `make test`: PASS, including content mismatch,
  interrupted publication recovery, unchanged inode, cross-device refusal and
  capability gating. SDK build: PASS.
- WEB Folder, readiness, installation-space, source-cache and stream-checkpoint
  tests: PASS. Nuxt production build: PASS.
- Host checkpoint test: after a lost ACK at 20 MiB and a checkpoint at 16 MiB,
  recovery reads only the 4 MiB tail and produces the correct final digest.
- Hardware ELF `0.1.16-dev`, build `ps5-service-folder-stream-016`:
  SHA256 `8f86b0530dee5c7f789666f109e131d1b3400047bf18bd05be908d57d7afd692`.
- Dedicated PPSA95061 fixture: 70,896,713 bytes, preparation 9 ms, transfer
  2,269 ms, final registration confirmed. These are small-fixture measurements,
  not a benchmark of a large NAS library. Launch/functional UI were not tested.
- FTP verified all 5 nonempty published files with exact sizes and absence of
  every corresponding transfer `.pkg`: no second content copy remains.
  Global free-space delta includes system/registration writes and is not an
  isolated measurement of game allocation.
- The earlier catalog/saves read marker was recovered after deletion of the
  service data directory, using prior management014/015f hardware evidence and
  a successful live catalog read. No new console-control marker was fabricated.
- Installed Windows WEB updated from code commit `c0d791a`; HTTP 200 and
  catalog retained (29 games, 10 on the checked page). Previous WEB and bundle
  are preserved for rollback. The installed bootstrap bundle now carries ELF
  016; Claude's PS5 042 and PS4 2.06 artifacts are unchanged. No app reinstalled.
- Production WEB negotiated `folder-stream-v2` / `storageCopies=1`.
  Read-only installation preview for Alan Wake Remastered: source 33,255,742,145
  bytes, required 33,920,856,988 bytes, previously 66,511,484,290 bytes. No
  installation of that user game was started during verification.

## Limits

The test fixture stays registered because current readiness checks the live
fixture behind its hardware marker. Deleting it disables this new capability.
Directory enumeration still costs time for very large trees. Crash recovery
without a valid checkpoint/verification ledger may read existing data again.
Cleanup of cancelled legacy transfers, image-copy optimization and a complete
AVA1 port are not included in this change.

## Production integration correction

The first hardware fixture used the real Folder driver with a direct request
adapter. It did not exercise the production HTTP header allowlist. Avatar's
real queue exposed a missing `X-PackageFlow-Stream` entry: WEB rejected its own
request before contacting PS5 and the generic retry handler reported an outage.
The header is now admitted; local command-validation failures are distinguished
from transport failures. A new integration test executes the production queue
driver through `ps5OperationRequest`, including late seal and publication.

The pending-space reader also used the redacted public queue (without transfer
IDs), so it could not read its v2 plans. It now reads the private captured queue
and preserves redaction in API responses. The Vue dialog separately doubled
source bytes; it now uses `requiredBytes` from the server and adds only explicitly
approved PKG replacements. Tests cover an active v2 Folder plus a new PKG and
the dialog's displayed calculation, while retaining legacy-plan estimates.

ASTRO's live registration had no source path and version `0`; WEB classified
that as offline. A confirmed base registration now requires review as an
existing base, without asserting the selected version is installed. A patch or
DLC without sufficient evidence remains unconfirmed. No automatic overwrite
approval was introduced.

Installed Windows WEB `8576e4e` then resumed the original Avatar queue/transfer
IDs without reinstall dispatch or ELF replacement. Live queue progressed to
449,384,312 bytes; PS5's first-file receipt was complete, verified and sealed
with a content hash. Preview now admits ASTRO's existing-base review and counts
the Avatar queue as 192,358,761,090 bytes including reserve, instead of doubling
it. ASTRO is not automatically queued or overwritten. Full Avatar completion
is still pending; these checks confirm transfer initiation and corrected
admission/space only. Browser tabs opened before the update must be reloaded
to use the corrected Vue dialog.
