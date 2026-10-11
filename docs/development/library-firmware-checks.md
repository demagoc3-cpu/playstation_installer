# Library metadata and firmware checks — 2026-10-11

- WEB game branches show compact platform, format and FW tags below the title beside the cover. Title ID and individual versions appear only in expanded package rows and the details popover.
- Package rows show Title ID, package version and a FW tag from indexed PARAM metadata. Existing platform/format tags and details remain available.
- Shared numeric firmware assessment checks the declared minimum and SDK independently, retaining the PS4 DLC exception and explicit zero minimum for homebrew.
- PS5 batch admission reads current source PARAM before persisting any new items. PKG, Folder, UFS2, exFAT, PFS and FFPFSC all use bounded metadata reads. Folder checks do not walk the game directory or hash it. Cover reads are disabled for firmware checks.
- The PS5 queue driver reads live firmware from the connected service and actual source PARAM before hashing/transmission, including pending jobs recovered after WEB restart. Missing live firmware waits; incompatible or unreadable requirements stop dispatch. Source Title ID, Content ID and package version must match the selection.
- Already accepted installations continue receipt reconciliation without reopening sources or resubmitting jobs.
- PS4 PyLoader now performs the same firmware check as the service sender. It requires the PS4 service's system info; missing live information pauses new transmission.
- PS4 requirements are not compared numerically to PS5 firmware for compatibility-mode packages; the PS5 system installer retains that check. No backport compatibility is inferred from release labels, Title ID or an online database.

## Validation

`pnpm build` passed. Tests passed for firmware assessment, package metadata, game details, production PS4 queue scenarios, multi-device dispatch, PS5 queue/recovery/readiness, folders, all image formats, and the new PARAM firmware gate. Additional PyLoader scenarios cover rejection and missing firmware recovery. Synthetic sources exercise stale indexes, higher PARAM or SDK requirements, unknown requirements, zero requirements, changed versions and unreadable metadata with no console writes.

Browser check of a separate fixture library confirmed individual CUSA/PPSA/game/patch versions and FW tags. The follow-up layout places tags below the title without adding row height. Screenshot: `/tmp/pf-library-firmware-check/library-tags-under-title.png`.

No WEB commit/push, live WEB restart, native PS5 application changes or real-console installation was performed.
