import { inConsoleScope, currentConsoleIp, legacyConsoleIp } from '../../utils/console-scope'
import { contentPlatform, contentFormat } from '../../../shared/content-platform'
import { logEvent } from '../../utils/event-log'
import { getPackage, isDeliveryBlocked, recordPackageRequest, recordPackageStartup } from '../../utils/package-library'

export default defineEventHandler((event) => inConsoleScope(currentConsoleIp() || getQuery(event).console?.toString() || legacyConsoleIp(), () => {
  const id = /\/([^/]+)\.json$/i.exec(event.path.split('?')[0]!)?.[1] || ''
  const requestedAt = performance.now(), requestedWallAt = Date.now()
  const item = getPackage(id)
  if (contentPlatform(item) !== 'ps4' || contentFormat(item) !== 'pkg') throw createError({ statusCode: 400, message: 'Этот манифест поддерживает только PKG PS4' })
  if (isDeliveryBlocked(id)) throw createError({ statusCode: 410, message: 'Installation cancelled' })
  const first = recordPackageStartup(id, 'manifest', requestedWallAt, performance.now() - requestedAt)
  recordPackageRequest(id)
  if (first) logEvent('info', `PS4 запросила манифест «${item.title}» (${item.fileName}); подготовка WEB ${(performance.now() - requestedAt).toFixed(1)} мс`)
  const host = getHeader(event, 'host')
  if (!host) throw createError({ statusCode: 400, message: 'Не удалось определить адрес сервера пакетов' })
  setHeader(event, 'Content-Type', 'application/json; charset=utf-8')
  setHeader(event, 'Cache-Control', 'no-store')
  return {
    originalFileSize: item.size,
    packageDigest: item.packageDigest,
    numberOfSplitFiles: 1,
    pieces: [{
      url: `http://${host}/ps4/package/${currentConsoleIp() || 'legacy'}/${item.id}.pkg`,
      fileOffset: 0,
      fileSize: item.size,
      hashValue: '0000000000000000000000000000000000000000',
    }],
  }
}))
