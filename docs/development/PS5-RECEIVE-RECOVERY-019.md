# ELF 019: transfer recovery, singleton and receiver pipeline

Development candidate, not a published release. Native PS4/PS5 applications unchanged.

## Findings

After the user's Ethernet cable interruption, Windows could reach PLDMGR, FTP and the ELF loader, but TCP 8095 was closed. PLDMGR still listed PackageFlow PIDs 178 and 189. Both were stopped with their identities checked and termination confirmed. Their exact exit/error cause was not captured; do not claim a specific kernel errno was observed.

The old HTTP loop left on non-EINTR select errors. Its shutdown returned from main without an explicit process exit. Update detection only observed HTTP disappearance, so it could leave a non-listening payload process behind. Candidate 019 retries listener wait errors except invalid descriptor/socket, uses a nonblocking listener with explicitly blocking accepted clients, and exits the entire process after cleanup. An owned private flock file protects against a second instance even when the network interface is unavailable. Never unlink the lock inode.

## Receiver

The authenticated 16 MiB batch protocol is unchanged. One socket-reader thread fills two bounded 1 MiB slots; the API thread writes and updates BLAKE3 as it consumes them. API state changes and durable acknowledgements remain serialized. A partial request truncates back to the previous durable offset, fsyncs, and rebinds the saved hash checkpoint. Exact replay is compared in bounded blocks; changed bytes are rejected. No next group is acknowledged before its data, digest checkpoint and offset are durable.

The network-plus-file benchmark uses the same receiver, aggregates small recv fragments before write, and records receivePipeline=true. This measures the combined network/filesystem path, not isolated SSD throughput. WEB labels old sequential results and new concurrent results separately.

## Verification

- Full make test passed; new socketpair tests cover actual concurrent prefetch, a mid-body disconnect, rollback of an unacknowledged tail, new-connection resume, lost-ACK replay and digest mismatch. SDK build passed.
- On PS5 Slim 13.60, candidate SHA256 656b32905472bbe875db8873a56d340ad894387c1bd223ebfd1dd83d2d366907 launched as PID 191.
- 128 MiB raw upload/download: 109.3 / 109.0 MiB/s; combined network/write: 86.3 MiB/s. 64 MiB durable batch transfer: legacy 4 MiB 42.4, pipelined 16 MiB 89.6 MiB/s; final hashes verified, changed replay rejected.
- A 20 MiB synthetic transfer was interrupted after a 4 MiB durable prefix: partial request returned retryable HTTP 408, offset stayed 4 MiB, same ELF PID stayed reachable, resumed content verified.
- A deliberate second ELF start was rejected without leaving a second process. Authenticated shutdown removed PID 191, then one replacement started as PID 193. No duplicate remained.
- User's 256 MiB WEB benchmark measured 106.3 / 108.3 MiB/s network and 61.3 MiB/s combined write (write 4010 ms, fsync 14 ms). Shorter 128 MiB measurements are not a sustained-speed guarantee.
- Installed Windows WEB and both bundled ELF copies updated; native app 042 / PS4 2.06 hashes unchanged. Queue 67bceda4-65a5-41cf-b913-b1bfc1f85f6b retained transfer IDs and 134255083401 acknowledged Avatar bytes; currently paused for diagnostics. Synthetic fixtures were cleaned.
- Physical cable unplug/replug has not yet been repeated with candidate 019. No full Avatar installation/launch claim.

No push.
