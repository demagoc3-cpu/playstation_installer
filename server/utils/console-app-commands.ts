import { inConsoleScope } from './console-scope'
import { filterContent } from '../../shared/content-platform'
import { clearFinishedTasks, removeInstallationTasks } from './task-visibility'
import { normalizeNativeTaskControl, normalizeNativeInstallReview } from './native-task-contract'
import { getPreset, resolvePreset, presetSelection } from './presets'
import { dataPath } from './data-path'
import { createHash } from 'node:crypto'

import { createError } from 'h3'
import { readJsonFile, writeJsonFile } from './json-store'
import { getLibraryPackages } from './package-library'
import { getInstallationQueue, startInstallationQueue, appendInstallationQueue, cancelCurrentInstallation, cancelInstallationQueue, cancelGameInstallation, cancelInstallationItem, cancelInstallationItems, cancelGameInstallations } from './installation-queue'
import { beginReinstall, reinstallPlan } from './console-maintenance'
import { getLocalIp } from './ps4-installer'
import { consoleSelection } from './console-app-data'
import { resolveConsoleFavorites } from './console-catalog'
import { ps4ServiceIp } from './ps4-service'

type Record = { id: string; ip: string; fingerprint: string; state: string; message: string; result?: unknown }
const file = dataPath('console-app-commands.json')
const live = new Set<string>()
const read = () => readJsonFile<{ version: 1; records: Record[] }>(file, { version: 1, records: [] })
const save = (record: Record) => { const all = read(); const index = all.records.findIndex(r => r.id === record.id); if (index < 0) all.records.push(record); else all.records[index] = record; writeJsonFile(file, all) }
const publicRecord = ({ fingerprint: _, ip: __, ...record }: Record) => record
export function consoleCommand(id: unknown, ipValue: unknown) {
  const ip = ps4ServiceIp(ipValue)
  if (!ip || typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw createError({ statusCode: 400, message: 'Некорректный запрос' })
  const record = read().records.find(r => r.id === id && r.ip === ip)
  if (!record) throw createError({ statusCode: 404, message: 'Задание приложения не найдено; автоматический повтор не отправлен' })
  if (record.state === 'pending' && !live.has(id)) return { id, state: 'uncertain', message: 'WEB перезапущен во время команды. Проверьте общую очередь; повтор не отправлен.' }
  return publicRecord(record)
}
export function submitConsoleCommand(body: any, port: string) {
  const ip = ps4ServiceIp(body?.ip)
  if (!ip || !/^[a-f0-9]{32}$/.test(body?.requestId || '') || typeof body.gameId !== 'string' || !['all', 'selected', 'reinstall-preview', 'reinstall', 'patches', 'dlc', 'cancel-current', 'cancel-all', 'cancel-game', 'install-preset', 'install-favorites', 'clear-tasks', 'cancel-item', 'cancel-items', 'cancel-games', 'remove-items', 'remove-games', 'stop-reinstall', 'install-reviewed'].includes(body.action))
    throw createError({ statusCode: 400, message: 'Некорректная команда приложения' })
  const taskControl = normalizeNativeTaskControl(body, 'ps4')
  const review = body.action === 'install-reviewed' ? normalizeNativeInstallReview(body) : undefined
  // Copy normalized new commands before the async worker; callers cannot alter
  // the selection after its receipt has been persisted. Legacy fingerprints stay intact.
  if (taskControl) body = { ...body, ...taskControl }
  if (review) body = { ...body, ...review }
  if (body.packageIds !== undefined && (!Array.isArray(body.packageIds) || body.packageIds.some((id: unknown) => typeof id !== 'string')))
    throw createError({ statusCode: 400, message: 'Некорректный выбор пакетов' })
  for (const [action, key] of [['cancel-items', 'packageIds'], ['cancel-games', 'gameIds']]) {
    if (body.action === action && (!Array.isArray(body[key]) || !body[key].length || body[key].length > 256 || body[key].some((id: unknown) => typeof id !== 'string' || !/^[\w.-]{1,63}$/.test(id))))
      throw createError({ statusCode: 400, message: 'Выберите задания для отмены' })
  }
  const identity = [ip, body.gameId, body.action, body.packageIds || [], body.confirmTitleId, body.revision, body.queueId, body.currentPackageId, body.presetId, body.favoriteIds, body.gameIds]
  if (taskControl) identity.push(body.maintenanceId)
  if (review) identity.push(review.consoleId, review.reviewToken, review.overwritePackageIds)
  const fingerprint = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  const existing = read().records.find(r => r.id === body.requestId)
  if (existing) {
    if (existing.ip !== ip || existing.fingerprint !== fingerprint) throw createError({ statusCode: 409, message: 'Идентификатор уже использован другой командой' })
    return consoleCommand(body.requestId, ip)
  }
  const control = ['cancel-current', 'cancel-all', 'cancel-game', 'cancel-item', 'cancel-items', 'cancel-games'].includes(body.action)
  if (body.action === 'install-favorites' && (!Array.isArray(body.favoriteIds) || !body.favoriteIds.length || body.favoriteIds.length > 1024 || body.favoriteIds.some((id: unknown) => typeof id !== 'string' || !/^[\w.-]{1,39}$/.test(id)))) throw createError({ statusCode: 400, message: 'Некорректный список избранного' })
  if (control && (typeof body.queueId !== 'string' || !body.queueId || (['cancel-current', 'cancel-item'].includes(body.action) && typeof body.currentPackageId !== 'string')))
    throw createError({ statusCode: 400, message: 'Не указано текущее задание' })
  let packages, missingFavorites = 0
  try { packages = control || taskControl || review || body.action === 'clear-tasks' ? [] : body.action === 'install-favorites' ? (() => {
    const library = filterContent(getLibraryPackages(ip), 'ps4'), { groups, missing } = resolveConsoleFavorites(library, body.favoriteIds)
    if (!groups.size) throw new Error('Избранные игры отсутствуют в библиотеке. Обновите список избранного.')
    missingFavorites = missing.length
    return library.filter(pkg => groups.has(pkg.titleId || pkg.id)).sort((a,b) => (a.titleId || a.id).localeCompare(b.titleId || b.id) || a.installOrder - b.installOrder || a.fileName.localeCompare(b.fileName))
  })() : body.action === 'install-preset' ? inConsoleScope(ip, () => presetSelection(body.gameId)) : consoleSelection(body.presetId ? inConsoleScope(ip, () => resolvePreset(getPreset(body.presetId))).flatMap(entry => entry.pkg ? [entry.pkg] : []) : filterContent(getLibraryPackages(ip), 'ps4'), body.gameId, body.action, body.packageIds) }
  catch (e: any) { throw createError({ statusCode: 400, message: e.message }) }
  const record: Record = { id: body.requestId, ip, fingerprint, state: 'pending', message: 'WEB проверяет команду' }
  // Persist before any side effect. Lost responses are polled, never resubmitted.
  live.add(record.id); try { save(record) } catch (e) { live.delete(record.id); throw e }
  void (async () => {
    try {
      if (review) {
        const { submitNativeInstallReview } = await import('./native-install-review')
        const result = await submitNativeInstallReview(body, 'ps4', `localhost:${port}`)
        record.result = result; record.message = result.message
        if (result.state !== 'queued') record.state = result.state === 'uncertain' ? 'uncertain' : 'failed'
      } else if (taskControl) {
        record.result = body.action === 'stop-reinstall' ? await (await import('./selected-reinstallation')).stopSelectedReinstall(ip, body.maintenanceId)
          : removeInstallationTasks(ip, body.queueId, body.action === 'remove-items' ? body.packageIds : undefined, body.action === 'remove-games' ? body.gameIds : undefined)
        record.message = (record.result as { message: string }).message
      } else if (body.action === 'clear-tasks') { record.result = clearFinishedTasks([], ip); record.message = 'Завершённые задания и ошибки убраны из списка' } else if (control) {
        const active = getInstallationQueue(ip)
        const selection = ['cancel-item', 'cancel-game', 'cancel-items', 'cancel-games'].includes(body.action)
        if (!selection && (active.id !== body.queueId || active.psIp !== ip || active.transport !== 'service' || !(body.action === 'cancel-all' ? ['running', 'cancelling', 'failed'].includes(active.status) : ['running', 'cancelling'].includes(active.status))))
          throw createError({ statusCode: 409, message: 'Очередь изменилась. Обновите «Задания»' })
        const queue = body.action === 'cancel-items' ? cancelInstallationItems(body.queueId, body.packageIds, ip) : body.action === 'cancel-games' ? cancelGameInstallations(body.queueId, ip, body.gameIds) : body.action === 'cancel-item' ? cancelInstallationItem(body.queueId, body.currentPackageId, ip) : body.action === 'cancel-current' ? cancelCurrentInstallation(body.queueId, body.currentPackageId, ip) : body.action === 'cancel-game' ? cancelGameInstallation(body.queueId, ip, body.gameId) : cancelInstallationQueue(ip)
        record.result = { queueId: queue.id }; record.message = 'Отмена запрошена; ожидаем подтверждение PS4'
      } else if (body.action === 'reinstall-preview') {
        const plan = await reinstallPlan(ip, packages[0]!.id)
        record.result = { packageId: plan.packageId, titleId: plan.details.app.titleId, revision: plan.details.revision,
          components: plan.details.components.map(c => ({ id: c.id, title: c.title, kind: c.kind })) }
        record.message = 'Состав игры проверен; подтвердите удаление и переустановку'
      } else {
        if (!packages.length) throw createError({ statusCode: 400, message: 'В этой игре нет пакетов выбранного типа' })
        const pcIp = await getLocalIp(ip)
        const urls = Object.fromEntries(packages.map(p => [p.id, `http://${pcIp}:${port}/json/${p.id}.json`]))
        if (body.action === 'reinstall') {
          const flow = await beginReinstall(ip, { packageId: packages[0]!.id, url: urls[packages[0]!.id], revision: body.revision, confirmTitleId: body.confirmTitleId, bundle: { packageIds: packages.map(p => p.id), packageUrls: urls } })
          record.result = { queueId: flow.id }; record.message = flow.message
          if (flow.state === 'failed' || flow.state === 'uncertain') record.state = flow.state
        } else {
          const active = getInstallationQueue(ip)
          if (active.status === 'running' && (active.psIp !== ip || active.transport !== 'service'))
            throw createError({ statusCode: 409, message: 'Работает другая очередь. Дождитесь её завершения.' })
          const queue = active.status === 'running'
            ? appendInstallationQueue({ psIp: ip, queueId: active.id!, packageIds: packages.map(p => p.id), packageUrls: urls })
            : startInstallationQueue({ psIp: ip, packageIds: packages.map(p => p.id), packageUrls: urls, transport: 'service' })
          record.result = { queueId: queue.id, missingFavorites }; record.message = missingFavorites
            ? `Доступное избранное добавлено в очередь. Отсутствующих записей: ${missingFavorites}` : 'Пакеты добавлены в общую очередь WEB / PS4'
        }
      }
      if (record.state === 'pending') record.state = 'accepted'
    } catch (e: any) { record.state = 'failed'; record.message = e?.message || 'Команда не принята' }
    finally { save(record); live.delete(record.id) }
  })().catch(() => { live.delete(record.id) })
  return publicRecord(record)
}
