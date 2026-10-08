import { pairConsoleProfile, getConsoleProfile } from '../../utils/console-profiles'
import { assertInstallationOrigin } from '../../utils/installation-origin'
import { getLocalIp } from '../../utils/ps4-installer'
import { serviceWebAddress } from '../../utils/service-web-address'
import { getRequestURL } from 'h3'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event), profile = getConsoleProfile(body?.id)
  const port = process.env.PACKAGEFLOW_PUBLIC_PORT || getRequestURL(event).port || process.env.PORT || '3000'
  return pairConsoleProfile(profile.id, body?.code, serviceWebAddress(await getLocalIp(profile.ip), port))
})
