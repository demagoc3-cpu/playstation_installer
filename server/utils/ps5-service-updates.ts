import { createHash, randomBytes } from 'node:crypto'
import { createConnection } from 'node:net'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createError } from 'h3'
import { dataPath } from './data-path'
import { writeDurableJson } from './durable-json'
import { getConsoleProfile, ps5OperationRequest, ps5ServiceRequest } from './console-profiles'
import { runPs5ServiceUpdate, type Ps5ServiceUpdateFlow, type UpdateConnection } from './ps5-service-update-driver'

const running = new Set<string>()
const folder = () => dataPath('ps5-service-updates')
const flowFile = (id: string) => resolve(folder(), `${id}.json`)
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 1000))
function release() {
  try {
    const value = JSON.parse(readFileSync(resolve(folder(), 'release.json'), 'utf8'))
    if (value.service !== 'PackageFlowService-PS5' || !/^\d+\.\d+\.\d+(?:-dev)?$/.test(value.version) || !/^[a-z0-9-]{1,64}$/.test(value.buildId) || !/^[a-f0-9]{64}$/.test(value.sha256)
      || value.fileName !== 'PackageFlowService-PS5.elf' || value.firmware !== '13.60') throw new Error('Invalid service artifact')
    const bytes = readFileSync(resolve(folder(), value.fileName))
    if (bytes.length < 4096 || bytes.length > 4 * 1024 * 1024 || !bytes.subarray(0, 6).equals(Buffer.from('7f454c460201', 'hex')) || bytes.readUInt16LE(18) !== 62
      || createHash('sha256').update(bytes).digest('hex') !== value.sha256) throw new Error('Service ELF changed')
    return { ...value, bytes }
  } catch { return null }
}
function profile(id: unknown) { const p = getConsoleProfile(id); if (p.platform !== 'ps5') throw createError({ statusCode: 400, message: 'Это обновление предназначено только для PS5' }); return p }
function saved(id: string): Ps5ServiceUpdateFlow | null {
  if (!existsSync(flowFile(id))) return null
  try {
    const value = JSON.parse(readFileSync(flowFile(id), 'utf8'))
    if (value.consoleId !== id || !/^[a-f0-9]{32}$/.test(value.id) || !/^[a-f0-9]{64}$/.test(value.sha256) || typeof value.ip !== 'string' || typeof value.version !== 'string' || typeof value.buildId !== 'string' || !Number.isSafeInteger(value.startedAt) || !['preparing','stopping','sending','verifying','completed','failed','unconfirmed'].includes(value.state)) throw new Error('Invalid journal')
    return value
  } catch { throw createError({ statusCode: 503, message: 'Не удалось прочитать журнал обновления. Повтор не отправлен.' }) }
}
function idle(id: string) {
  const path = dataPath('consoles', id, 'ps5-installation-queue.json')
  if (!existsSync(path)) return true
  try { const queue = JSON.parse(readFileSync(path, 'utf8')); return queue.consoleId === id && ['idle','completed','failed','cancelled'].includes(queue.status) && Array.isArray(queue.items) && queue.items.every((item: any) => ['installed','failed','skipped','cancelled'].includes(item.state)) }
  catch { return false }
}
function loader(ip: string): Promise<UpdateConnection> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: ip, port: 9021 }), timer = setTimeout(() => { socket.destroy(); reject(new Error('Загрузчик ELF PS5 не ответил')) }, 4000)
    socket.once('error', reject)
    socket.once('connect', () => {
      clearTimeout(timer); socket.setTimeout(15000, () => socket.destroy(new Error('Таймаут передачи ELF')))
      resolve({ close: () => socket.destroy(), send: data => new Promise((done, fail) => { socket.once('error', fail); socket.end(data, () => { socket.off('error', fail); done() }) }) })
    })
    socket.once('close', () => clearTimeout(timer))
  })
}
export function ps5ServiceUpdateInfo(id: unknown) {
  const p = profile(id), candidate = release(), flow = saved(p.id)
  return { consoleId: p.id, current: p.version || '', release: candidate ? { version: candidate.version, buildId: candidate.buildId, sha256: candidate.sha256, firmware: candidate.firmware } : null,
    flow, message: candidate ? 'Подготовлено обновление фоновой службы PS5' : 'На этом WEB пока нет проверенного обновления службы PS5' }
}
export function assertNoPs5ServiceUpdate(id: string) {
  const previous = saved(id)
  if (running.has(id) || previous && !['completed','failed'].includes(previous.state)) throw createError({ statusCode: 409, message: 'Обновление службы PS5 ещё не подтверждено. Новая установка не отправлена.' })
}
export async function beginPs5ServiceUpdate(id: unknown) {
  const p = profile(id), candidate = release(), previous = saved(p.id)
  if (!candidate) throw createError({ statusCode: 409, message: 'Проверенный ELF службы PS5 не подготовлен' })
  if (!p.verified || p.firmware !== candidate.firmware) throw createError({ statusCode: 409, message: 'Обновление ещё не подтверждено для прошивки этого устройства' })
  if (running.has(p.id) || previous && !['completed','failed'].includes(previous.state)) throw createError({ statusCode: 409, message: 'Проверьте результат предыдущего обновления. Повтор не отправлен.' })
  const flow: Ps5ServiceUpdateFlow = { id: randomBytes(16).toString('hex'), consoleId: p.id, ip: p.ip, version: candidate.version, buildId: candidate.buildId, sha256: candidate.sha256,
    state: 'preparing', message: 'Проверяем готовность службы PS5', startedAt: Date.now() }
  const save = (value: Ps5ServiceUpdateFlow) => writeDurableJson(flowFile(p.id), value)
  save(flow); running.add(p.id)
  void runPs5ServiceUpdate(flow, candidate.bytes, { save, idle: () => idle(p.id), pause,
    request: (path, headers) => ps5OperationRequest(p.id, path as Parameters<typeof ps5OperationRequest>[1], headers),
    health: () => ps5ServiceRequest(p.ip, '/health'), connect: () => loader(p.ip) }).finally(() => running.delete(p.id))
  return ps5ServiceUpdateInfo(p.id)
}
