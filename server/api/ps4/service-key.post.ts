import { saveServiceKey } from '../../utils/ps4-service-installer'
import { assertInstallationOrigin } from '../../utils/installation-origin'
import { getLocalIp } from '../../utils/ps4-installer'
import { serviceWebAddress } from '../../utils/service-web-address'
import { ps4ServiceIp } from '../../utils/ps4-service'
import { getRequestURL } from 'h3'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody<{ ip?: string; code?: string }>(event)
  const ip = ps4ServiceIp(body?.ip)
  if (!ip) throw createError({ statusCode: 400, message: 'Укажите корректный IPv4-адрес PS4' })
  const port = process.env.PACKAGEFLOW_PUBLIC_PORT || getRequestURL(event).port || process.env.PORT || '3000'
  const webUrl = serviceWebAddress(await getLocalIp(ip), port)
  return saveServiceKey(ip, body?.code, webUrl)
})
