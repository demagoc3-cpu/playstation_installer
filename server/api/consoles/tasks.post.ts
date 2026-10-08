import { getConsoleProfile } from '../../utils/console-profiles'
import { cancelPs5Queue, clearPs5Tasks } from '../../utils/ps5-installation-queue'
import { assertInstallationOrigin } from '../../utils/installation-origin'
import { getInstallationQueue, cancelInstallationQueue, cancelInstallationItems, cancelGameInstallations, resolveCancelledQueue } from '../../utils/installation-queue'
import { clearFinishedTasks } from '../../utils/task-visibility'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event,true)
  const b = await readBody(event), p = getConsoleProfile(b?.consoleId)
  if (p.platform === 'ps4') {
    if (b.action === 'clear') return clearFinishedTasks(b.torrents || [],p.ip)
    const queue = getInstallationQueue(p.ip)
    if (typeof b.queueId !== 'string' || queue.id !== b.queueId) throw createError({statusCode:409,message:'Очередь устройства изменилась. Обновите задания'})
    if (b.action === 'resolve') return resolveCancelledQueue(b.queueId,p.ip)
    if (b.action !== 'cancel' || [b.packageIds,b.branches].some(ids => ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some((id: unknown)=>typeof id !== 'string')))) throw createError({statusCode:400,message:'Неверный выбор заданий'})
    if (b.packageIds) return cancelInstallationItems(b.queueId,b.packageIds,p.ip)
    if (b.branches) return cancelGameInstallations(b.queueId,p.ip,b.branches.map((branch:string)=>branch.replace(/^ps4:/,'')))
    return cancelInstallationQueue(p.ip)
  }
  if (b.action === 'clear') return clearPs5Tasks(p.id)
  if (b.action !== 'cancel' || typeof b.queueId !== 'string' || [b.packageIds,b.branches].some(ids => ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some((id: unknown)=>typeof id !== 'string')))) throw createError({ statusCode: 400, message: 'Неверный выбор заданий' })
  return cancelPs5Queue(p.id,b.queueId,b.packageIds,b.branches)
})
