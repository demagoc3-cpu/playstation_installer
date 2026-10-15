# PS5 throughput investigation — 2026-10-12

The tested network changes are still installed and active. The speed regression
is real in controlled transfer tests, but its underlying cause is not yet
established. No throughput fix or new native release is claimed by this report.

## Installed code and negotiated settings

Windows GAMEPAD-PC, PS5 192.168.0.127, firmware 13.60. The source of ASTRO's
PLAYROOM is `D:\test2\Astrobot`, a PKG of 11,016,536,064 bytes.

The running service is `ps5-service-transfer-stability-025-sse2`, version
0.1.25-dev. A controlled restart used the identical installer ELF, SHA256
`06e793702bcfc22d4293fe4877b5f8d9bbee99fc49c0629aa0f225a9c7b4ade5`.
Native negotiation and actual ACK telemetry both confirm 128 MiB groups,
streaming SSE2 BLAKE3, durable checkpoints and concurrent receive/processing.
WEB still uses two bounded prefetch buffers, one outstanding POST, explicit
connection close and durable-offset recovery. PKG, Folder and image senders
continue to share this transport; no network fix was removed for packaging.

## Hardware results

Queue was already paused when the active measurements began. Each controlled
run transferred 512 MiB through the actual batch API, then committed and checked
the exact final BLAKE3, size and durable offset. No installer call was made for
any fixture. Two repetitions of each row were performed per launch method.
Rates include source reads and HTTP requests through the final durable ACK;
final commit verification is separate.

| Source / group | Payload Manager, median MiB/s | ELF loader 9021, median MiB/s |
|---|---:|---:|
| RAM / 128 MiB | 64.29 | 64.72 |
| RAM / 64 MiB | 62.66 | 62.77 |
| Local PKG / 128 MiB | 63.73 | 64.66 |

The launch-method hypothesis did not produce a material improvement. Keep
128 MiB; reducing to 64 MiB does not restore earlier throughput. All twelve
runs in this controlled comparison verified their final hashes without retries.
This tests transfer integrity, not installation/launch for every game format.

An initial 2 GiB sequential read of the Windows source measured 187.06 MiB/s;
repeated reads were cached and are not physical disk-speed measurements. RAM
and file transfer results agree, excluding source reading as the limiting step
in these measurements. A separate copy of the real 12,472-byte WEB ledger was
fsynced/renamed 24 times: median 3.23 ms, maximum 8.52 ms. The user's ledger was
byte-for-byte unchanged.

The final built-in 256 MiB test, stored in the Devices speed modal, measured:

- WEB → PS5 network: 101.00 MiB/s (847.3 Mbit/s).
- PS5 → WEB network: 99.40 MiB/s (833.8 Mbit/s).
- WEB → PS5 network and disk: 77.65 MiB/s (651.4 Mbit/s).
- Median request latency: 3.42 ms.

The built-in disk test has no game BLAKE3 work and is not a pure SSD benchmark.
The application-level batch comparison includes hashes and durable bookkeeping.

## Where the time goes

For a 128 MiB RAM block under Payload Manager, mean ELF phase timings were
approximately 1,860 ms total: receive wait 607 ms, write 748 ms, two BLAKE3
updates 451 ms, fsync 1.5 ms, hash checkpoint 34 ms and state 16 ms. Receive wait
includes waiting on the producer/copies and is not a standalone network timer.
Writes and hashes are ordered within the consumer while reception overlaps.

Earlier 024 hardware results used roughly 450 ms write and 245 ms hash per
128 MiB; the earlier identical 025 artifact measured 95.37 MiB/s for a 512 MiB
RAM fixture. Current write/hash phases are slower. This localizes the regression
to console-side processing conditions/path; it does not prove an SSD fault,
thermal condition, CPU frequency, scheduler issue or competing payload.
The direct network result also varies from previous measurements.

The Tasks indicator counts acknowledged bytes over a rolling window including
time since the last ACK. With 128 MiB groups, its value can fall between ACKs;
therefore the screenshot's 48.1 MiB/s is not directly comparable to a completed
fixture's average. The controlled 63–66 MiB/s still establishes a genuine
reduction from the earlier controlled result. No display formula was changed
just to show a larger number.

## Integrity, cleanup and final state

An initial exploratory 64 MiB fixture used an incorrectly sliced RAM pattern;
final verification correctly refused it. That run is excluded from the A/B
comparison. The generator was corrected before the twelve comparison runs.
Two valid initial fixtures and this rejected fixture were also cleaned.

All 15 owned fixture IDs were reconciled against their journals, size, expected
hash, completed verification or confirmed cancellation, and absence of an
installer receipt. Only their exact transfer files were deleted; all now return
404. Built-in benchmark files and the temporary Windows ledger were cleaned.

Only PackageFlow was restarted for the launch comparison. Final process PID
225, exactly one PackageFlow process, same build and 128 MiB qualification,
original Bearer accepted, native operation idle. Free transfer storage about
345.9 GiB. The user's queue remains paused with the same ID and saved offset
10,737,418,240. PS5 reports a newer durable offset 10,871,635,968: one block
had completed before the earlier pause was persisted. Normal resume reconciles
the service offset; no manual journal edit or reinstallation was sent.

Five existing WEB regression test files passed: transfer speed/prefetch, optional
phase telemetry, queue/resume, Folder and image routes. No executable source
changes, installer rebuild, commit or push were made during this investigation.

Raw measurements: [evidence](evidence/ps5-throughput-night-20261012.json).
Further acceleration should be tested as a separate candidate with measured
consumer write/hash overlap and scheduling diagnostics, preserving durability,
final hashes, pause/resume and rollback. Increasing groups above 128 MiB has
neither qualification nor evidence of addressing this bottleneck.
