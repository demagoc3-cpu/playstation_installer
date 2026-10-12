import { getConsoleProfile } from '../../utils/console-profiles'
import { pausePs5Queue, resumePs5Queue, cancelPs5Queue, clearPs5Tasks, confirmPs5Installation, removePs5Tasks } from '../../utils/ps5-installation-queue'
import { assertInstallationOrigin } from '../../utils/installation-origin'
import { getInstallationQueue, cancelInstallationQueue, cancelInstallationItems, cancelGameInstallations, resolveCancelledQueue, resumeInstallationQueue } from '../../utils/installation-queue'
import { clearFinishedTasks, removeInstallationTasks } from '../../utils/task-visibility'
import { stopSelectedReinstall } from '../../utils/selected-reinstallation'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event,true)
  const b = await readBody(event), p = getConsoleProfile(b?.consoleId)
  if(b.action==='stop-reinstall'&&p.platform==='ps4'&&typeof b.queueId==='string')return stopSelectedReinstall(p.ip,b.queueId)
  if(b.action==='remove'){
    if(typeof b.queueId!=='string'||!b.queueId||!!b.packageIds===!!b.branches||[b.packageIds,b.branches].some(ids=>ids!==undefined&&(!Array.isArray(ids)||!ids.length||ids.length>10000||ids.some((id:unknown)=>typeof id!=='string'||!id))))throw createError({statusCode:400,message:'Неверный выбор заданий'})
    return p.platform==='ps4'?removeInstallationTasks(p.ip,b.queueId,b.packageIds,b.branches):removePs5Tasks(p.id,b.queueId,b.packageIds,b.branches)
  }
  if (p.platform === 'ps4') {
    if (b.action === 'clear') return clearFinishedTasks(b.torrents || [],p.ip)
    const queue = getInstallationQueue(p.ip)
    if (typeof b.queueId !== 'string') throw createError({statusCode:409,message:'Очередь устройства изменилась. Обновите задания'})
    if (b.action === 'resume') return resumeInstallationQueue(b.queueId,p.ip)
    if (b.action === 'resolve') {
      if(queue.id!==b.queueId)throw createError({statusCode:409,message:'Очередь устройства изменилась. Обновите задания'})
      return resolveCancelledQueue(b.queueId,p.ip)
    }
    if (b.action !== 'cancel' || [b.packageIds,b.branches].some(ids => ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some((id: unknown)=>typeof id !== 'string')))) throw createError({statusCode:400,message:'Неверный выбор заданий'})
    if (b.packageIds) return cancelInstallationItems(b.queueId,b.packageIds,p.ip)
    if (b.branches) return cancelGameInstallations(b.queueId,p.ip,b.branches.map((branch:string)=>branch.replace(/^ps4:/,'')))
    if(queue.id!==b.queueId)throw createError({statusCode:409,message:'Очередь устройства изменилась. Обновите задания'})
    return cancelInstallationQueue(p.ip)
  }
  if (['pause','resume'].includes(b.action) && typeof b.queueId === 'string') return b.action === 'pause' ? pausePs5Queue(p.id,b.queueId) : resumePs5Queue(p.id,b.queueId)
  if (b.action === 'confirm-installed') {
    if (typeof b.queueId !== 'string' || typeof b.packageId !== 'string' || b.installed !== true) throw createError({statusCode:400,message:'Подтвердите установку выбранного пакета'})
    return confirmPs5Installation(p.id,b.queueId,b.packageId)
  }
  if (b.action === 'clear') return clearPs5Tasks(p.id)
  if (b.action !== 'cancel' || typeof b.queueId !== 'string' || [b.packageIds,b.branches].some(ids => ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some((id: unknown)=>typeof id !== 'string')))) throw createError({ statusCode: 400, message: 'Неверный выбор заданий' })
  return cancelPs5Queue(p.id,b.queueId,b.packageIds,b.branches)
})
