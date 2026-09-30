import { serviceArtifact } from '../../../utils/service-updates'
import { logEvent } from '../../../utils/event-log'

export default defineEventHandler(event => {
  const id = /^\/service-update\/manifest\/([0-9a-f-]+)\.json$/.exec(getRequestURL(event).pathname)?.[1] || ''
  logEvent('info', `PS4 запросила манифест обновления ${id || '(неверный адрес)'}`)
  const a = serviceArtifact(id)
  const host = getHeader(event, 'host')
  if (!host) throw createError({ statusCode: 400, message: 'Нет адреса WEB' })
  setHeader(event, 'Content-Type', 'application/json; charset=utf-8')
  setHeader(event, 'Cache-Control', 'no-store')
  return { originalFileSize: a.size, packageDigest: a.packageDigest, numberOfSplitFiles: 1,
    pieces: [{ url: `http://${host}/service-update/package/${id}.pkg`, fileOffset: 0, fileSize: a.size, hashValue: '0000000000000000000000000000000000000000' }] }
})
