# PS5 transfer profiling, SSE2 and 32 MiB — 023

Development candidate tested 2026-10-12 on PS5 FW 13.60. No push or release.
Native PS4 2.06 / PS5 01.000.042 applications unchanged.

## Controlled hardware comparison

Same Windows host, PS5, receiver two-slot 4 MiB pipeline, two BLAKE3 digests
and fsynced offsets; 128 MiB per sample, three repeats, alternating 16/32 order.
Payload generated in RAM to isolate WEB↔PS5 from disk/NAS reads.
Timing covers body upload through durable ACK; commit verification is separate.
All final digests verified. No installation, registration or launch was dispatched.

| ELF BLAKE3 | Group | Median MiB/s | Range MiB/s |
|---|---:|---:|---:|
| portable | 16 MiB | 74.44 | 74.43–74.58 |
| portable | 32 MiB | 86.74 | 85.92–87.55 |
| SSE2 | 16 MiB | 76.40 | 76.28–77.13 |
| SSE2 | 32 MiB | 88.57 | 88.07–89.05 |

Chosen: SSE2 + 32 MiB, +19% against portable 16 MiB. SSE2 lowers the two
BLAKE3 updates from ~530 ms to ~310 ms per 128 MiB (~42%). That reduction
is not an equivalent whole-transfer gain: receive overlaps writes/hash, while
consumer writes, hash and durability bookkeeping are still ordered.
32 MiB halves checkpoint/state transactions. Data fsync remains at each ACK.
Receiver memory stays two 4 MiB receive slots + a 4 MiB consumer buffer;
WEB prefetch uses two 32 MiB buffers instead of two 16 MiB buffers.
An interrupted group can require retransmission of up to 32 MiB.

## Qualification and recovery

Root service 0.1.23-dev, build ps5-service-transfer-profile-023-sse2.
SHA256 b03efce50b795f4c8fe49fe0fe17d0646684070b94a17587126ad262ab3b13a7.
Control portable ELF SHA256 4da3a931c01b76c101167963c6d99406ad6bded9ea9414432985c0f7c5811bcb.

Existing speed qualification plus an owned private regular marker
`benchmark/qualified-batch-023` with exact text
`PFBATCH023 FW13.60 SSE2 MAX32 PASS` enables advertisement of 32 MiB.
Missing/wrong/symlink/public marker retains 16 MiB; portable never advertises 32.
PS5 native gate checks FW 13.60. Unknown future limit cannot enable batching in WEB.
Manual 32 MiB input remains bounded by the parser before qualification; advertisement
is the tested opt-in, not a new unauthenticated endpoint.

Both modes passed a truncated 32 MiB body with unchanged prior offset, resume,
lost ACK reconciliation, changed replay rejection and verified final content.
Fourteen successful journaled fixtures and one deliberately rejected generator
fixture were removed by exact ID/size/hash checks. Initial generator was corrected:
its 16 MiB slices repeated the wrong half of a 32 MiB pattern. The correct 422
rejection was independently read from the selected verifier operation before cleanup.
No user game/source/save data was removed. One service process remained.
Paused Astrobot queue ID/transfer ID and 6,517,948,416-byte WEB offset survived both handoffs.

## Telemetry contract

Batch ACK retains exact durable fields and adds optional `profile` schemaVersion 1:
`hashMode`, `offset`, `bytes`, `elapsedMs`, `receiveWaitMs`, `writeMs`, `hashMs`,
`syncMs`, `checkpointMs`, `stateMs`, `replay`, `streamingHash`.
Receive wait includes waiting/copying by the consumer, not total NIC duration.
Write time covers pwrite; sync is data fsync; checkpoint includes load/finalize/save;
state includes durable position file and directory sync. Replay is excluded from WEB telemetry.
Old checkpoint fallback can hash at verification; such unstreamed groups are excluded.

WEB validates optional telemetry only after existing exact ACK/content checks.
Malformed/missing telemetry is ignored, never turns an ACK failure into success.
The latest game block appears in Devices → Speed tests, with timestamp and phases.
It reuses existing queue persistence; it does not add per-block queue fsyncs.
PKG, Folder v1/v2 and UFS2/exfat/PFS/FFPFSC share the negotiated 16/32 MiB route.

## Validation

- `make test` SSE2 and portable passed, plus canonical root `make test`.
- Official vendored BLAKE3 1.8.2 SSE2 source; wider SIMD disabled.
- Golden empty digest and misaligned/fragmented boundary vectors match portable.
- Independent-process portable↔SSE2 persisted hasher checkpoints resume and verify.
- Makefile mode stamp forces rebuild on mode changes; default SSE2, portable retained.
- WEB eight test files passed, including lost ACK in 16/32 MiB for all six formats,
  rejected optional telemetry, queue recovery, speed, readiness and registration.
- Nuxt production build passed. Hardware transfer results above are not installation,
  launch or full-game/NAS throughput claims.

Rolling back to 020 can invalidate a 32 MiB hash checkpoint and require a full
verification read; durable data remains valid. Do not replace ELF during an active
system install or while a user application runs.

## Deployment follow-through

Installed Windows WEB profile API fixed in 65221f1: reads public `q.items`,
never hidden `q.history`. Installed 023b API returned 200 with phase telemetry,
page 200, completed Astrobot queue preserved; both console bundles pinned tested
SSE2 ELF. Canonical SDK rebuild differed from hardware-tested ELF only in its
16-byte generated build UUID note; bundles retained the exact tested artifact.
Follow-up 024 comparison/deployment is recorded in PS5-BATCH-COMPARISON-024.md.
