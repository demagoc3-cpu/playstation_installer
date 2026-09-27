import { logEvent } from './event-log'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { readJsonFile, writeJsonFile } from './json-store'
import { createSocket } from 'node:dgram'
import { createServer, connect, type Server, type Socket } from 'node:net'

interface InstallerSession {
  psIp: string
  server: Server
  port: number
  pcIp: string
  client?: Socket
}

let session: InstallerSession | undefined
const marker = Buffer.from([0xb4, 0xb4, 0xb4, 0xb4, 0xb4, 0xb4])

export interface PackageJob {
  url: string
  title: string
  contentId: string
  contentType: string
  size: number
  iconData?: Buffer
}

function assertIp(ip: string) {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) throw createError({ statusCode: 400, message: 'Укажите корректный IPv4-адрес консоли' })
}

async function timeoutFetch(url: string) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2500)
  try { return await fetch(url, { signal: controller.signal }) } finally { clearTimeout(timer) }
}

const settingsPath = resolve(process.cwd(), '.data/ps4.json')

/** Last console IP the user connected to; survives page reloads and server restarts. */
export function getSavedPsIp() {
  const ip = readJsonFile<{ ip?: string }>(settingsPath, {}).ip || ''
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) ? ip : ''
}

export function savePsIp(psIp: string) {
  assertIp(psIp)
  if (getSavedPsIp() !== psIp) writeJsonFile(settingsPath, { ip: psIp })
}

export async function getGoldHenStatus(psIp: string) {
  assertIp(psIp)
  try {
    const response = await timeoutFetch(`http://${psIp}:9090/status`)
    const body = await response.json() as { status?: string }
    return { ready: response.ok && body.status === 'ready', status: body.status || 'unknown' }
  } catch { return { ready: false, status: 'offline' } }
}

export async function getLocalIp(remoteIp: string) {
  return await new Promise<string>((resolve, reject) => {
    const socket = createSocket('udp4')
    socket.once('error', reject)
    socket.connect(9090, remoteIp, () => {
      const address = socket.address()
      socket.close()
      if (typeof address === 'string') return reject(new Error('Не удалось определить LAN IP'))
      resolve(address.address)
    })
  })
}

function waitForClient(active: InstallerSession) {
  if (active.client && !active.client.destroyed) return Promise.resolve(active.client)
  return new Promise<Socket>((resolve, reject) => {
    const timer = setTimeout(() => reject(createError({ statusCode: 504, message: 'Payload не подключился к серверу за 12 секунд' })), 12000)
    active.server.once('connection-ready', (client: Socket) => { clearTimeout(timer); resolve(client) })
  })
}

async function loadPayload() {
  const candidates = [join(process.cwd(), 'public', 'ps4-pkg-installer.bin'), join(process.cwd(), '.output', 'public', 'ps4-pkg-installer.bin')]
  for (const file of candidates) {
    try { return await readFile(file) } catch { /* try next location */ }
  }
  throw createError({ statusCode: 500, message: 'Не найден payload установщика' })
}

async function sendPayload(psIp: string, payload: Buffer) {
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: psIp, port: 9090 })
    socket.setTimeout(3500)
    socket.once('connect', () => { socket.end(payload, resolve) })
    socket.once('timeout', () => { socket.destroy(); reject(createError({ statusCode: 504, message: 'PyLoader не ответил вовремя' })) })
    socket.once('error', reject)
  })
}

export async function startInstaller(psIp: string) {
  const status = await getGoldHenStatus(psIp)
  if (!status.ready) throw createError({ statusCode: 502, message: 'PyLoader/GoldHEN не готов на порту 9090' })
  if (session?.psIp === psIp && session.client && !session.client.destroyed) return { pcIp: session.pcIp, port: session.port, alreadyRunning: true }
  if (session) { session.client?.destroy(); session.server.close(); session = undefined }

  const pcIp = await getLocalIp(psIp)
  const server = createServer()
  const active = await new Promise<InstallerSession>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '0.0.0.0', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('Не удалось открыть локальный сервер'))
      resolve({ psIp, server, port: address.port, pcIp })
    })
  })
  server.on('connection', (client) => {
    client.setNoDelay(true)
    active.client = client
    client.once('close', () => { if (active.client === client) active.client = undefined })
    server.emit('connection-ready', client)
  })
  session = active

  const payload = await loadPayload()
  const offset = payload.indexOf(marker)
  if (offset < 0) throw createError({ statusCode: 500, message: 'Payload имеет неподдерживаемый формат' })
  const patched = Buffer.from(payload)
  Buffer.from(pcIp.split('.').map(Number)).copy(patched, offset)
  patched.writeUInt16BE(active.port, offset + 4)
  logEvent('info', `Отправляем payload на ${psIp}:9090; PS4 подключится к ${pcIp}:${active.port}`)
  await sendPayload(psIp, patched)
  await waitForClient(active)
  return { pcIp, port: active.port, alreadyRunning: false }
}

function writeText(chunks: Buffer[], value: string) {
  const data = Buffer.from(value, 'utf8'); const length = Buffer.allocUnsafe(4); length.writeUInt32LE(data.length); chunks.push(length, data)
}

export async function sendPackage(job: PackageJob) {
  if (!session) throw createError({ statusCode: 409, message: 'Сначала запустите установщик на консоли' })
  const client = await waitForClient(session)
  logEvent('info', `Задание для PS4: «${job.title}» → ${job.url}`)
  const chunks: Buffer[] = []
  const command = Buffer.allocUnsafe(4); command.writeUInt32LE(1); chunks.push(command)
  writeText(chunks, job.url); writeText(chunks, job.title); writeText(chunks, job.contentId); writeText(chunks, job.contentType)
  const size = Buffer.allocUnsafe(8); size.writeBigInt64LE(BigInt(Math.max(0, Math.floor(job.size)))); chunks.push(size)
  const iconData = job.iconData || Buffer.alloc(0)
  const iconLength = Buffer.allocUnsafe(4); iconLength.writeUInt32LE(iconData.length); chunks.push(iconLength, iconData)
  await new Promise<void>((resolve, reject) => client.write(Buffer.concat(chunks), (error) => error ? reject(error) : resolve()))
}
