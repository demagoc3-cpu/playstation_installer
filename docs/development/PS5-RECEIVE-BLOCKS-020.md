# ELF 020: larger receive/write blocks

Development candidate; no push or published release. Native PS5 01.000.042 and PS4 2.06 applications unchanged.

## Change

The bounded producer/consumer receiver introduced in 019 now uses two 4 MiB slots rather than two 1 MiB slots. Transfer and combined network/file benchmark consumers use the same 4 MiB write size (benchmark previously wrote 256 KiB). Pipeline memory is bounded at 12 MiB: two receiver slots plus one consumer buffer. Protocol batch maximum remains 16 MiB. Durable acknowledgements, incremental BLAKE3, rollback and exact replay rules are unchanged.

## Evidence on PS5 Slim 13.60

- Full host `make test` and pinned SDK build passed.
- SHA256: da3626abae75753a4f9a09baacdcf17f16ddb3be3cfa82f5e60ea7f3e96f3057; 4,077,496 bytes. Authenticated shutdown removed the only prior process PID 193 before one replacement started, PID 194.
- On 019 the user's 256 MiB test measured network 106.3/108.3 MiB/s and combined network/file 61.3 MiB/s; write 4010 ms, fsync 14 ms. On 020 three 256 MiB combined tests measured 104.08, 103.95 and 103.89 MiB/s; write 1197/1227/1201 ms, fsync 14/14/18 ms. Raw 128 MiB upload/download measured 109.99/106.52 MiB/s.
- 64 MiB transfer including BLAKE3 and durable ACK measured 37.98 MiB/s with legacy 4 MiB groups and 73.62 MiB/s with 16 MiB groups. Final hashes and mismatch rejection passed. Synthetic network/file tests do not establish sustained installation speed or isolated SSD speed.
- Real Avatar on 019 advanced 761,990,037 bytes in 20.158 s (about 36.1 MiB/s), alongside NAS reads. This is a different path and workload from the synthetic benchmark.
- Partial-body hardware test retained the prior 4 MiB durable prefix, returned retryable HTTP 408, kept the same process, resumed and verified the 20 MiB fixture. Only journaled synthetic fixtures were removed.
- Both installed Windows console-setup ELF copies updated to 020 with backups; native application hashes unchanged.
- Installed Windows WEB updated with a fix to refresh readiness when a speed job completes. Queue ID and transfer ID retained with 157303047666 durable Avatar bytes at update pause. No application installation was replayed.
- Physical Ethernet unplug/replug has not yet been repeated after these changes; partial TCP interruption is separately tested. No full Avatar registration/launch claim.

Installed WEB Playwright check: all four modes at 256 MiB, refresh readiness after completion, close/reopen with retained results, no page errors PASS. Latest WEB network 110.2 / 109.0 MiB/s; combined network/file 103.0 MiB/s (864 Mbit/s).

Queue resume re-counted completed files before reaching the retained durable position, then advanced beyond 157303047666 bytes. This re-count is not network retransmission; initial progress jumps must be excluded from throughput samples. A later 10-second mixed-file interval was approximately 28 MiB/s, so no whole-game speed improvement is claimed from synthetic results.
