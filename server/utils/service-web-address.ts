import { randomUUID } from 'node:crypto'
import { createError } from 'h3'

export function serviceWebAddress(ip: string, port: string | number) {
  const numbers = ip.split('.').map(Number), p = Number(port)
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) || numbers.some(n => n > 255) || numbers[0]! < 1 || numbers[0]! >= 224 || numbers[0] === 127 || !Number.isInteger(p) || p < 1 || p > 65535)
    throw createError({ statusCode: 503, message: 'Не удалось определить доступный PS4 адрес WEB. Проверьте LAN IP и порт в настройках запуска.' })
  return `http://${ip}:${p}`
}

type Stat = { type?: string; revision?: string; identity?: string }
type Request = (route: string, body: Record<string, unknown>) => Promise<any>
/** Use the existing authenticated file API so already installed PKGs can receive a new host. */
export async function syncServiceWebAddress(url: string, request: Request, write: (id: string, bytes: Buffer) => Promise<unknown>) {
  const parsed = new URL(url)
  if (serviceWebAddress(parsed.hostname, parsed.port || 80) !== url) throw new Error('Invalid WEB address')
  const directory = '/data/PackageFlowUI', path = `${directory}/server-url.txt`, id = randomUUID()
  const stage = `${directory}/paired-web-${id}.txt`
  try { await request('mkdir', { path: directory }) } catch (e: any) { if (e?.statusCode !== 409) throw e }
  let previous: Stat | undefined
  try { previous = await request('stat', { path }) } catch (e: any) { if (e?.statusCode !== 404) throw e }
  if (previous && previous.type !== 'file') throw new Error('WEB preference is not a regular file')
  const bytes = Buffer.from(url + '\n')
  try {
    await request('upload/start', { path: stage, id, size: bytes.length })
    await write(id, bytes)
    await request('upload/finish', { id })
    if (previous) {
      const result = await request('replace', { path: stage, destination: path, revision: previous.revision, id })
      // Remove only the backup returned for this exact replacement. Keep it if cleanup fails.
      if (result.backup === `${path}.packageflow-backup-${id}`) {
        try { const backup = await request('stat', { path: result.backup }); await request('delete', { path: result.backup, revision: backup.revision, identity: backup.identity }) } catch { }
      }
    } else {
      const staged = await request('stat', { path: stage })
      await request('move', { path: stage, destination: path, revision: staged.revision })
    }
  } catch (error) {
    // Release our own upload slot on failure without touching the previous WEB URL.
    try { await request('upload/abort', { id }) } catch { }
    try { const leftover = await request('stat', { path: stage }); await request('delete', { path: stage, revision: leftover.revision, identity: leftover.identity }) } catch { }
    throw error
  }
}
