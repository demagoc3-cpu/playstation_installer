import { bootstrapService } from '../../utils/service-bootstrap'
import { getLocalIp } from '../../utils/ps4-installer'
import { assertInstallationOrigin } from '../../utils/installation-origin'
import { assertDesktopControl } from '../../utils/desktop-control'
import { ps4ServiceIp } from '../../utils/ps4-service'

export default defineEventHandler(async event => {
  assertDesktopControl(event)
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  const ip = ps4ServiceIp(body?.ip)
  if (!ip) throw createError({ statusCode: 400, message: 'Укажите IP PS4' })
  const pc = await getLocalIp(ip)
  return bootstrapService(ip, String(body?.artifactId || ''), `http://${pc}:${getRequestURL(event).port || '3000'}`)
})
