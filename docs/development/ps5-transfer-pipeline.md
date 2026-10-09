# PS5 transfer checks and throughput

WEB stores reusable BLAKE3-256 source hashes in its data directory under
`source-hash-cache/<SHA256-of-resolved-source-path>.json`. This data remains
outside a portable WEB release. PKG caches use the source path; Folder caches
use the root and each relative path, independently of console/transfer IDs.

A cache hit requires the same size, mtime, inode, ctime, birthtime and device.
The source is stat-checked before and after reuse; changed files are hashed
again. Missing/corrupt/unwritable cache data never supplies an invented digest.
Existing completed installation journals/plans may seed a cache only when
manifest/hash identity is consistent and the file's change/creation times
predate that installation. Unknown historical dates mean a full read.

Service `ps5-service-transfer-pipeline-009` computes BLAKE3 while receiving
chunks and records a durable private hash checkpoint after syncing file data
and before acknowledging the durable offset. Final verification compares the
full computed digest with the source digest. On process restart it checks the
last durable chunk, with earlier chunks covered by the bound checkpoint.
Old, missing, incompatible or invalid checkpoints use the previous full-file
verification. A file stamp change invalidates the fast path.

Readiness `folder.verificationWindow=2` opts WEB into two bounded pending
verification receipts. The next Folder file can upload while the previous file
is being finalized/verified. Older services use serial verification. No Folder
manifest/publication is submitted until all file receipts prove the exact ID,
size, durable bytes and BLAKE3. A background failure aborts further transmission;
pending promises are caught and drained before recovery/cancellation.

Throughput counts acknowledged bytes and elapsed pauses. Intermediate Folder
checks retain the speed indicator; a five-second stall reads zero. Source
checking and final verification are distinct phases. Rates remain live-only,
not restored from queue journals.

The reference is ps5upload commit
[beb4e6583c1935a90533c8009f6f39242a791981](https://github.com/phantomptr/ps5upload/blob/beb4e6583c1935a90533c8009f6f39242a791981/protocol/ava1/SPEC.md),
sections 12–15: bounded receive/write workers, in-flight verification, durable
journals and resume. Our implementation retains PackageFlow HTTP/authentication
and uses a versioned hasher checkpoint rather than AVA1's group outboards.
AVA1 lanes, small-file bundles, batched fsync and direct-to-stage writes are
separate optimizations; these changes do not claim their complete transport or
speed. Folder publication still copies/hashes the completed tree locally.

Verification: `server/tests/ps5-source-hash-cache.test.mjs`,
`ps5-folder.test.mjs`, `transfer-speed.test.mjs`, existing queue/readiness tests;
ELF `make test`, including actual transfer/API worker and process restart tests.
Record hardware results separately in the shared PS5 test journal.
