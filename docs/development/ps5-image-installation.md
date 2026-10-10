# PS5 image driver: implementation checkpoint 2026-10-10

Historical hardware tests already proved UFS2, exFAT and PFS launch on PS5 Slim
13.60 using ShadowMountPlus; ANIMAL WELL and Hades II also ran as FFPFSC.
Those results remain valid. This work integrates the image transfer/publication
stage with PackageFlow HTTP and deliberately does not repeat that format matrix.

`ps5-image-driver.ts` prepares only PS5 base images in ufs2/exfat/pfs/ffpfsc.
It reads metadata from contents, binds title/content/version/format/size and the
physical source stamp, and reuses our BLAKE3 source hash cache. A descriptor
binds a separate image transfer ID, size and BLAKE3; both transfers need exact
verified receipts before one experimental publication POST is sent.

The existing chunk driver provides durable offset reconciliation and resume,
negotiating up to 4 MiB with 256 KiB fallback. Cache reuse is console independent;
transfer IDs are transaction specific. The ELF streams BLAKE3 during receipt;
local publication makes a further copy with streaming BLAKE3 and fsync.

Lost publication responses are recovered with read-only status checks even if
the local source is no longer available. No repeated commit, Sony PKG dispatch,
implicit launch or invented installation receipt occurs. A bound published
receipt becomes `unconfirmed`; registered=false and installed=false are checked.
Source checking, sending and device checking remain separate progress phases.

Public queue admission remains closed for images: the new route still needs
source-bound mount/system registration evidence. `runImagePlan` is an explicit
candidate helper, not a publicly enabled installation path; new API methods are
whitelisted with their correct methods. Existing Folder/PKG paths are preserved.
ELF readiness images.prepared=true/ready=false is not installation support.

On PS5 the publisher uses a guarded complete-file rename because earlier trials
rejected hard links. External publishers must remain idle during publication;
POSIX rename cannot guarantee no-replace against a competing external writer.
Owned stage cleanup uses a durable inode record, never a suffix-wide deletion.
An existing title is rejected across Folder/container extensions and system app
roots. Updating installed images is not covered by this candidate.

Validation: five image driver scenarios (all four metadata formats, durable
resume, source mutation, proof mismatch, read-only recovery, closed admission),
existing scattered-image/Folder/source-hash-cache/queue/service-update suites and
Nuxt production build pass. ELF make test has 22 targets and its SDK build passes.
Five saved UFS2 artifacts from earlier deployments pass the new geometry checker.
No console network request or deployment took place while PS5 was offline.

Next work is registration integration and one focused end-to-end test of this
new route. Historic gameplay PASS must not be overwritten with "untested".
Root service contract: `docs/image-api.md` in PackageFlowService-PS5.
Upstream review is pinned to [ps5upload 6.7.4](https://github.com/phantomptr/ps5upload/blob/7ecb99d53ca1f60d7323b40fb63ae67792b11a50/CHANGELOG.md).
