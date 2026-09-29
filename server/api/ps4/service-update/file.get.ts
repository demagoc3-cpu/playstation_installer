import { createReadStream } from 'node:fs'
import { serviceArtifact } from '../../../utils/service-updates'
export default defineEventHandler(event => {
  const a = serviceArtifact(String(getQuery(event).id || '')); const range = getHeader(event, 'range')
  setHeader(event, 'Content-Type', 'application/octet-stream'); setHeader(event, 'Accept-Ranges', 'bytes'); setHeader(event, 'Cache-Control', 'no-store')
  if (!range) { setHeader(event, 'Content-Length', a.size); return sendStream(event, createReadStream(a.path)) }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range)
  if (!match || (!match[1] && !match[2])) throw createError({ statusCode: 416, message: 'Неверный диапазон PKG' })
  const start = match[1] ? Number(match[1]) : Math.max(0, a.size - Number(match[2])); const end = Math.min(match[1] && match[2] ? Number(match[2]) : a.size - 1, a.size - 1)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= a.size) throw createError({ statusCode: 416, message: 'Неверный диапазон PKG' })
  setResponseStatus(event, 206); setHeader(event, 'Content-Length', end - start + 1); setHeader(event, 'Content-Range', `bytes ${start}-${end}/${a.size}`)
  return sendStream(event, createReadStream(a.path, { start, end }))
})
