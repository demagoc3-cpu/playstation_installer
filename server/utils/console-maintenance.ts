import { randomUUID } from 'node:crypto'
import { createError } from 'h3'
import { statSync } from 'node:fs'
import { ps4ServiceIp, readPs4Service } from './ps4-service'
import { readMaintenance, saveMaintenance, assertNoMaintenance } from './maintenance-store'
import { getPackage, readPackageMetadata } from './package-library'
import { getConsoleDetails, submitConsoleRemoval, getConsoleRemoval } from './ps4-console-apps'
import { getInstallationQueue, startInstallationQueue } from './installation-queue'
import { assertNoInstallation, assertNoRemoval } from './console-operation-store'
import { consoleRuntime, submitConsoleControl, confirmConsoleRestart } from './console-control'
import { getServiceInstallJob, submitServiceUpdate } from './ps4-service-installer'
const locks = new Set<string>()
function address(v: unknown) { const ip = ps4ServiceIp(v); if (!ip) throw createError({ statusCode: 400, message: 'Укажите IP PS4' }); return ip }
function set(ip: string, flow: any) { const all = readMaintenance(); all[ip] = flow; saveMaintenance(all) }
export async function reinstallPlan(ipValue: unknown, packageId: unknown) {
  const ip = address(ipValue); const pkg = getPackage(String(packageId || ''))
  if (pkg.contentType !== 'PS4GD') throw createError({ statusCode: 400, message: 'Переустановка целиком доступна для базовой игры' })
  const actual = await readPackageMetadata(pkg.path, pkg.fileName)
  if (actual.titleId !== pkg.titleId || actual.contentId !== pkg.contentId || actual.contentType !== 'PS4GD' || statSync(pkg.path).size !== pkg.size)
    throw createError({ statusCode: 409, message: 'PKG изменился после сканирования. Просканируйте библиотеку заново' })
  const details = await getConsoleDetails(ip, pkg.titleId)
  if (!details.app.installed || details.app.protected || !details.complete || !details.components.some(c => c.kind === 'base') || details.components.some(c => !c.canRemove)) throw createError({ statusCode: 409, message: 'Состав игры не подтверждён для переустановки. Обновите «На консоли»' })
  return { packageId: pkg.id, title: pkg.title, details }
}
export async function beginReinstall(ipValue: unknown, body: any) {
  const ip = address(ipValue); assertNoMaintenance(ip); assertNoInstallation(ip); assertNoRemoval(ip)
  const plan = await reinstallPlan(ip, body.packageId)
  if (body.confirmTitleId !== plan.details.app.titleId || body.revision !== plan.details.revision) throw createError({ statusCode: 409, message: 'Состав игры изменился; откройте подтверждение заново' })
  const runtime = await consoleRuntime(ip, plan.details.app.titleId)
  if (runtime.running) throw createError({ statusCode: 409, message: 'Сначала остановите игру в разделе «На консоли»' })
  if (typeof body.url !== 'string' || !/^https?:\/\//.test(body.url)) throw createError({ statusCode: 400, message: 'Не найден адрес PKG' })
  assertNoMaintenance(ip); assertNoInstallation(ip); assertNoRemoval(ip)
  const flow: any = { id: randomUUID(), kind: 'reinstall', state: 'removing', title: plan.title, packageId: plan.packageId, url: body.url,
    removal: { requestId: randomUUID(), titleId: plan.details.app.titleId, kind: 'game', componentId: 'all', revision: body.revision, confirmTitleId: body.confirmTitleId }, message: 'Удаляем прежнюю игру и её дополнения перед переустановкой', dispatched: true }
  set(ip, flow)
  try { flow.removalResult = await submitConsoleRemoval(ip, flow.removal, flow.id) } catch (e: any) { flow.message = e.message; flow.state = 'uncertain' }
  set(ip, flow); return getMaintenance(ip)
}
export async function beginUpdate(ipValue: unknown, input: any, targetVersion: string) {
  const ip = address(ipValue); assertNoMaintenance(ip); assertNoInstallation(ip); assertNoRemoval(ip)
  const flow: any = { id: randomUUID(), kind: 'update', state: 'installing', targetVersion, input, message: 'Устанавливаем новый запускатель. Фоновый сервис пока продолжает работать', dispatched: true }
  set(ip, flow)
  try { flow.job = await submitServiceUpdate(ip, input) }
  catch (e: any) { flow.message = e.message; if ([400, 401, 403, 404, 409, 503].includes(e.statusCode)) flow.state = 'failed'; else flow.state = 'uncertain' }
  set(ip, flow); return flow
}
export async function getMaintenance(ipValue: unknown) {
  const ip = address(ipValue); let flow = readMaintenance()[ip]; if (!flow || locks.has(ip)) return flow || null
  if (['completed', 'failed', 'restart_ready'].includes(flow.state)) return flow
  locks.add(ip)
  try {
    if (flow.kind === 'reinstall' && ['removing', 'uncertain'].includes(flow.state) && !flow.installDispatch) {
      const r = await getConsoleRemoval(ip, flow.removal.requestId); flow.removalResult = r
      if (!r) { flow.state = 'uncertain'; flow.message = 'Задание удаления не найдено. Проверьте игру на PS4; повтор не отправлен' }
      else if (['failed', 'partial'].includes(r.state)) { flow.state = 'failed'; flow.message = r.message || 'Удаление не завершено; установка не начата' }
      else if (r.state === 'removed') {
        flow.state = 'installing'; flow.installDispatch = true; flow.message = 'Удаление подтверждено. Устанавливаем выбранный базовый PKG'; set(ip, flow)
        const previous = getInstallationQueue()
        if (previous.id === flow.id) flow.queue = previous
        else flow.queue = startInstallationQueue({ psIp: ip, packageIds: [flow.packageId], packageUrls: { [flow.packageId]: flow.url }, transport: 'service', maintenanceId: flow.id })
      }
    }
    if (flow.kind === 'reinstall' && flow.installDispatch) {
      const q = getInstallationQueue()
      if (q.id !== flow.id) { flow.state = 'uncertain'; flow.message = 'Очередь переустановки не найдена. Повтор не отправлен' }
      else { flow.queue = q; flow.message = q.message; if (q.status === 'completed' && q.items.every(i => i.state === 'installed')) flow.state = 'completed'; else if (['failed', 'cancelled'].includes(q.status)) flow.state = 'failed' }
    }
    if (flow.kind === 'update' && ['installing', 'uncertain'].includes(flow.state)) {
      flow.job = await getServiceInstallJob(ip, flow.input.requestId)
      if (flow.job.state === 'installed') { flow.state = 'restart_ready'; flow.message = 'Новый запускатель установлен. Закройте активную игру и перезапустите сервис' }
      else if (['failed', 'cancelled'].includes(flow.job.state)) { flow.state = 'failed'; flow.message = `PS4 не установила обновление: ${flow.job.errorHex}` }
      else flow.message = `Обновление: ${flow.job.state} · ${flow.job.downloadedBytes} из ${flow.job.downloadTotalBytes} байт`
    }
    if (flow.kind === 'update' && flow.state === 'restarting') {
      const r = await readPs4Service(ip, '/system/info'); const v = r.body as any
      if (r.status === 200 && v.service === 'PackegeFlowService' && v.environment === 'ps4' && v.pkgVersion === flow.targetVersion) { confirmConsoleRestart(ip, flow.restartId); flow.state = 'completed'; flow.message = `Обновление подтверждено: PKG ${v.pkgVersion}` }
      else flow.message = 'Ждём ответа новой версии. Если запускатель не открылся, запустите его на PS4 вручную'
    }
  } catch (e: any) { flow.message = `${e.message || 'Связь прервалась'}. Повтор установки не отправлен` }
  finally { set(ip, flow); locks.delete(ip) }
  return flow
}
export async function restartUpdatedService(ipValue: unknown) {
  const ip = address(ipValue); const flow = readMaintenance()[ip]
  if (!flow || flow.kind !== 'update' || flow.state !== 'restart_ready') throw createError({ statusCode: 409, message: 'Сначала дождитесь подтверждения установки обновления' })
  flow.state = 'restarting'; flow.restartId = randomUUID(); flow.message = 'Запускатель заменит демон; подключение кратковременно прервётся'; set(ip, flow)
  try { flow.control = await submitConsoleControl(ip, { requestId: flow.restartId, titleId: 'PFLS00001', action: 'restart', expected: flow.input.requestId }, true, flow.id); if (flow.control?.state === 'failed') { flow.state = 'restart_ready'; flow.message = 'PS4 отказала в запуске. Закройте игру и откройте запускатель вручную' } }
  catch (e: any) { flow.message = `${e.message}. Откройте новый запускатель на PS4 вручную` }
  set(ip, flow); return flow
}
