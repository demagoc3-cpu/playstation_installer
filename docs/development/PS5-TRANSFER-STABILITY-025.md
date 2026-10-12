# Shared PS5 transfer stability — 025

Development work on 2026-10-12; local commits only, no push/release.
Native PS4 2.06 and PS5 01.000.042 applications unchanged.

## Cause and change

A controlled live TCP upload with a three-second pause reproduced HTTP 408 on
024 (PID 211): its two-second receive idle deadline rolled the incomplete group
back to the prior durable 4 MiB offset. Exact resume and final BLAKE3 passed.
The same test on 025 (PID 212) returned HTTP 200, with full durable data and the
correct final BLAKE3. Receive idle tolerance is now 10 seconds; total batch body
budget is 60 seconds. Actual socket EOF still rolls back immediately.

024 also advertised keep-alive while retiring an idle socket after only 200 ms
or when control connections waited. Its eight-block checkpoint-delay diagnostic
had no errors, so that race was not established as the user's specific cause.
025 consistently advertises Connection: close; WEB explicitly closes batch
connections. One durable ACK still gates the next block. WEB batch deadline is
90 seconds; other operation deadlines remain 15 seconds. Transport failures log
only endpoint and bounded error code, without token or arbitrary error text.
Queue messages distinguish missing acknowledgement from proven device outage.
No blind POST retry was introduced; durable state reconciliation remains.

## All game formats

PKG, Folder v1/v2, UFS2, exfat, PFS and FFPFSC use the same queue-driver,
negotiated sender and operation transport. All get qualified blocks up to
128 MiB, source prefetch, pipelined reception/write and the stability changes.
Small files and final tails remain bounded by remaining bytes. Images retain
format-specific publication/registration; Folder retains one storage copy.
Existing firmware qualification and final hash/durable checkpoint checks remain.
This does not extend PS5 transport settings to the separate PS4 protocol.

## Validation

- Canonical root make test passed, including delayed receive, EOF rollback,
  resume, lost ACK replay, corrupt replay refusal and final hash.
- SDK build passed; hardware-tested exact ELF SHA256:
  06e793702bcfc22d4293fe4877b5f8d9bbee99fc49c0629aa0f225a9c7b4ade5.
- WEB queue, Folder, all four image formats, connection, speed and new HTTP
  transport regression files passed; production Nuxt build passed.
- Hardware: before/after pause test, 128 MiB checkpoint-delay fixture, and
  512 MiB in four 128 MiB groups verified. The last run had zero request errors,
  all four ACKs and matching final BLAKE3, 95.37 MiB/s (800 Mbit/s), including
  health checks between groups. User's NAS copy was not yet confirmed finished;
  this is not an unloaded comparison or guaranteed full-game throughput.
- After user confirmed NAS copy completion, a proposed 2 GiB repeat refused
  before creating a journal/fixture because their game queue was already running.
  No competing speed test or pause was imposed.
- Four exact, journaled, verified temporary fixtures removed after ID/size/hash
  and durable-state checks; no user game/source/save deletion.

## Installed state

ELF 0.1.25-dev, ps5-service-transfer-stability-025-sse2, single PID 212.
Both installed Windows console bundles and /tmp/pf-transfer025-console-bundle
pin this tested artifact, preserving native application hashes. Authenticated
readiness confirmed all six routes, Folder one copy, batchMax 134217728.
Installed Windows WEB updated in place; page HTTP 200 and speed API ready.
At replacement the queue was independently paused before our pause command;
its ID, transfer ID, state and 7,086,315,606 confirmed bytes were preserved.
The user subsequently resumed/started a transfer, then cancelled it at
9,335,548,192 bytes. Final read-only check: queue cancelled, operation not running,
PID 212 unchanged. No automatic restart or installation replay was sent by this work.

WEB source commit 02578d4; ZIP SHA256
6a2adc8602344670702a7d7ee1800c05c0dde698b4869f7f1849dc89dbd98fef;
Nitro SHA256 efe08bcdb2204322b3d61682a4f80cb7310254f5d393f47e046d0c531c869df0.
Root implementation commit 43257bc. Backups: transfer025-backup and bundle
before-transfer025. User's eight observed disconnects have no preserved error
codes; the controlled pause reproduction is evidence for a fixed cause, not
proof that every observed interruption had that cause.
