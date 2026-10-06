import { assertDesktopControl } from '../../utils/desktop-control'
import { assertDesktopWritable, trackDesktopRequest } from '../../utils/desktop-lifecycle'
import { updatePairedServiceWebAddress } from '../../utils/ps4-service-installer'
import { getLocalIp, getSavedPsIp } from '../../utils/ps4-installer'
import { ps4ServiceIp } from '../../utils/ps4-service'
import { serviceWebAddress } from '../../utils/service-web-address'
import { getRequestURL } from 'h3'

export default defineEventHandler(async event => {
  assertDesktopControl(event)
  assertDesktopWritable()
  const done = trackDesktopRequest()
  try {
    const body = await readBody<{ ip?: string }>(event)
    const ip = ps4ServiceIp(body?.ip || getSavedPsIp())
    if (!ip) return { updated: false, configured: false, message: 'PS4 ещё не настроена' }
    const port = process.env.PACKAGEFLOW_PUBLIC_PORT || getRequestURL(event).port || process.env.PORT || '3000'
    return await updatePairedServiceWebAddress(ip, serviceWebAddress(await getLocalIp(ip), port))
  } finally { done() }
})
