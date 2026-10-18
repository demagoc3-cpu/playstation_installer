# Transfer batching for every PS5 format

Development verification on 2026-10-12. WEB changes only; root ELF 020 and native PS5 01.000.042 / PS4 2.06 binaries unchanged. Local commit, no push.

## Change

PKG and UFS2/exFAT/PFS/FFPFSC previously sent 4 MiB chunks through the receive-then-write endpoint. Folder streaming already used the pipelined endpoint. A shared protocol selector now uses 16 MiB `/api/v1/transfers/batch` only when the service advertises exactly that hardware-qualified limit. Known-hash transfers, image manifests and both Folder protocols use the same negotiation. Older or unsupported limits retain the bounded chunk route.

The server still authenticates requests, validates source identity, and advances only after an exact durable acknowledgement. A lost response is reconciled by transfer ID and durable offset. Image publication keeps `image-registration-v1`; no image is sent to the PKG installer. Registration and installation receipts are unchanged.

## Tests

Queue driver tests exercise legacy fallback (including unsupported 32 MiB advertisement), 16 MiB batches, lost ACK, exact bytes/hash, one installer dispatch and changed-source refusal. Each of the four image tests crosses batch boundaries, loses its first ACK, verifies complete data and manifest, then publishes exactly once through the image protocol. Existing Folder streaming / production, readiness and registration tests pass. Nuxt production build passes.

## Windows to PS5 transport measurements

Authenticated hardware tests used root ELF 020 on FW 13.60. Each main payload was 128 MiB. PKG compared the same real local PKG prefix held in memory; Folder and image tests used owned files and structurally parsed container metadata with synthetic trailing data. These are transport, durable write, hashing and resume checks, not installation, mount or launch tests. Source preparation is excluded from the table; whole-run time includes verification, metadata and intentional lost-ACK recovery.

| Format | Body requests, MiB/s | Whole run, MiB/s | Lost ACK resume |
| --- | ---: | ---: | --- |
| PKG, legacy 4 MiB | 38.65 | 36.74 | Baseline |
| PKG, batch 16 MiB | 73.93 | 67.39 | PASS |
| Folder | 71.49 | 59.81 | PASS |
| UFS2 | 72.22 | 54.04 | PASS |
| exFAT | 72.67 | 53.31 | PASS |
| PFS | 72.52 | 53.83 | PASS |
| FFPFSC | 71.33 | 52.67 | PASS |

All six resumed at the confirmed 16 MiB offset after a deliberately discarded response. Every received file reached verified state with full durable size. Installation/publication endpoints were intercepted locally, so no test game was installed. All 16 journaled transfer fixtures were checked by ID, size, hash or stream identity and verified receipt, then removed through exact FTP paths; subsequent status GET returned 404. Generated Windows sources were removed. User source games were preserved.

An initial test connection closed while another control request was pending; root stayed alive. The harness reconciled the 64 MiB durable offset. A harness continuation also incorrectly used an image-file ID as the manifest ID; the resulting size conflict was rejected. This was fixed in the temporary harness, not production. Existing fixture verification was reconciled before remaining fresh comparisons. Completed measurements above exclude these incomplete attempts. All their owned files remained in the cleanup journal.

A passive ten-second sample of the actual local-D: ASTRO task before the change measured 39.97 MiB/s. NAS did not participate. No sustained full-game 74 MiB/s claim follows from the 128 MiB fixtures. The user subsequently reports approximately doubled real transfer speed.

## Installed WEB

The installed Windows `Programs/PackageFlow/server/.output` was replaced, with its previous WEB and queue backup retained in `allformats022-backup`. Archive SHA256: d5b000b07d5b476843412ed04bf47e77bf97eba6974b8b3f1b26f91d6fc2b523. Installed logic SHA256 (`server/chunks/nitro/nitro.mjs`): 247914722af69e184f153fd1c4d8e13fca7e62733954e8ad2fadfd711f919c5f, checked against the built file. Installed page returned 200; public profile and authenticated readiness confirm all six formats. Root remains PID 194. Queue state and item IDs/bytes survived deployment. The user changed jobs during testing; only a paused queue without an uncertain install dispatch was eligible for replacement. No job cancellation, automatic restart of cancelled work or game retransmission was issued by the tests.

## Further optimization

32 MiB needs coordinated ELF and WEB negotiation, plus hardware qualification and lost-ACK / partial-body rollback checks. Increasing the limit alone does not remove the per-byte work. Current C transfer code updates both the whole-file and last-group BLAKE3 hashes; its SDK build disables SSE2/SSE4.1/AVX2/AVX512. This makes SIMD hashing and timing instrumentation worth testing. It does not establish CPU utilization as the bottleneck without measurements. Preserve the whole-file hash, replay validation and durable offset ordering. Increasing internal receive buffers is a separate experiment from increasing the HTTP batch size.
