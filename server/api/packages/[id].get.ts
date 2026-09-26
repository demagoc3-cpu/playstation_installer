import type { ReadStream } from 'node:fs'
import { getPackage, getPackageDelivery, getPackageIconStream, getPackageStream, recordPackageDelivery, recordPackageRequest } from '../../utils/package-library'

const debug = Boolean(process.env.PACKAGEFLOW_DEBUG)
const PROGRESS_INTERVAL_MS = 500

/**
 * Tracks progress while the range streams, not only when it ends: BGFT may ask
 * for one multi-gigabyte range, which would otherwise look like "no download".
 * Bookkeeping errors never break the transfer.
 */
function trackDelivery(stream: ReadStream, id: string, start: number, end: number, completed: boolean) {
  const record = (last: number, done: boolean) => {
    try { recordPackageDelivery(id, start, last, done) } catch (error) { console.warn('[PackageFlow] Не удалось записать прогресс передачи:', error) }
  }
  let sent = 0
  let reportedAt = 0
  stream.on('data', (chunk: Buffer | string) => {
    sent += chunk.length
    const now = Date.now()
    if (now - reportedAt >= PROGRESS_INTERVAL_MS) { reportedAt = now; record(start + sent - 1, false) }
  })
  stream.once('end', () => record(end, completed))
  stream.once('close', () => { if (sent && start + sent - 1 < end) record(start + sent - 1, false) })
  stream.once('error', (error) => console.warn(`[PackageFlow] Ошибка чтения PKG ${id} (${start}-${end}):`, error))
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') || ''
  const asset = getQuery(event).asset
  if (asset === 'delivery') return getPackageDelivery(id)
  if (asset === 'icon') {
    setHeader(event, 'Content-Type', 'image/png')
    setHeader(event, 'Cache-Control', 'private, max-age=3600')
    return sendStream(event, getPackageIconStream(id))
  }

  const item = getPackage(id)
  const range = getHeader(event, 'range')
  recordPackageRequest(id)
  if (debug) console.log(`[PackageFlow] GET ${item.fileName} range=${range || 'full'}`)
  setHeader(event, 'Content-Type', 'application/octet-stream')
  setHeader(event, 'Accept-Ranges', 'bytes')
  setHeader(event, 'Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(item.fileName)}`)

  if (!range) {
    setHeader(event, 'Content-Length', String(item.size))
    const { stream } = getPackageStream(id)
    trackDelivery(stream, id, 0, item.size - 1, true)
    return sendStream(event, stream)
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim())
  if (!match) throw createError({ statusCode: 416, statusMessage: 'Некорректный диапазон файла' })
  // "bytes=-N" means the last N bytes of the file.
  const start = match[1] ? Number(match[1]) : Math.max(0, item.size - Number(match[2] || 0))
  const requestedEnd = match[1] && match[2] ? Number(match[2]) : item.size - 1
  const end = Math.min(requestedEnd, item.size - 1)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= item.size) {
    setHeader(event, 'Content-Range', `bytes */${item.size}`)
    setResponseStatus(event, 416)
    return ''
  }
  setResponseStatus(event, 206)
  setHeader(event, 'Content-Range', `bytes ${start}-${end}/${item.size}`)
  setHeader(event, 'Content-Length', String(end - start + 1))
  const { stream } = getPackageStream(id, { start, end })
  trackDelivery(stream, id, start, end, start === 0 && end === item.size - 1)
  return sendStream(event, stream)
})
