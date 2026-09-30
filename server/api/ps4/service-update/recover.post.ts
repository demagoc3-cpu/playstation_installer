import { replaceStalledUpdate } from '../../../utils/console-maintenance'
import { getLocalIp } from '../../../utils/ps4-installer'
import { assertInstallationOrigin } from '../../../utils/installation-origin'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  const pc = await getLocalIp(String(body?.ip || ''))
  const port = getRequestURL(event).port || '3000'
  return replaceStalledUpdate(body?.ip, String(body?.artifactId || ''), `http://${pc}:${port}`)
})
