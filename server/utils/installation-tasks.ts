import { getInstallationQueue, getInstallationHistory, getInstallationTransferTelemetry, canCancelInstallationItem, canManageInstallationQueue } from './installation-queue'
import { getTaskVisibility, installationTaskHidden } from './task-visibility'
import { getLibraryPackages } from './package-library'
import { latestInstallationAttempts } from '../../shared/latest-installation-attempts'
import { readMaintenance } from './maintenance-store'
import { installationTaskCategory, installationTaskGroupKey, TASK_CATEGORIES, type InstallationTask, type TaskCategory } from '../../shared/types/tasks'

export function getInstallationTasks(query: { categories?: unknown; page?: unknown; view?: unknown; history?: unknown; ip?: string } = {}) {
  const visibility = getTaskVisibility(), hidden = new Set(visibility.hidden)
  const current = getInstallationQueue(query.ip)
  const history = getInstallationHistory(query.ip).filter(queue => queue.id !== current.id)
  const queues = [current, ...history].filter(queue => !query.ip || queue.psIp === query.ip)
  const library = getLibraryPackages(query.ip)
  const packages = new Map(library.flatMap(item => [item.id, ...(item.sourceIds || [])].map(id => [id, item] as const)))
  const branches = new Map<string, { title: string; iconId?: string; hasBase: boolean }>()
  for (const item of library) {
    const previous = branches.get(item.titleId)
    if (!previous || (item.type === 'Игра' && !previous.hasBase)) branches.set(item.titleId, { title: item.title, iconId: item.iconSize ? item.id : previous?.iconId, hasBase: item.type === 'Игра' })
    else if (!previous.iconId && item.iconSize) previous.iconId = item.id
  }
  const pastBaseTitles = new Map(queues.flatMap(queue => queue.items.filter(item => item.type === 'Игра' && item.titleId && item.title).map(item => [item.titleId!, item.title!] as const)))
  const counts: Record<TaskCategory, number> = { active: 0, queued: 0, completed: 0, failed: 0 }
  const tasks: InstallationTask[] = []
  const hiddenTasks = new Set<string>()
  for (const queue of queues) for (const item of queue.items) {
    if (installationTaskHidden(hidden,queue.id,item,queue.psIp) && ['completed', 'failed'].includes(installationTaskCategory(item.state))) hiddenTasks.add(`${queue.id}:${item.packageId}`)
    const pkg = packages.get(item.packageId)
    const titleId = item.titleId || pkg?.titleId || ''
    const branch = branches.get(titleId)
    const category = installationTaskCategory(item.state)
    tasks.push({ id: `${queue.id}:${item.packageId}`, queueId: queue.id || '', packageId: item.packageId, psIp: queue.psIp || '',
      title: item.title || pkg?.title || item.packageId, fileName: item.fileName || pkg?.fileName || item.packageId,
      type: item.type || pkg?.type || 'PKG', size: item.size ?? pkg?.size ?? 0, state: item.state, category,
      consolePlatform: 'ps4', ...getInstallationTransferTelemetry(queue, item),
      platform: pkg?.platform, format: pkg?.format, signature: pkg?.signature, contentId: pkg?.contentId, appVersion: pkg?.appVersion, masterVersion: pkg?.masterVersion, requiredFirmware: pkg?.requiredFirmware, sdkFirmware: pkg?.sdkFirmware, contentType: pkg?.contentType, packageDigest: pkg?.packageDigest,
      titleId, groupTitle: branch?.title || pastBaseTitles.get(titleId) || titleId || item.title || item.packageId, groupIconId: branch?.iconId,
      detail: queue.id!==current.id&&item.state==='pending'&&['failed','cancelled','completed'].includes(queue.status)?'Не отправлен: прежняя очередь остановлена':item.detail,
      bytesSent: item.bytesSent, createdAt: queue.createdAt || 0, completedAt: item.completedAt || item.installedAt,
      transport: queue.transport || 'payload', cancelRequested: !!item.cancelRequested,
      canDismiss: ['completed','failed'].includes(category),
      canCancel: canCancelInstallationItem(queue, item, current.id) })
  }
  // Select the latest receipt before hiding it; clearing a success must not
  // resurrect the same file's pending entry from an older stopped queue.
  const visibleTasks = latestInstallationAttempts(tasks, query.history).filter(task => !hiddenTasks.has(task.id))
  for (const task of visibleTasks) counts[task.category]++
  const active = visibleTasks.filter(task => task.queueId === current.id && ['running', 'cancelling'].includes(current.status) && task.category === 'active')
  const pinned = new Set(active.map(task => task.id))
  const requested = typeof query.categories === 'string' ? query.categories.split(',') : TASK_CATEGORIES
  const categories = new Set(requested.filter(category => TASK_CATEGORIES.includes(category as TaskCategory)))
  const tree = query.view === 'tree'
  const filtered = visibleTasks.filter(task => (tree || !pinned.has(task.id)) && categories.has(task.category))
    .sort((a, b) => TASK_CATEGORIES.indexOf(a.category) - TASK_CATEGORIES.indexOf(b.category) || b.createdAt - a.createdAt)
  const groups = new Map<string, InstallationTask[]>()
  if (tree) for (const task of filtered) {
    const key = installationTaskGroupKey(task)
    const group = groups.get(key)
    if (group) group.push(task)
    else groups.set(key, [task])
  }
  const total = tree ? groups.size : filtered.length, pages = Math.max(1, Math.ceil(total / 50))
  const page = Math.min(pages, Number.isSafeInteger(Number(query.page)) && Number(query.page) > 0 ? Number(query.page) : 1)
  const items = tree ? [...groups.values()].slice((page - 1) * 50, page * 50).flatMap(group => group.sort((a, b) =>
    (a.type === 'Игра' ? 0 : a.type === 'DLC' ? 2 : 1) - (b.type === 'Игра' ? 0 : b.type === 'DLC' ? 2 : 1) || b.createdAt - a.createdAt)) : filtered.slice((page - 1) * 50, page * 50)
  const flow=query.ip?readMaintenance()[query.ip]:undefined
  const flowQueue=flow?queues.find(queue=>queue.id===flow.id):undefined
  const flowDismissed=flow&&flowQueue&&['completed','failed'].includes(flow.state)&&!!flowQueue.items.length&&flowQueue.items.every(item=>installationTaskHidden(hidden,flowQueue.id,item,flowQueue.psIp))
  const flowResumed=flowQueue&&!flowQueue.items.some(item=>item.state==='pending')&&flowQueue.items.some(item=>item.detail.startsWith('Неотправленный пакет перенесён в очередь '))
  const oldBusy=flow?.state==='failed'&&flow.id!==current.id&&/^На PS4 уже есть активное задание сервиса(?: \(0x00000000\))?$/.test(flow.message)
  const maintenance=flow?.kind==='selected-reinstall'&&!flowDismissed&&!flowResumed?{id:flow.id,title:'Выбранные пакеты',state:flow.state,
    message:oldBusy?'Предыдущая переустановка остановлена: сервис был занят. Неотправленные пакеты можно отменить или убрать из заданий.':flow.message,canStop:!['completed','failed'].includes(flow.state)}:undefined
  return { active, items, counts, page, pages, total, hiddenTorrents: visibility.torrents, maintenance,
    resumableQueues: !['running','cancelling'].includes(current.status)?queues.filter(queue=>['failed','completed'].includes(queue.status)&&canManageInstallationQueue(queue)&&queue.items.some(item=>item.state==='pending'&&!item.serviceDispatchedAt&&!item.dispatchedAt&&!item.cancelRequested)).map(queue=>queue.id!):[],
    queueId: current.id, queueStatus: current.status, canCancelAll: current.items.some(item => canCancelInstallationItem(current, item, current.id)),
    unit: tree ? 'games' as const : 'tasks' as const }
}
