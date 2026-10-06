import { presetSelection } from '../../utils/presets'
import { getLocalIp } from '../../utils/ps4-installer'
import { ps4ServiceIp } from '../../utils/ps4-service'
import { getInstallationPreference } from '../../utils/installation-preference'
import { startInstallationQueue, appendInstallationQueue, getInstallationQueue } from '../../utils/installation-queue'
import { assertInstallationOrigin } from '../../utils/installation-origin'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody<{ id?: string; keys?: string[]; ip?: string; transport?: string }>(event)
  const ip = ps4ServiceIp(body?.ip)
  if (!ip) throw createError({ statusCode: 400, message: 'Укажите IP PS4' })
  const ids = presetSelection(body?.id, body?.keys).map(item => item.id)
  const pcIp = await getLocalIp(ip), port = getRequestURL(event).port || '3000'
  const input = { packageIds: ids, packageUrls: Object.fromEntries(ids.map(id => [id, `http://${pcIp}:${port}/json/${id}.json`])) }
  const transport = body?.transport ?? getInstallationPreference(), current = getInstallationQueue()
  if (current.status === 'running') {
    if (current.psIp !== body.ip || current.transport !== transport) throw createError({ statusCode: 409, message: 'Работает другая очередь. Дождитесь её завершения.' })
    return appendInstallationQueue({ psIp: body.ip!, queueId: current.id!, ...input })
  }
  return startInstallationQueue({ psIp: body?.ip || '', ...input, transport })
})
