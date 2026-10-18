# Automatic registration after PS5 publication — 2026-10-14

Resident Evil 2 (PPSA04288,01.000.003) reached its full36340255601bytes and an exact `published` Folder receipt. The sending WEB was192.168.0.11; its user stopped observation before registration. Current exact Folder receipt, system registration and both live WEB catalogs now report the game registered. No RE2 files were resent, replaced or removed.

The source folder publisher previously relied on ordinary ShadowMount scanning. The root did not explicitly enqueue its newly published source. A second relevant cause was visible in the PS5 log: PackageFlow PPSA95001 ran16:54–17:28 console time, spanning publication17:04 and the two-minute timeout. ShadowMount's scanner deliberately defers during any active app. Hooks were installed; no missing-hook diagnosis or restart was needed in this session.

## Change

Root027 hands only receipt-owned canonical paths to fixed loopback `POST /api/v1/manual/add`. SMP serializes the list update and queues a scan for a new entry. An already-listed source gets one non-resetting `scan`. An add intent is durable before dispatch, unknown replies are reconciled through `manual/list`, scans are not replayed, and status GETs stay read-only. The root never writes raw manual.lst/app.db, starts a game or overrides SMP's active-game protection. Exact registered proof is still required; queue acceptance alone cannot mark installed.

WEB Folder and image wait logic distinguishes an active PS5 app from failed registration. The first publication time stays intact; the idle timeout starts after the app closes. A missing activity response cannot extend waiting indefinitely. Older roots keep their original timeout behavior. An explicitly stopped observation is preserved.

## Validation

- Full root host suite and SDK build pass. WEB40 relevant tests and production/Windows build pass.
- Real PS5 Slim13.60, pinned ShadowMountPlus1.7-beta5fix1, root027 PID103: own Folder95071, UFS295072, exFAT95073, PFS95074, FFPFSC95075 all transferred once, mounted/registered by SMP, exact Sony registration and catalog content/version01.000.042 confirmed. Image mount/unmount layers and AppInstallAll result0 appear in the backend log.
- Own busy-app test: launch95071, publish95076 while active; correct waiting explanation; close the exact app instance; automatic registration succeeds with no resend.
- All six own sources were compared with their local file hashes before deletion through SMP storage jobs1–6; all completed with result0. Source deletion retains registrations, so the six exact owned titles were then uninstalled through SMP API by a one-shot helper after exact system Content ID/version checks. All six catalog lookups returned404 and manual.lst returned to its two original entries. Four own raw-image transfer copies were also verified and removed. User games, saves, SMP86 and kstuff85 preserved. No new gameplay/FPS claim.

## Candidate

Root027 SHA256 `920e5580b6ad765f8526196947eec7ae5c3f803c239884361d72b7ee6e4ee37a`, build `ps5-service-registration-handoff-027-sse2`; local root commit `b59d5ce` on `codex/ps5-registration-handoff-027`. WEB is not committed or pushed.

Windows1.10.16 installer105759429bytes, SHA256 `e0ba0c1e290cb3562ffb44a0111fece5c01fea0aae5a4fa83170e38ed5a21571`, includes root027, unchanged PS5 app044/5122c1f and PS42.14. No offline WebView2 Runtime, Docker or Compose. Windows1.10.16 was installed and launched on GAMEPAD-PC (100.86.206.80/192.168.0.5), exit0; exact bundle and desktop files verified, settings/keys/library/storage hashes preserved, console paired to027 and RE2 visible. The completed temporary installer task was removed. Installing the desktop fix on192.168.0.11 is a separate rollout; its old stopped RE2 task is not silently revived.

## Upstream review

- ShadowMountPlus branch1.7 commit98c5248, API manual/add, manual/list and scan: https://github.com/drakmor/ShadowMountPlus/blob/98c524890176c7b474fcb03387bec88c4a559861/docs/openapi.yaml
- PS5Upload7.0.22, commit01afdf8: its image handoff uses SMP manual.lst; folder register-after-upload calls its own registration helper. We use SMP's API instead of overwriting the list or adding a competing Sony registration path. No automatic DRM rewriting was imported.
- Releases7.0.15–7.0.22 include normal-image AMPR index regeneration, image conversion fixes and HDR/PNG changes. These are separate features, not evidence of a fix for this registration failure: https://github.com/phantomptr/ps5upload/blob/01afdf8926ede277b8369b0f1976f44825d0de36/CHANGELOG.md

Sanitized hardware summary: `evidence/ps5-registration-handoff-20261014.json`. Private journals, source packages and tokens remain outside Git.
