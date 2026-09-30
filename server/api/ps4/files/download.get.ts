import { Readable } from 'node:stream'
import { consoleFilePath, consoleFileRead, consoleFileRequest } from '../../../utils/ps4-service-installer'

interface FileStat { type: string; size: number; mtime: number }
export default defineEventHandler(async event => {
  const query = getQuery(event)
  const ip = String(query.ip || '')
  const path = consoleFilePath(query.path)
  const stat = await consoleFileRequest(ip, 'stat', { path }) as FileStat
  if (stat?.type !== 'file' || !Number.isSafeInteger(stat.size) || stat.size < 0)
    throw createError({ statusCode: 400, message: 'Выберите обычный файл' })
  const range = getHeader(event, 'range')
  let start = 0, end = stat.size - 1
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim())
    if (!match || (!match[1] && !match[2])) throw createError({ statusCode: 416, message: 'Неверный диапазон файла' })
    start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]))
    end = match[1] && match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size)
      throw createError({ statusCode: 416, message: 'Диапазон за пределами файла' })
    setResponseStatus(event, 206)
    setHeader(event, 'Content-Range', `bytes ${start}-${end}/${stat.size}`)
  }
  setHeader(event, 'Content-Type', 'application/octet-stream')
  setHeader(event, 'Accept-Ranges', 'bytes')
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'Content-Length', Math.max(0, end - start + 1))
  setHeader(event, 'Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.split('/').at(-1) || 'console-file')}`)
  const stream = Readable.from((async function* () {
    for (let offset = start; offset <= end; ) {
      const expected = Math.min(256 * 1024, end - offset + 1)
      const chunk = await consoleFileRead(ip, path, offset, expected)
      if (chunk.length !== expected) throw new Error('PS4 изменила файл во время передачи')
      yield chunk
      offset += chunk.length
    }
  })())
  return sendStream(event, stream)
})
