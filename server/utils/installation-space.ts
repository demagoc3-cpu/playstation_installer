import { readPs4Service } from './ps4-service'

const MIB = 1024 ** 2
const GIB = 1024 ** 3

export type InstallSpace =
  | { state: 'enough'; availableBytes: number; requiredBytes: number }
  | { state: 'insufficient'; availableBytes: number; requiredBytes: number }
  | { state: 'unavailable' }

/** A small reserve is kept for system metadata and temporary installation files. */
export function requiredInstallSpace(packageBytes: number): number {
  if (!Number.isSafeInteger(packageBytes) || packageBytes <= 0) throw new Error('Неверный размер PKG')
  return packageBytes + Math.max(512 * MIB, Math.ceil(packageBytes * 0.05))
}

export function classifyInstallSpace(availableBytes: unknown, packageBytes: number): InstallSpace {
  if (typeof availableBytes !== 'number' || !Number.isSafeInteger(availableBytes) || availableBytes < 0) return { state: 'unavailable' }
  const requiredBytes = requiredInstallSpace(packageBytes)
  return { state: availableBytes >= requiredBytes ? 'enough' : 'insufficient', availableBytes, requiredBytes }
}

export async function checkPs4InstallSpace(ip: string, packageBytes: number): Promise<InstallSpace> {
  try {
    const reply = await readPs4Service(ip, '/storage')
    const body = reply.body as { service?: unknown; volumes?: unknown }
    if (reply.status !== 200 || body?.service !== 'PackegeFlowService' || !Array.isArray(body.volumes)) return { state: 'unavailable' }
    const internal = body.volumes.find((volume: any) => volume?.id === 'internal' && volume?.path === '/user')
    if (!internal || internal.available !== true) return { state: 'unavailable' }
    return classifyInstallSpace(internal.availableBytes, packageBytes)
  } catch { return { state: 'unavailable' } }
}

export function installSpaceMessage(space: InstallSpace): string {
  if (space.state === 'unavailable') return 'Не удалось проверить свободное место PS4. Ожидаем ответ службы перед установкой.'
  if (space.state === 'insufficient') return `Недостаточно места на PS4: доступно ${formatGiB(space.availableBytes)}, для PKG нужно около ${formatGiB(space.requiredBytes)} с резервом.`
  return `Доступно ${formatGiB(space.availableBytes)}; для PKG нужно около ${formatGiB(space.requiredBytes)}.`
}

function formatGiB(bytes: number): string { return `${(bytes / GIB).toFixed(1)} ГиБ` }
