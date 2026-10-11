import { assertDesktopControl } from '../../utils/desktop-control'
import { assertDesktopWritable, trackDesktopRequest } from '../../utils/desktop-lifecycle'
import { updatePairedServiceWebAddress } from '../../utils/ps4-service-installer'
import { getLocalIp, getSavedPsIp } from '../../utils/ps4-installer'
import { ps4ServiceIp } from '../../utils/ps4-service'
import { serviceWebAddress } from '../../utils/service-web-address'
import { getRequestURL } from 'h3'
import { consoleProfileForIp, getConsoleProfiles, consolePairConfigured, updatePairedConsoleWebAddress } from '../../utils/console-profiles'

export default defineEventHandler(async event => {
  assertDesktopControl(event)
  assertDesktopWritable()
  const done = trackDesktopRequest()
  try {
    const body = await readBody<{ ip?: string; all?: boolean }>(event)
    if (body?.all === true) {
      const port = process.env.PACKAGEFLOW_PUBLIC_PORT || getRequestURL(event).port || process.env.PORT || '3000'
      const profiles = getConsoleProfiles().consoles.filter(p => consolePairConfigured(p.id))
      const results = []
      for (const p of profiles) {
        try { const r = await updatePairedConsoleWebAddress(p.id, serviceWebAddress(await getLocalIp(p.ip),port));results.push({consoleId:p.id,updated:r.updated===true}) }
        catch { results.push({consoleId:p.id,updated:false}) }
      }
      return { configured:profiles.length>0,updated:results.every(r=>r.updated),results }
    }
    const ip = ps4ServiceIp(body?.ip || getSavedPsIp())
    if (!ip) return { updated: false, configured: false, message: 'PS4 ещё не настроена' }
    const port = process.env.PACKAGEFLOW_PUBLIC_PORT || getRequestURL(event).port || process.env.PORT || '3000'
    const profile = consoleProfileForIp(ip), url = serviceWebAddress(await getLocalIp(ip), port)
    return profile ? await updatePairedConsoleWebAddress(profile.id, url) : await updatePairedServiceWebAddress(ip, url)
  } finally { done() }
})
