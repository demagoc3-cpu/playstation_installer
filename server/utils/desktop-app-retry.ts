import type { InstalledCheck } from './installed-package-check'

export type DesktopAppRetry = 'active' | 'unconfirmed' | 'installed' | 'absent' | 'different-version' | 'different-build' | 'unavailable'

// A completed WEB receipt never proves that the application still exists.
// Reuse the original request until its exact attempt is known to have ended;
// only a fresh console snapshot proving absence permits another request ID.
export async function desktopAppRetryState(attempt: { state: string; confirmation?: string; alreadyPresent?: boolean } | undefined, read: () => Promise<InstalledCheck>, revision?: { recordedSha256: string; targetSha256: string; superseded?: boolean }): Promise<DesktopAppRetry> {
  if (!attempt || attempt.state === 'unconfirmed') return 'unconfirmed'
  if (!['installed', 'failed', 'skipped', 'cancelled'].includes(attempt.state)) return 'active'
  const current = await read()
  // The version in PARAM is not a build identity (two 044 images exist).
  // Only our completed, verified registration of this exact bundle proves it.
  if(current.state==='installed' && revision && (revision.superseded || revision.recordedSha256!==revision.targetSha256 || attempt.state!=='installed' || attempt.confirmation!=='service-registration' || attempt.alreadyPresent)) return 'different-build'
  return current.state === 'base-present' ? 'different-version' : current.state
}
