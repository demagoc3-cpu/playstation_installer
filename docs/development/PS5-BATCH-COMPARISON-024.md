# PS5 32 / 64 / 128 MiB transfer groups — 024

Development candidate measured on 2026-10-12, PS5 FW 13.60. No push/release.
Native PS4 2.06 and PS5 01.000.042 applications unchanged.

## Hardware comparison

Same Windows WEB host, SSE2 ELF, two-slot 4 MiB receive pipeline, two BLAKE3
updates and durable ACK. 256 MiB RAM-generated payload per run, three repeats
per group; forward/reverse/forward ordering. Timing covers begin-completed
upload through final block ACK, excludes final commit verification.
Every fixture separately committed and verified. No installation or launch sent.

| Group | Median MiB/s | Range MiB/s | Median Mbit/s |
|---|---:|---:|---:|
| 32 MiB | 95.59 | 95.16–95.67 | 801.8 |
| 64 MiB | 102.38 | 102.16–102.62 | 858.8 |
| 128 MiB | 104.78 | 104.58–105.71 | 879.0 |

128 MiB improves this comparison by 9.6% against 32 MiB, 2.3% against 64 MiB.
These are controlled durable transfer measurements, not a full-game/NAS promise.
The previous 023 experiment used 128 MiB total per run; compare rows within
this experiment rather than attributing a different baseline to code changes.
At 128 MiB, two checkpoints replace eight per 256 MiB. Receive memory stays
about 12 MiB, independent of the group. WEB prefetch can use two 128 MiB
buffers for large files; for small files/resume tails buffers are capped at
remaining file size. A disconnected group can retransmit up to 128 MiB.

## Recovery and negotiation

Both 64 and 128 MiB passed interrupted-body rollback to the previous 8 MiB ACK,
exact resume, ignored replay-response/status reconciliation, changed replay 409,
and final BLAKE3 verification. Eleven owned fixtures removed only after checking
journal ID, size, verified offset and hash. No user game/source/save data removed.

Root parser maximum is bounded at 128 MiB. Advertising 64/128 requires existing
speed qualification (including native FW 13.60 check), SSE2 and its own private,
regular, no-symlink marker `benchmark/qualified-batch-024-N` with exact text
`PFBATCH024 FW13.60 SSE2 MAXN PASS`, N = 64 or 128. Missing/wrong/public/symlink
markers retain prior qualified 32 MiB or 16 MiB; portable stays 16 MiB.
128 selected as the measured winner after recovery tests and fixture cleanup.
No claim of other firmware qualification.

WEB accepts only exact 16/32/64/128 MiB negotiated limits. Unknown limits retain
legacy bounded chunk fallback. Optional telemetry supports the same 128 MiB
maximum and cannot override ACK offset/content validation. PKG, Folder v1/v2,
UFS2, exfat, PFS and FFPFSC use the shared sender. Native install/registration
APIs and all durable hash checks remain unchanged.

Rollback to an older ELF can invalidate a larger hash checkpoint and cause a
full verification reread; durable data remains. Replace ELF only with no active
system installation or user application. Older WEB versions that do not recognize
128 MiB use their smaller legacy chunk route; update WEB together with the ELF.

## Validation and artifact

- Root `make test` passed in candidate and canonical source; SDK build passed.
- Portable/SSE2 independent-process checkpoint tests passed at 128 MiB.
- WEB 60 tests passed across queue, image, Folder, telemetry and speed files,
  including full 64/128 MiB PKG groups with lost ACK and changed source.
- Small-file bounded prefetch regression passed.
- Tested ELF 0.1.24-dev, build `ps5-service-batch-comparison-024-sse2`.
- SHA256: `1213b94e4d0997db6dbfaefec99a56257c964a86935c043030803b48400bd84c`.
- Hardware root replacement confirmed, one PackageFlow process; completed
  Astrobot registration/queue preserved. No user game reinstallation requested.
