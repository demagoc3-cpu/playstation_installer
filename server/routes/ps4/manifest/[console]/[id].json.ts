import manifest from '../../../json/[id].json'
import { inConsoleScope, legacyConsoleIp } from '../../../../utils/console-scope'

export default defineEventHandler(event => {
  const match = /^\/ps4\/manifest\/([^/]+)\/[^/]+\.json$/.exec(getRequestURL(event).pathname)
  if (!match) throw createError({ statusCode: 404, message: 'Invalid PS4 manifest URL' })
  return inConsoleScope(match[1] === 'legacy' ? legacyConsoleIp() : match[1], () => manifest(event))
})
