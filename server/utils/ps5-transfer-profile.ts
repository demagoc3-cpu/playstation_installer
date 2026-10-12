import type { Ps5TransferProfile } from '../../shared/types/console-speed'
/** Optional telemetry cannot weaken ACK validation or break legacy transfers. */
export function ps5TransferProfile(reply: any, offset: number, bytes: number, now = Date.now()): Ps5TransferProfile | undefined {
  const p = reply?.profile
  if (!p || p.schemaVersion !== 1 || !['portable', 'sse2'].includes(p.hashMode) || p.replay !== false || p.streamingHash !== true || p.offset !== offset || p.bytes !== bytes || bytes < 1048576 || bytes > 134217728 || reply.bytesDurable !== offset + bytes) return
  const phases = ['elapsedMs', 'receiveWaitMs', 'writeMs', 'hashMs', 'syncMs', 'checkpointMs', 'stateMs'] as const
  if (phases.some(k => typeof p[k] !== 'number' || !Number.isFinite(p[k]) || p[k] < 0 || p[k] > 3600000) || p.elapsedMs <= 0 || phases.slice(1).reduce((n,k) => n + p[k], 0) > p.elapsedMs + 1) return
  return { measuredAt: now, bytes, hashMode: p.hashMode, ...Object.fromEntries(phases.map(k => [k, p[k]])) } as Ps5TransferProfile
}
