export interface Ps4SystemSnapshot {
  ready: boolean
  ip: string
  version?: string
  pkgVersion?: string
  environment?: 'ps4' | 'host'
  reason?: string
  updateRequired: boolean
  issues: string[]
  system: { firmware: string | null; model: string | null; modelFamily: string | null; henName: string | null; henVersion: string | null; henSdk: string | null;
    filesystemAccess: { enabled: boolean; error: number | null } | null } | null
  storage: { id: string; path: string; available: boolean; totalBytes: number | null; freeBytes: number | null; availableBytes: number | null; usedBytes: number | null;
    error: number | null; errorHex: string | null; stage: string | null; errno: number | null }[] | null
  runtime: { uptimeSeconds: number; requests: number; replies: number } | null
}
