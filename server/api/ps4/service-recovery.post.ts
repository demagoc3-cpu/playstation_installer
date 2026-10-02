import { assertInstallationOrigin } from '../../utils/installation-origin'
import { getInstallationQueue, clearStaleInstallationQueue } from '../../utils/installation-queue'
import { cancelServiceInstallJob, getActiveServiceInstallJob, releaseServiceInstallJob } from '../../utils/ps4-service-installer'
import { ps4ServiceIp } from '../../utils/ps4-service'

export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody<{ ip?: string; queueId?: string; jobId?: string }>(event)
  const ip = ps4ServiceIp(body?.ip)
  if (!ip) throw createError({ statusCode: 400, message: 'Укажите IP PS4' })
  const queue = getInstallationQueue()
  if (queue.psIp === ip && ['running', 'cancelling', 'failed'].includes(queue.status) && queue.id !== body?.queueId)
    throw createError({ statusCode: 409, message: 'Очередь изменилась. Обновите состояние.' })
  const active = await getActiveServiceInstallJob(ip)
  if (active && active.requestId !== body?.jobId)
    throw createError({ statusCode: 409, message: 'Задание PS4 изменилось. Обновите состояние.' })
  if (active) {
    if (['uncertain', 'cancelling'].includes(active.state)) await releaseServiceInstallJob(ip, active.requestId)
    else await cancelServiceInstallJob(ip, active.requestId)
  }
  const after = await getActiveServiceInstallJob(ip)
  if (after) throw createError({ statusCode: 409, message: 'Служба ещё видит активное задание. Очистка WEB не выполнялась.' })
  const latest = getInstallationQueue()
  const cleared = latest.psIp === ip && latest.id === body?.queueId && ['failed', 'cancelling', 'cancelled'].includes(latest.status)
    ? clearStaleInstallationQueue(ip, latest.id!) : null
  return { activeJob: null, queue: cleared, message: cleared ? 'Зависшее ожидание снято; можно повторить установку.' : 'Активных заданий PS4 нет.' }
})
