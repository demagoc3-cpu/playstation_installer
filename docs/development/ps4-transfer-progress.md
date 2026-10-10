# PS4 transfer progress in WEB

Task tree rows and table progress cells show transferred/total megabytes and
live speed for PS4 and PS5. Megabytes use the existing WEB convention of
1048576 bytes; totals round up, unfinished transferred counts round down.
Source-check phases display checked bytes and a separate tooltip.

PS4 queue writes sample downloadedBytes reported by PackageFlowService, or the
HTTP delivery's unique streamed ranges for PyLoader. The task API includes the
in-memory five-second rate while receiving, or while BGFT reports installing
but still has bytes to download. Local installation after the download is
complete has no network rate. Console, queue and dispatch/request identity
isolate attempts. Restart/resume uses existing bytes only as a new baseline.
Rates never enter queue/history JSON. Stalls and stale browser responses show
zero after five seconds. PS5 durable-ACK measurement remains unchanged.

Verification: production queue fixtures service-speed/payload-speed, parallel
console/resume/retry/stall/final-installation cases in transfer-speed.test.mjs,
existing queue/history/PS5 suites, Nuxt build. Browser fixture uses actual Vue
components in row/table and verifies `150 / 15 815 МБ`, the rate and stale zero;
it is a synthetic display test, not a hardware benchmark.
