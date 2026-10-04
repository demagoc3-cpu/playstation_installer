import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { createError } from 'h3'
import { readJsonFile, writeJsonFile } from './json-store'
import { getLibraryPackages } from './package-library'
import { getInstallationQueue, startInstallationQueue, appendInstallationQueue, cancelCurrentInstallation, cancelInstallationQueue, cancelGameInstallation } from './installation-queue'
import { beginReinstall, reinstallPlan } from './console-maintenance'
import { getLocalIp } from './ps4-installer'
import { consoleSelection } from './console-app-data'
import { ps4ServiceIp } from './ps4-service'

type Record = { id: string; ip: string; fingerprint: string; state: string; message: string; result?: unknown }
const file = resolve(process.cwd(), '.data/console-app-commands.json')
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
  if (!ip || !/^[a-f0-9]{32}$/.test(body?.requestId || '') || typeof body.gameId !== 'string' || !['all', 'selected', 'reinstall-preview', 'reinstall', 'patches', 'dlc', 'cancel-current', 'cancel-all', 'cancel-game'].includes(body.action))
    throw createError({ statusCode: 400, message: 'Некорректная команда приложения' })
  if (body.packageIds !== undefined && (!Array.isArray(body.packageIds) || body.packageIds.some((id: unknown) => typeof id !== 'string')))
    throw createError({ statusCode: 400, message: 'Некорректный выбор пакетов' })
  const fingerprint = createHash('sha256').update(JSON.stringify([ip, body.gameId, body.action, body.packageIds || [], body.confirmTitleId, body.revision, body.queueId, body.currentPackageId])).digest('hex')
  const existing = read().records.find(r => r.id === body.requestId)
  if (existing) {
    if (existing.ip !== ip || existing.fingerprint !== fingerprint) throw createError({ statusCode: 409, message: 'Идентификатор уже использован другой командой' })
    return consoleCommand(body.requestId, ip)
  }
  const control = body.action === 'cancel-current' || body.action === 'cancel-all' || body.action === 'cancel-game'
  if (control && (typeof body.queueId !== 'string' || !body.queueId || (body.action === 'cancel-current' && typeof body.currentPackageId !== 'string')))
    throw createError({ statusCode: 400, message: 'Не указано текущее задание' })
  let packages
  try { packages = control ? [] : consoleSelection(getLibraryPackages(), body.gameId, body.action, body.packageIds) }
  catch (e: any) { throw createError({ statusCode: 400, message: e.message }) }
  const record: Record = { id: body.requestId, ip, fingerprint, state: 'pending', message: 'WEB проверяет команду' }
  // Persist before any side effect. Lost responses are polled, never resubmitted.
  live.add(record.id); try { save(record) } catch (e) { live.delete(record.id); throw e }
  void (async () => {
    try {
      if (control) {
        const active = getInstallationQueue()
        if (active.id !== body.queueId || active.psIp !== ip || active.transport !== 'service' || !['running', 'cancelling'].includes(active.status))
          throw createError({ statusCode: 409, message: 'Очередь изменилась. Обновите «Задания»' })
        const queue = body.action === 'cancel-current' ? cancelCurrentInstallation(body.queueId, body.currentPackageId, ip) : body.action === 'cancel-game' ? cancelGameInstallation(body.queueId, ip, body.gameId) : cancelInstallationQueue()
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
          const active = getInstallationQueue()
          if (active.status === 'running' && (active.psIp !== ip || active.transport !== 'service'))
            throw createError({ statusCode: 409, message: 'Работает другая очередь. Дождитесь её завершения.' })
          const queue = active.status === 'running'
            ? appendInstallationQueue({ psIp: ip, queueId: active.id!, packageIds: packages.map(p => p.id), packageUrls: urls })
            : startInstallationQueue({ psIp: ip, packageIds: packages.map(p => p.id), packageUrls: urls, transport: 'service' })
          record.result = { queueId: queue.id }; record.message = 'Пакеты добавлены в общую очередь WEB / PS4'
        }
      }
      if (record.state === 'pending') record.state = 'accepted'
    } catch (e: any) { record.state = 'failed'; record.message = e?.message || 'Команда не принята' }
    finally { save(record); live.delete(record.id) }
  })().catch(() => { live.delete(record.id) })
  return publicRecord(record)
}
