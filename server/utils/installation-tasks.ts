import { getInstallationQueue, getInstallationHistory } from './installation-queue'
import { getTaskVisibility, taskVisibilityKey } from './task-visibility'
import { getLibraryPackages } from './package-library'
import { installationTaskCategory, installationTaskGroupKey, TASK_CATEGORIES, type InstallationTask, type TaskCategory } from '../../shared/types/tasks'

export function getInstallationTasks(query: { categories?: unknown; page?: unknown; view?: unknown; ip?: string } = {}) {
  const visibility = getTaskVisibility(), hidden = new Set(visibility.hidden)
  const current = getInstallationQueue()
  const history = getInstallationHistory().filter(queue => queue.id !== current.id)
  const queues = [current, ...history].filter(queue => !query.ip || queue.psIp === query.ip)
  const library = getLibraryPackages()
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
  for (const queue of queues) for (const item of queue.items) {
    if (hidden.has(taskVisibilityKey(queue.id, item)) && ['completed', 'failed'].includes(installationTaskCategory(item.state))) continue
    const pkg = packages.get(item.packageId)
    const titleId = item.titleId || pkg?.titleId || ''
    const branch = branches.get(titleId)
    const category = installationTaskCategory(item.state)
    counts[category]++
    tasks.push({ id: `${queue.id}:${item.packageId}`, queueId: queue.id || '', packageId: item.packageId, psIp: queue.psIp || '',
      title: item.title || pkg?.title || item.packageId, fileName: item.fileName || pkg?.fileName || item.packageId,
      type: item.type || pkg?.type || 'PKG', size: item.size ?? pkg?.size ?? 0, state: item.state, category,
      contentId: pkg?.contentId, appVersion: pkg?.appVersion, masterVersion: pkg?.masterVersion, requiredFirmware: pkg?.requiredFirmware, sdkFirmware: pkg?.sdkFirmware, contentType: pkg?.contentType, packageDigest: pkg?.packageDigest,
      titleId, groupTitle: branch?.title || pastBaseTitles.get(titleId) || titleId || item.title || item.packageId, groupIconId: branch?.iconId,
      detail: item.detail, bytesSent: item.bytesSent, createdAt: queue.createdAt || 0, completedAt: item.completedAt || item.installedAt,
      transport: queue.transport || 'payload', cancelRequested: !!item.cancelRequested,
      canCancel: queue.id === current.id && !queue.maintenanceId && ['active', 'queued'].includes(category) &&
        (queue.status === 'running' || (queue.status === 'failed' && item.state === 'pending' && !item.serviceDispatchedAt)) })
  }
  const active = tasks.filter(task => task.queueId === current.id && ['running', 'cancelling'].includes(current.status) && task.category === 'active')
  const pinned = new Set(active.map(task => task.id))
  const requested = typeof query.categories === 'string' ? query.categories.split(',') : TASK_CATEGORIES
  const categories = new Set(requested.filter(category => TASK_CATEGORIES.includes(category as TaskCategory)))
  const tree = query.view === 'tree'
  const filtered = tasks.filter(task => (tree || !pinned.has(task.id)) && categories.has(task.category))
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
  return { active, items, counts, page, pages, total, hiddenTorrents: visibility.torrents, unit: tree ? 'games' as const : 'tasks' as const }
}
