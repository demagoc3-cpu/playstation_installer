import { getPackageDelivery, getPackageIconStream, getPackageStream, recordPackageDelivery } from '../../utils/package-library'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') || ''
  const asset = getQuery(event).asset
  if (asset === 'delivery') return getPackageDelivery(id)
  if (asset === 'icon') {
    setHeader(event, 'Content-Type', 'image/png')
    setHeader(event, 'Cache-Control', 'private, max-age=3600')
    return sendStream(event, getPackageIconStream(id))
  }
  const initial = getPackageStream(id)
  const { item } = initial
  const range = getHeader(event, 'range')
  setHeader(event, 'Content-Type', 'application/octet-stream')
  setHeader(event, 'Accept-Ranges', 'bytes')
  setHeader(event, 'Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(item.fileName)}`)
  if (!range) {
    setHeader(event, 'Content-Length', String(item.size))
    initial.stream.once('end', () => recordPackageDelivery(id, 0, item.size - 1, true))
    return sendStream(event, initial.stream)
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim())
  if (!match) throw createError({ statusCode: 416, statusMessage: 'Некорректный диапазон файла' })
  const start = match[1] ? Number(match[1]) : 0
  const requestedEnd = match[2] ? Number(match[2]) : item.size - 1
  const end = Math.min(requestedEnd, item.size - 1)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= item.size) {
    setHeader(event, 'Content-Range', `bytes */${item.size}`)
    setResponseStatus(event, 416)
    return ''
  }
  setResponseStatus(event, 206)
  setHeader(event, 'Content-Range', `bytes ${start}-${end}/${item.size}`)
  setHeader(event, 'Content-Length', String(end - start + 1))
  const response = getPackageStream(id, { start, end }).stream
  response.once('end', () => recordPackageDelivery(id, start, end, start === 0 && end === item.size - 1))
  return sendStream(event, response)
})
