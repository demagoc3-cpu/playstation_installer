import type { Ps4SystemSnapshot } from '../../shared/types/ps4-system'

type JsonObject = Record<string, unknown>
type ServicePath = '/ping' | '/system/info' | '/storage' | '/status'
interface ServiceReply { status: number; body: unknown }
type Reader = (ip: string, path: ServicePath) => Promise<ServiceReply>

export function localPs4Ip(value: unknown): string | null {
  if (typeof value !== 'string' || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return null
  const parts = value.split('.').map(Number)
  const [first, second] = parts
  if (parts.some(part => part < 0 || part > 255)) return null
  if (!(first === 10 || (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) || (first === 169 && second === 254))) return null
  return parts.join('.')
}

export const readPs4Service: Reader = async (ip, path) => {
  // Fixed port and paths; never follow redirects from a device to another host.
  const response = await fetch(`http://${ip}:12801${path}`, { signal: AbortSignal.timeout(3000), redirect: 'error' })
  if (!response.body) throw new Error('Empty response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 16384) throw new Error('Service response too large')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return { status: response.status, body: JSON.parse(new TextDecoder().decode(bytes)) }
}

function object(value: unknown): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function text(value: unknown): string | null { return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function identity(reply: ServiceReply, version?: string): reply is ServiceReply & { body: JsonObject } {
  return reply.status === 200 && object(reply.body) && reply.body.service === 'PackegeFlowService' &&
    (!version || reply.body.version === version)
}

export async function getPs4SystemSnapshot(ip: string, read: Reader = readPs4Service): Promise<Ps4SystemSnapshot> {
  const snapshot: Ps4SystemSnapshot = { ready: false, ip, updateRequired: false, issues: [], system: null, storage: null, runtime: null }
  const paths: ServicePath[] = ['/ping', '/system/info', '/storage', '/status']
  const results = await Promise.allSettled(paths.map(path => read(ip, path)))
  const replies = results.map(result => result.status === 'fulfilled' ? result.value : null)
  const ping = replies[0]
  if (!ping || !identity(ping) || ping.body.status !== 'ok') {
    snapshot.reason = ping ? 'Сервис ответил неожиданными данными' : 'Сервис не отвечает на порту 12801'
    return snapshot
  }
  snapshot.ready = true
  snapshot.version = text(ping.body.version) || undefined
  const [info, storage, status] = replies.slice(1)
  snapshot.updateRequired = [info, storage, status].some(reply => reply?.status === 404)
  if (snapshot.updateRequired) snapshot.issues.push('Обновите PackegeFlowService на PS4 до PKG 1.02 или новее.')
  if (info && identity(info, snapshot.version) && (info.body.environment === 'ps4' || info.body.environment === 'host') &&
    object(info.body.firmware) && object(info.body.model) && object(info.body.hen)) {
    snapshot.environment = info.body.environment
    snapshot.pkgVersion = text(info.body.pkgVersion) || undefined
    snapshot.system = {
      firmware: text(info.body.firmware.version), model: text(info.body.model.name),
      henName: text(info.body.hen.name), henVersion: text(info.body.hen.version),
    }
  } else if (!snapshot.updateRequired) snapshot.issues.push('Не удалось получить сведения о системе.')
  if (storage && identity(storage, snapshot.version) && Array.isArray(storage.body.volumes) && storage.body.volumes.length <= 8) {
    const volumes: NonNullable<Ps4SystemSnapshot['storage']> = []
    for (const volume of storage.body.volumes) {
      if (!object(volume) || !text(volume.id) || !text(volume.path) || typeof volume.available !== 'boolean') break
      const { totalBytes, freeBytes, availableBytes, usedBytes } = volume
      if (volume.available && (!integer(totalBytes) || totalBytes === 0 || !integer(freeBytes) || !integer(availableBytes) ||
        !integer(usedBytes) || freeBytes > totalBytes || availableBytes > freeBytes || usedBytes !== totalBytes - freeBytes)) break
      volumes.push({ id: volume.id as string, path: volume.path as string, available: volume.available,
        totalBytes: volume.available ? totalBytes as number : null, freeBytes: volume.available ? freeBytes as number : null,
        availableBytes: volume.available ? availableBytes as number : null, usedBytes: volume.available ? usedBytes as number : null })
    }
    if (volumes.length === storage.body.volumes.length && volumes.length > 0) snapshot.storage = volumes
  }
  if (!snapshot.storage && !snapshot.updateRequired) snapshot.issues.push('Не удалось получить сведения о диске.')
  if (status && identity(status, snapshot.version) && status.body.status === 'ok' && integer(status.body.uptimeSeconds) &&
    integer(status.body.requests) && integer(status.body.replies)) {
    snapshot.runtime = { uptimeSeconds: status.body.uptimeSeconds, requests: status.body.requests, replies: status.body.replies }
  } else if (!snapshot.updateRequired) snapshot.issues.push('Не удалось получить состояние сервиса.')
  return snapshot
}
