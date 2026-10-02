import { getInstallationQueue } from '../../utils/installation-queue'
import { getActiveServiceInstallJob } from '../../utils/ps4-service-installer'
import { ps4ServiceIp } from '../../utils/ps4-service'

export default defineEventHandler(async event => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const ip = ps4ServiceIp(getQuery(event).ip)
  if (!ip) throw createError({ statusCode: 400, message: 'Укажите IP PS4' })
  const queue = getInstallationQueue()
  const activeJob = await getActiveServiceInstallJob(ip)
  return { activeJob, queue: queue.psIp === ip ? { id: queue.id, status: queue.status, message: queue.message } : null }
})
