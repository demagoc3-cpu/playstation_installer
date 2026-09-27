import { Transform } from 'node:stream'
import type { ReadStream } from 'node:fs'
import type { H3Event } from 'h3'
import { getPackage, getPackageDelivery, getPackageIconStream, getPackageStream, isDeliveryBlocked, recordPackageDelivery, recordPackageRequest, registerActiveTransfer } from '../../utils/package-library'

const debug = Boolean(process.env.PACKAGEFLOW_DEBUG)
const PROGRESS_INTERVAL_MS = 500
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} МБ`

/**
 * Streams a byte range to the console and tracks what was actually handed to
 * the socket (a counting Transform respects backpressure, unlike a 'data'
 * listener on the file). Progress is recorded while the range streams, so a
 * single multi-gigabyte BGFT range is visible before it ends. If the console
 * drops the connection, it is logged with the byte count. Bookkeeping errors
 * never break the transfer.
 */
function streamRange(event: H3Event, file: ReadStream, id: string, fileName: string, start: number, end: number, completed: boolean) {
  const record = (last: number, done: boolean) => {
    if (last < start) return
    try { recordPackageDelivery(id, start, last, done) } catch (error) { console.warn('[PackageFlow] Не удалось записать прогресс передачи:', error) }
  }
  const expected = end - start + 1
  let sent = 0
  let reportedAt = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sent += chunk.length
      const now = Date.now()
      if (now - reportedAt >= PROGRESS_INTERVAL_MS) { reportedAt = now; record(start + sent - 1, false) }
      callback(null, chunk)
    }
  })
  const response = event.node.res
  const unregister = registerActiveTransfer(id, () => response.destroy())
  response.once('close', () => {
    unregister()
    if (response.writableFinished) { record(end, completed); return }
    file.destroy()
    if (isDeliveryBlocked(id)) { console.log(`[PackageFlow] Передача «${fileName}» остановлена: установка отменена`); return }
    record(start + sent - 1, false)
    console.warn(`[PackageFlow] PS4 оборвала загрузку «${fileName}»: диапазон ${start}-${end}, отдано ${mb(sent)} из ${mb(expected)}`)
  })
  file.once('error', (error) => { console.warn(`[PackageFlow] Ошибка чтения PKG ${fileName} (${start}-${end}):`, error); counter.destroy(error) })
  return sendStream(event, file.pipe(counter))
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
  if (isDeliveryBlocked(id)) throw createError({ statusCode: 410, statusMessage: 'Installation cancelled' })
  const range = getHeader(event, 'range')
  recordPackageRequest(id)
  if (debug) console.log(`[PackageFlow] PS4 запрашивает «${item.fileName}» ${range || 'целиком'}`)
  setHeader(event, 'Content-Type', 'application/octet-stream')
  setHeader(event, 'Accept-Ranges', 'bytes')
  setHeader(event, 'Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(item.fileName)}`)

  if (!range) {
    setHeader(event, 'Content-Length', item.size)
    return streamRange(event, getPackageStream(id).stream, id, item.fileName, 0, item.size - 1, true)
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
  setHeader(event, 'Content-Length', end - start + 1)
  return streamRange(event, getPackageStream(id, { start, end }).stream, id, item.fileName, start, end, start === 0 && end === item.size - 1)
})
