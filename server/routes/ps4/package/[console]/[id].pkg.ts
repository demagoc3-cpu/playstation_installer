import download from '../../../../api/packages/[id].get'
import { inConsoleScope, legacyConsoleIp } from '../../../../utils/console-scope'
import { contentPlatform, contentFormat } from '../../../../../shared/content-platform'
import { getPackage } from '../../../../utils/package-library'

export default defineEventHandler(event => {
  const match = /^\/ps4\/package\/([^/]+)\/([^/]+)\.pkg$/.exec(getRequestURL(event).pathname)
  if (!match) throw createError({ statusCode: 404, message: 'Invalid PS4 package URL' })
  const item = getPackage(match[2]!)
  if (contentPlatform(item) !== 'ps4' || contentFormat(item) !== 'pkg') throw createError({ statusCode: 400, message: 'Этот маршрут поддерживает только PKG PS4' })
  event.context.params = { ...event.context.params, id: match[2]! }
  return inConsoleScope(match[1] === 'legacy' ? legacyConsoleIp() : match[1], () => download(event))
})
