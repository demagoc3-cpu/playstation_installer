# Troubleshooting and logs

[← Contents](index.md) · [Русский](../ru/troubleshooting.md)

WEB → Log shows console connections, package/manifest requests, transfer failures, per-package results, qBittorrent and API errors. Warning/error counts appear beside its menu item.

| Symptom | Check |
|---|---|
| PS4 disconnected | Correct IP, PS4 awake, HEN active, PackageFlow running; PyLoader fallback at `http://<PS4-IP>:9090/status` |
| Service unavailable at 12801 | Launch the app and check the service; PS4 may be in rest mode |
| Pairing fails | Obtain a new five-minute code in Connections; use Pair again after IP/key changes |
| Old client rejected after revocation | Re-pair; the revoked key intentionally stays invalid after reboot |
| Payload return timeout | Allow trusted LAN traffic through the PC firewall; check subnet/VLAN routes |
| PS4 cannot download an accepted task | WEB must bind to an accessible LAN address; allow TCP 3000 |
| New task blocked by an older download | Inspect Notifications → Downloads on PS4 before retrying |
| Firmware incompatibility | Use compatible packages/backports; do not treat transfer completion as successful installation |
| PKG missing or invalid | Check file completeness, permissions, mounted folder and its metadata |
| `/games` empty in Docker | Mount the real host game directory to `/games`; scan the container path, not the host path |
| Torrent finished but not imported | Check qBittorrent's path mapping and whether WEB can read the actual files |
| Native PS4 status unknown | The service could not verify base-game presence; it is not a negative installed result |
| Native connection lost | The displayed progress is the last received snapshot; check WEB/network/Tasks |
| Revoke pairing refuses | Finish/cancel installations/removals and finish file uploads, including paused transfers |
| System keyboard unavailable | Fallback input is available; report firmware, PKG version and the exact message |

A service journal failure blocks writes to avoid repeating an uncertain installation. Do not delete service journals to force a retry. Preserve WEB data and report the error/version. If primary installation history is damaged, a validated backup is used; if both are damaged installation remains disabled.
