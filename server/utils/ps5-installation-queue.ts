import { existsSync, readFileSync } from 'node:fs'
import { createError } from 'h3'
import { dataPath } from './data-path'
import { latestInstallationAttempts } from '../../shared/latest-installation-attempts'
import { assertNoPs5ServiceUpdate } from './ps5-service-updates'
import { writeDurableJson } from './durable-json'
import { getConsoleProfile, getConsoleProfiles, probeConsoleProfile } from './console-profiles'
import { getLibraryPackages, getPackage, markPackageInstalled } from './package-library'
import { contentBranchKey, contentForConsole, contentFormat, contentPlatform } from '../../shared/content-platform'
import { installationTaskCategory, TASK_CATEGORIES, type InstallationTask, type InstallationTasksPage } from '../../shared/types/tasks'
import { Ps5QueueRunner, ps5BlankQueue, ps5CanCancel, Ps5QueueFailure, type Ps5Queue, type Ps5Item } from './ps5-queue-core'
import { ps5QueueDriver } from './ps5-queue-driver'
import type { LibraryInstallationSelection } from './library-installation'
const runners = new Map<string, Ps5QueueRunner>()
const path = (id: string) => dataPath(`consoles/${id}/ps5-installation-queue.json`)
function validItems(value: unknown): value is Ps5Item[] {
  return Array.isArray(value) && value.length <= 10000 && value.every(item => item && typeof item.packageId === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(item.packageId) && /^[0-9a-f]{32}$/.test(item.transferId || '') &&
    ['pending','sending','verifying','installing','waiting','installed','failed','skipped','cancelled','unconfirmed'].includes(item.state) && ['ps4','ps5'].includes(item.platform) && ['pkg','folder','ufs2','exfat','pfs','ffpfsc','unknown'].includes(item.format) &&
    typeof item.branch === 'string' && typeof item.title === 'string' && typeof item.fileName === 'string' && typeof item.detail === 'string' && Number.isSafeInteger(item.size) && item.size > 0 && Number.isSafeInteger(item.bytesSent) && item.bytesSent >= 0 && item.bytesSent <= item.size && Number.isInteger(item.order) && item.order >= 0)
}
function runner(id: string) {
  const profile = getConsoleProfile(id)
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile.id)) throw createError({statusCode:400,message:'Неверный профиль PS5'})
  if (profile.platform !== 'ps5') throw createError({ statusCode: 400, message: 'Выберите профиль PS5' })
  let value = runners.get(profile.id)
  if (!value) {
    let queue = ps5BlankQueue(profile.id, profile.ip)
    if (existsSync(path(profile.id))) {
      try {
        queue = JSON.parse(readFileSync(path(profile.id), 'utf8'))
        if (queue.version !== 1 || queue.consoleId !== profile.id || queue.psIp !== profile.ip || !validItems(queue.items) || !Array.isArray(queue.history) || queue.history.length > 10 || !queue.history.every(validItems) || !['idle','running','completed','failed','cancelled'].includes(queue.status)) throw new Error('Invalid queue')
      } catch { throw createError({ statusCode: 500, message: 'Не удалось прочитать очередь PS5. Сохранённый файл не изменён' }) }
    }
    value = new Ps5QueueRunner(queue, q => writeDurableJson(path(profile.id), q), ps5QueueDriver(profile.id), 2000, item => { markPackageInstalled(item.packageId, true, profile.ip) })
    runners.set(profile.id, value)
  }
  return value
}
export function getPs5Queue(id: string) {
  const { history: _, ...snapshot } = runner(id).queue, q = structuredClone(snapshot)
  return { ...q, items: q.items.map(item => { const { hash: _, sourceStamp: __, transferId: ___, ...publicItem } = item; return publicItem }) }
}
export function ps5TaskPackageId(id: string, queueId: string, taskId: string) {
  const q = runner(id).queue, item = q.items.find(item => item.transferId === taskId || item.packageId === taskId)
  if (q.id !== queueId || !item) throw createError({statusCode:409,message:'Задание больше не существует в этой очереди'})
  return item.packageId
}
export async function startPs5Queue(input: { consoleId: string; packageIds?: unknown; librarySelection?: LibraryInstallationSelection; queueId?: string }) {
  assertNoPs5ServiceUpdate(input.consoleId)
  const profile = getConsoleProfile(input.consoleId)
  if (profile.platform !== 'ps5') throw createError({ statusCode: 400, message: 'Выберите PS5' })
  const snapshot = (await probeConsoleProfile(profile.id)).consoles.find(p => p.id === profile.id)!
  if (!snapshot.online || !snapshot.paired) throw createError({ statusCode: 409, message: 'Подключите и сопрягите сервис PS5' })
  const library = getLibraryPackages(profile.ip), current = runner(profile.id)
  let ids = input.packageIds
  if (input.librarySelection) {
    const selection = input.librarySelection
    if (!['all','dlc'].includes(selection.scope) || selection.titleId !== undefined && (typeof selection.titleId !== 'string' || !selection.titleId.trim())) throw createError({ statusCode: 400, message: 'Неверный выбор библиотеки' })
    const excluded = new Set(current.queue.status === 'running' ? current.queue.items.filter(item => item.state !== 'cancelled').map(item => item.packageId) : [])
    ids = library.filter(item => contentForConsole(item,'ps5') && !item.installedAt && !excluded.has(item.id) && (!selection.platform || selection.platform === 'all' || contentPlatform(item) === selection.platform) && (selection.scope !== 'dlc' || item.type === 'DLC') && (!selection.titleId || selection.titleId === item.titleId)).map(item => item.id)
  }
  if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some(id => typeof id !== 'string')) throw createError({ statusCode: 400, message: 'Выберите пакеты для установки' })
  const items = [...new Set(ids as string[])].map(id => getPackage(id))
  // Validate the WHOLE batch before persisting or transferring any bytes.
  for (const item of items) {
    const platform = contentPlatform(item), format = contentFormat(item)
    if (!contentForConsole(item,'ps5') || !snapshot.capabilities.formats.includes(format) || format !== 'pkg' || !(platform === 'ps4' ? snapshot.capabilities.installPs4 : snapshot.capabilities.installPs5))
      throw createError({ statusCode: 409, message: `Сервис PS5 ещё не подтвердил установку ${platform.toUpperCase()} / ${format.toUpperCase()}. Очередь не отправлена` })
  }
  try { current.enqueue(items.map(item => ({ packageId: item.id, title: item.title, fileName: item.fileName, size: item.size, type: item.type,
    titleId: item.titleId, branch: contentBranchKey(item), order: item.installOrder, platform: contentPlatform(item), format: contentFormat(item), appVersion: item.appVersion, contentId: item.contentId })), input.queueId); return getPs5Queue(profile.id) }
  catch (error) { if (error instanceof Ps5QueueFailure) throw createError({ statusCode: 409, message: error.message }); throw error }
}
export function cancelPs5Queue(id: string, queueId: string, packageIds?: string[], branches?: string[]) {
  try { runner(id).cancel(queueId, packageIds, branches); return getPs5Queue(id) }
  catch (error) { if (error instanceof Ps5QueueFailure) throw createError({ statusCode: 409, message: error.message }); throw error }
}
export function clearPs5Tasks(id: string) { runner(id).clear(); return getPs5Queue(id) }
export function getPs5TaskCounts(id:string) {
  const q=runner(id).queue, counts:InstallationTasksPage['counts']={active:0,queued:0,completed:0,failed:0}
  const visible = latestInstallationAttempts([q.items,...q.history].flat().filter(item => !item.hidden).map(item => ({ ...item, psIp:q.psIp, createdAt:item.createdAt || q.createdAt })))
  for(const item of visible) counts[installationTaskCategory(item.state)]++
  return counts
}
export function getPs5Tasks(id: string, query: { categories?: unknown; page?: unknown; view?: unknown; history?: unknown } = {}): InstallationTasksPage {
  const r = runner(id), q = r.queue, library = getLibraryPackages(q.psIp)
  const groups = new Map<string, typeof library[number]>()
  for (const pkg of library) { const key = contentBranchKey(pkg); if (!groups.has(key) || pkg.installOrder === 0) groups.set(key,pkg) }
  const tasks: InstallationTask[] = []
  for (const [index, entries] of [q.items, ...q.history].entries()) for (const item of entries) {
    if (item.hidden) continue
    const base = groups.get(item.branch)
    const { hash: _, sourceStamp: __, transferId: ___, installDispatched: ____, ...metadata } = item
    tasks.push({ ...metadata, id: item.transferId, queueId: item.queueId || (index === 0 ? q.id || '' : `history-${index}`), psIp: q.psIp,
      category: installationTaskCategory(item.state), groupTitle: base?.title || item.title, groupIconId: base?.iconSize ? base.id : undefined,
      createdAt: item.createdAt || q.createdAt, transport: 'service', canCancel: index === 0 && q.status === 'running' && ps5CanCancel(item), cancelRequested: !!item.cancelRequested })
  }
  const visibleTasks = latestInstallationAttempts(tasks, query.history)
  const counts = Object.fromEntries(TASK_CATEGORIES.map(c => [c,visibleTasks.filter(t => t.category === c).length])) as InstallationTasksPage['counts']
  const active = visibleTasks.filter(t => t.queueId === q.id && (t.category === 'active' || t.state === 'unconfirmed'))
  const categories = typeof query.categories === 'string' ? query.categories.split(',') : TASK_CATEGORIES
  const tree = query.view === 'tree', filtered = visibleTasks.filter(t => categories.includes(t.category) && (tree || !active.some(a=>a.id===t.id)))
  const branches = new Map<string, InstallationTask[]>()
  for (const task of filtered) { const key = contentBranchKey(task); const entries = branches.get(key) || []; entries.push(task); branches.set(key,entries) }
  const total = tree ? branches.size : filtered.length, pages = Math.max(1,Math.ceil(total/50)), page = Math.min(pages,Math.max(1,Math.floor(Number(query.page)||1)))
  return { active, items: tree ? [...branches.values()].slice((page-1)*50,page*50).flat() : filtered.slice((page-1)*50,page*50), counts, page, pages, total, unit: tree ? 'games' : 'tasks' }
}
export function resumePs5Queues() {
  for (const profile of getConsoleProfiles().consoles.filter(p => p.platform === 'ps5')) {
    try { runner(profile.id).wake() } catch (error) { console.error('PS5 queue recovery unavailable:', error instanceof Error ? error.message : 'unknown') }
  }
}
