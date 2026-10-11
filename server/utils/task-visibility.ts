import { dataPath } from './data-path'
import { readJsonFile, writeJsonFile } from './json-store'
import { assertDesktopWritable } from './desktop-lifecycle'
import { peekInstallationQueue, getInstallationQueue, getInstallationHistory, cancelInstallationItems, canCancelInstallationItem } from './installation-queue'
import { createError } from 'h3'
import { getPackage } from './package-library'
import { installationTaskCategory } from '../../shared/types/tasks'
const path = dataPath('task-visibility.json')
type Visibility = { version: 1; hidden: string[]; torrents: Record<string, string> }
type VisibilityItem = { packageId: string; state: string; completedAt?: number; installedAt?: number; bytesSent: number; detail: string }
export const taskVisibilityKey = (queueId: string | undefined, item: VisibilityItem, ip?: string) => `${ip ? `${ip}:` : ''}${queueId}:${item.packageId}:${JSON.stringify([item.state, item.completedAt || item.installedAt || 0, item.bytesSent, item.detail])}`
// Read old keys for compatibility; every new write is bound to a destination.
export const installationTaskHidden = (hidden: Set<string>, queueId: string | undefined, item: VisibilityItem, ip?: string) => hidden.has(taskVisibilityKey(queueId,item,ip)) || hidden.has(taskVisibilityKey(queueId,item))
export const getTaskVisibility = () => readJsonFile<Visibility>(path, { version: 1, hidden: [], torrents: {} })

/** Cancel only selected pending/live work; hide finished rows without changing receipts. */
export function removeInstallationTasks(ip:string, queueId:string, packageIds?:string[],branches?:string[]){
  assertDesktopWritable()
  const current=peekInstallationQueue(ip)
  let queue=[current,...getInstallationHistory(ip)].find(q=>q.id===queueId&&q.psIp===ip)
  if(!queue)throw createError({statusCode:409,message:'Очередь изменилась. Обновите задания'})
  const selected=(item:typeof queue.items[number])=>{
    let titleId=item.titleId
    if(!titleId)try{titleId=getPackage(item.packageId).titleId}catch{/* Deleted library source: match the package ID. */}
    return packageIds?.includes(item.packageId)||branches?.includes(`ps4:${titleId || item.packageId}`)
  }
  const targets=queue.items.filter(selected)
  if(!targets.length)throw createError({statusCode:409,message:'Выбранные задания больше не найдены'})
  const unfinished=targets.filter(item=>['active','queued'].includes(installationTaskCategory(item.state)))
  if(unfinished.length){
    if(unfinished.some(item=>!canCancelInstallationItem(queue!,item,current.id)))throw createError({statusCode:409,message:'Сначала дождитесь подтверждения отмены на приставке'})
    cancelInstallationItems(queueId,unfinished.map(item=>item.packageId),ip)
    queue=queue.id===current.id?peekInstallationQueue(ip):getInstallationHistory(ip).find(previous=>previous.id===queueId)!
  }
  const state=getTaskVisibility(),hidden=new Set(state.hidden);let cleared=0
  for(const item of queue.items.filter(selected))if(['completed','failed'].includes(installationTaskCategory(item.state))){
    const key=taskVisibilityKey(queue.id,item,ip);if(!hidden.has(key)){hidden.add(key);cleared++}
  }
  state.hidden=[...hidden];writeJsonFile(path,state)
  return {cleared,message:unfinished.some(item=>item.serviceDispatchedAt)?'Отмена запрошена. Принятое приставкой задание останется видно до подтверждения.':'Выбранные задания убраны из списка. Установленные игры сохранены.'}
}
/** qBittorrent history is shared; clearing it must preserve every console's history. */
export function clearFinishedTorrentTasks(torrents: unknown) {
  assertDesktopWritable()
  const state=getTaskVisibility()
  if (!Array.isArray(torrents) || torrents.length>10000) throw createError({statusCode:400,message:'Неверный список загрузок'})
  for(const item of torrents) {
    if (!item || typeof item.hash!=='string' || !/^[a-f0-9]{40,64}$/i.test(item.hash) || typeof item.state!=='string' || item.state.length>64 || !Number.isFinite(item.progress)) continue
    if (item.progress>=1 || /error|missingFiles|unknown/i.test(item.state)) state.torrents[item.hash]=`${item.state}:${item.progress}`
  }
  writeJsonFile(path,state);return {hiddenTorrents:state.torrents}
}
export function clearFinishedTasks(torrents: unknown = [], ip?: string) {
  assertDesktopWritable()
  const state = getTaskVisibility(), hidden = new Set(state.hidden)
  let cleared = 0
  for (const queue of [getInstallationQueue(ip), ...getInstallationHistory(ip)]) for (const item of queue.items) {
    if ((ip && queue.psIp !== ip) || !['completed', 'failed'].includes(installationTaskCategory(item.state))) continue
    const id = taskVisibilityKey(queue.id, item, queue.psIp)
    if (!hidden.has(id)) { hidden.add(id); cleared++ }
  }
  if (Array.isArray(torrents)) for (const item of torrents) {
    if (!item || typeof item.hash !== 'string' || !/^[a-f0-9]{40,64}$/i.test(item.hash) || typeof item.state !== 'string' || typeof item.progress !== 'number') continue
    if (item.progress < 1 && !/error|missingFiles|unknown/i.test(item.state)) continue
    state.torrents[item.hash] = `${item.state}:${item.progress}`
  }
  // Keep queue records intact: the runner and installation confirmation use their indices.
  const retained = new Set([getInstallationQueue(ip), ...getInstallationHistory(ip)].flatMap(queue => queue.items.flatMap(item => [taskVisibilityKey(queue.id, item, queue.psIp), taskVisibilityKey(queue.id, item)])))
  state.hidden = ip ? [...hidden] : [...hidden].filter(id => retained.has(id))
  writeJsonFile(path, state)
  return { cleared, hiddenTorrents: state.torrents }
}
