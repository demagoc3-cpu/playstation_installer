# Storage — local folders, SMB, NFS and WebDAV

Storage is a shared WEB feature for PS4 and PS5. Protocols are generic: users
select a protocol when adding a source. No NAS vendor or DSM API is required.

## Behaviour

- `/api/storage` persists an unlimited list in the WEB data directory.
- Existing indexed roots and the existing qBittorrent downloads directory are
  adopted on first start without rescanning or changing package IDs.
- New sources connect and index in the background. Per-source connection,
  incremental reindex and full metadata rebuild are separate actions.
- Optional scheduled index interval: 5 minutes to 7 days. Restart reconnects
  sources; connection checks do not rescan the catalogue.
- Network mounts are read-only. Game files are read directly, never synchronized
  by copying entire games to the computer. WebDAV uses rclone VFS without a disk
  data cache; metadata and cover caches remain in the WEB data directory.
- Failed connection or partial index read preserves the last successful index.
  Successful reindex removes vanished files while preserving other sources,
  variants, accepted duplicate IDs and installation confirmations.
- Overlapping folders retain source ownership. Removing a source removes its
  catalogue membership, never its original files. Accepted IDs carry forward
  to an identical remaining copy.
- Disabling/removing/changing credentials refuses unresolved installation jobs
  and active file transfers. These checks read saved queues, without starting
  queue workers or asking a console to perform any action.
- Library and Settings link to Storage. qBittorrent chooses an existing enabled
  local storage; its optional remote path is a translation for a different host.
  Windows launcher source has no library folder picker or implicit full reindex.
  The old scan API remains compatible and adopts successfully scanned roots into
  the registry, including completed torrents under an existing source.

## Credentials

Passwords are AES-256-GCM encrypted with per-source authenticated data and a
random nonce. `storage-secrets.key` and the encrypted `storage-secrets.json` stay
in the persistent WEB data directory, outside replaceable builds. Linux files
have mode 0600; protect the Windows data directory using the Windows account ACL.
This is server-side encryption, not Windows DPAPI. Back up the key with the data.
Missing/corrupt keys fail explicitly; they are never silently replaced if secrets
exist. Browser responses contain only `hasPassword`; a blank edit retains the
saved password, explicit removal deletes it. No passwords are placed in URLs,
command arguments, logs or generated WEB release archives.

Windows SMB connection data is sent on stdin to a fixed PowerShell program using
WNetAddConnection2. Linux CIFS uses a temporary mode-0600 credentials file removed
in a finally block. WebDAV passwords go to rclone's stdin for obscuring, then to
the mount process environment, without writing a plaintext rclone config.

## Requirements on the computer running WEB

| Protocol | Windows | Linux |
|---|---|---|
| Local | Existing readable folder | Existing readable folder |
| SMB | Native Windows UNC / network provider | cifs-utils and permission to mount |
| NFS | NFS-Win + WinFsp; server export permits this computer | nfs-common and permission to mount |
| WebDAV | rclone + WinFsp | rclone + FUSE |

Windows sources use directory/UNC mounts, not one drive letter per source.
NFS-Win uses `\\nfs\host\path` and the server's UID/GID/export permissions rather
than an SMB password. Windows may reject multiple SMB logins to the same server
with different credentials; resolve conflicting Windows sessions instead of
silently disconnecting Explorer or another application's shares.

Linux mounts use private `.data/storage-mounts/<source-id>` directories. The
connector verifies source and filesystem ownership before reusing/unmounting a
mount. The WEB process needs OS mount permission; the application never invokes
an interactive sudo prompt or installs a privileged helper. Docker requires
mounted local folders and network mount/FUSE prerequisites inside the container.

A configured `PACKAGEFLOW_RCLONE` can point at a portable rclone binary; otherwise
rclone is found in PATH. Connections automatically retry in the background after
missing components become available. Helper software is not bundled in the WEB
archive and missing components are reported in the source status/form.

Primary references:
- [WNetAddConnection2](https://learn.microsoft.com/en-us/windows/win32/api/winnetwk/nf-winnetwk-wnetaddconnection2w)
- [mount.cifs](https://manpages.ubuntu.com/manpages/noble/man8/mount.cifs.8.html)
- [NFS-Win](https://github.com/winfsp/nfs-win)
- [rclone WebDAV](https://rclone.org/webdav/)
- [rclone mount](https://rclone.org/commands/rclone_mount/)
- [rclone obscure](https://rclone.org/commands/rclone_obscure/)

## Verification

`server/tests/storage-sources.test.mjs` covers migration, reindex/prune,
installation history, overlapping sources, duplicate fallback IDs, offline and
mid-read failure, passive queue guards, encryption/restart/missing key handling,
64 additional sources, per-source locks and scheduled reconnect/index behaviour.
Existing package index, offline NAS pagination/cover and multi-device installation
tests remain gates. Actual NFS/WebDAV/SMB server interoperability requires that
server's connection and export settings; host tests do not claim NAS validation.
