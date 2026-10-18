# Network Folder experiment

User authorized a network-play prototype on 2026-10-09 after requesting Git
checkpoints of the current working implementation. This document is the WEB
checkpoint before any network-play implementation.

## Preserved baseline

- WEB code: `e56040d17256e9648ff89050ec058deb6a68d940`.
- ELF code: `88c90aa`; hardware verification documented in `c27f97e` in
  `/home/developer/projects/PS/PackageFlowService-PS5`.
- Source BLAKE3 cache, bounded Folder verification pipeline, transfer speed and
  existing installation queues remain the working installation path.
- Native PS5 application belongs to Claude. Codex owns WEB and ELF.

## Experiment contract

Goal: read a PS5 Folder game from NAS at runtime without first copying the full
game to console storage. NAS-as-upload-source and streamed PKG installation do
not satisfy this goal.

First prove a console-visible network filesystem on the confirmed PS5 firmware
13.60, then random reads and game-sandbox visibility, then registration and
launch of one explicit test title. A desktop-readable NAS share alone is not
proof. No network-play capability or working UI action is advertised before
the backend and hardware path are verified.

The experiment must keep installation separate from attachment: no synthetic
completed installation receipts, no deletion or replacement of existing local
games, no guessed firmware offsets. Network mounts must have explicit ownership
and must survive closing the UI; their lifecycle cannot silently interrupt a
running game. Reuse paired authentication for future control APIs. Credentials
and console logs stay outside Git.

## First console gate

Two independent diagnostic ELFs ran on the confirmed PS5 13.60. Standard VFS
enumeration was unavailable (ENOENT); this is an unknown list, not proof that
the firmware contains no driver. A separate negative mount-parameter test gave
EINVAL for the nullfs control, and ENODEV for nfs/fusefs and an unknown-type
control. No mount succeeded; the temporary owned directory was removed; the
existing service009 remained running. Host fixtures and SDK builds passed.

Direct NFS/FUSE attachment is unavailable in this tested session. A verified
console network-VFS driver/activation path is required before a WEB mount
action can be implemented. Do not show a successful installation or a ready
network-play capability based on PC/NAS access. No production WEB runtime or
native UI was changed for this experiment.

The ELF implementation and next gates are in the PS5 repository's
`docs/network-folder.md` and `experiments/network-folder`. Private console
reports remain outside Git. No actual NAS-backed game launch is verified.

Current status: driver gate unresolved; no network mount backend deployed.
