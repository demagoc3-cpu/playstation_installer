import type { InstalledCheck } from './installed-package-check'

export type DesktopAppRetry = 'active' | 'unconfirmed' | 'installed' | 'absent' | 'different-version' | 'unavailable'

// A completed WEB receipt never proves that the application still exists.
// Reuse the original request until its exact attempt is known to have ended;
// only a fresh console snapshot proving absence permits another request ID.
export async function desktopAppRetryState(attempt: { state: string } | undefined, read: () => Promise<InstalledCheck>): Promise<DesktopAppRetry> {
  if (!attempt || attempt.state === 'unconfirmed') return 'unconfirmed'
  if (!['installed', 'failed', 'skipped', 'cancelled'].includes(attempt.state)) return 'active'
  const current = await read()
  return current.state === 'base-present' ? 'different-version' : current.state
}
