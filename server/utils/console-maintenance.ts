import { createHash, randomUUID } from 'node:crypto'
import { createError } from 'h3'
import { readFileSync, statSync } from 'node:fs'
import { ps4ServiceIp, readPs4Service } from './ps4-service'
import { readMaintenance, saveMaintenance, assertNoMaintenance } from './maintenance-store'
import { getPackage, getLibraryPackages, readPackageMetadata } from './package-library'
import { checkPs4Firmware } from './installation-firmware'
import { getConsoleCatalog, getConsoleDetails, submitConsoleRemoval, getConsoleRemoval } from './ps4-console-apps'
import { getInstallationQueue, startInstallationQueue } from './installation-queue'
import { assertNoInstallation, assertNoRemoval } from './console-operation-store'
import { consoleRuntime, submitConsoleControl, confirmConsoleRestart, failConsoleRestart } from './console-control'
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
  const firmware = await checkPs4Firmware(ip, actual)
  if (firmware.state !== 'compatible') throw createError({ statusCode: firmware.state === 'unavailable' ? 503 : 409, message: firmware.detail })
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
  let bundle: { packageIds: string[]; packageUrls: Record<string, string> } | undefined
  if (body.bundle !== undefined) {
    const group = getLibraryPackages().filter(p => p.titleId === plan.details.app.titleId)
      .sort((a, b) => a.installOrder - b.installOrder || a.fileName.localeCompare(b.fileName))
    const ids = group.map(p => p.id)
    if (!Array.isArray(body.bundle?.packageIds) || JSON.stringify(body.bundle.packageIds) !== JSON.stringify(ids) || ids[0] !== plan.packageId || ids.some(id => typeof body.bundle.packageUrls?.[id] !== 'string' || !/^https?:\/\//.test(body.bundle.packageUrls[id])))
      throw createError({ statusCode: 409, message: 'Комплект переустановки изменился. Обновите карточку игры' })
    bundle = { packageIds: ids, packageUrls: Object.fromEntries(ids.map(id => [id, body.bundle.packageUrls[id]])) }
  }
  assertNoMaintenance(ip); assertNoInstallation(ip); assertNoRemoval(ip)
  const flow: any = { id: randomUUID(), kind: 'reinstall', state: 'removing', title: plan.title, packageId: plan.packageId, url: body.url, bundle,
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
  if (flow.kind === 'update' && flow.state === 'restart_ready') {
    try {
      const r = await readPs4Service(ip, '/system/info'); const v = r.body as any
      if (r.status === 200 && v.service === 'PackegeFlowService' && v.environment === 'ps4' && v.pkgVersion === flow.targetVersion) {
        flow.state = 'completed'; flow.message = `Обновление подтверждено: PKG ${v.pkgVersion}`; set(ip, flow)
      }
    } catch { /* Keep the previous state until the new daemon responds. */ }
  }
  if (flow.kind === 'update' && flow.state === 'failed') {
    try {
      const r = await readPs4Service(ip, '/system/info'); const v = r.body as any
      if (r.status === 200 && v.service === 'PackegeFlowService' && v.environment === 'ps4' && v.pkgVersion === flow.targetVersion) {
        flow.state = 'completed'; flow.message = `Обновление подтверждено: PKG ${v.pkgVersion}`; set(ip, flow)
      }
    } catch { /* Keep the failure visible while the console is unreachable. */ }
  }
  if (['completed', 'failed', 'restart_ready'].includes(flow.state)) return flow
  locks.add(ip)
  try {
    if (flow.kind === 'reinstall' && ['removing', 'uncertain'].includes(flow.state) && !flow.installDispatch) {
      const r = await getConsoleRemoval(ip, flow.removal.requestId); flow.removalResult = r
      if (!r) { flow.state = 'uncertain'; flow.message = 'Задание удаления не найдено. Проверьте игру на PS4; повтор не отправлен' }
      else if (['failed', 'partial'].includes(r.state)) { flow.state = 'failed'; flow.message = r.message || 'Удаление не завершено; установка не начата' }
      else if (r.state === 'removed') {
        flow.state = 'installing'; flow.installDispatch = true; flow.message = flow.bundle ? 'Удаление подтверждено. Устанавливаем игру, патчи и DLC по очереди' : 'Удаление подтверждено. Устанавливаем выбранный базовый PKG'; set(ip, flow)
        const previous = getInstallationQueue()
        if (previous.id === flow.id) flow.queue = previous
        else flow.queue = startInstallationQueue({ psIp: ip, packageIds: flow.bundle?.packageIds || [flow.packageId], packageUrls: flow.bundle?.packageUrls || { [flow.packageId]: flow.url }, transport: 'service', maintenanceId: flow.id })
      }
    }
    if (flow.kind === 'reinstall' && flow.installDispatch) {
      const q = getInstallationQueue()
      if (q.id !== flow.id) { flow.state = 'uncertain'; flow.message = 'Очередь переустановки не найдена. Повтор не отправлен' }
      else { flow.queue = q; flow.message = q.message; if (q.status === 'completed') flow.state = q.items.every(i => i.state === 'installed') ? 'completed' : 'failed'; else if (['failed', 'cancelled'].includes(q.status)) flow.state = 'failed' }
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

/** Recover an update whose old BGFT job finished but whose launcher was removed. */
export async function reinstallMissingLauncher(ipValue: unknown) {
  const ip = address(ipValue); const flow = readMaintenance()[ip]
  if (!flow || flow.kind !== 'update' || flow.state !== 'restarting' || !flow.restartId || flow.job?.state !== 'installed')
    throw createError({ statusCode: 409, message: 'Нет обновления с ожидающим перезапуском' })
  assertNoInstallation(ip); assertNoRemoval(ip)
  const current = await readPs4Service(ip, '/system/info'); const info = current.body as any
  if (current.status !== 200 || info?.service !== 'PackegeFlowService' || info.environment !== 'ps4' || typeof info.pkgVersion !== 'string' || info.pkgVersion === flow.targetVersion)
    throw createError({ statusCode: 409, message: 'Текущая версия службы не подтверждает необходимость восстановления' })
  const catalog = await getConsoleCatalog(ip)
  if (!catalog.complete || catalog.apps.some(app => app.titleId === 'PFLS00001') || (await consoleRuntime(ip, 'PFLS00001')).running)
    throw createError({ statusCode: 409, message: 'Запускатель ещё установлен или список PS4 прочитан не полностью' })
  const oldJob = await getServiceInstallJob(ip, flow.input.requestId)
  if (oldJob.state !== 'installed') throw createError({ statusCode: 409, message: 'Прежнее задание установки ещё не завершено' })
  const match = /^http:\/\/[^/]+\/service-update\/manifest\/([0-9a-f-]{36})\.json$/.exec(flow.input.url || '')
  if (!match) throw createError({ statusCode: 409, message: 'Не найден сохранённый локальный PKG' })
  const { serviceArtifact } = await import('./service-updates')
  const artifact = serviceArtifact(match[1])
  if (artifact.version !== flow.targetVersion || artifact.size !== flow.input.size) throw createError({ statusCode: 409, message: 'Сохранённый PKG не совпадает с обновлением' })
  const previousRestartId = flow.restartId
  flow.previousAttempt = { requestId: flow.input.requestId, restartId: previousRestartId }
  flow.input = { ...flow.input, requestId: randomUUID() }
  flow.restartId = undefined; flow.job = undefined; flow.control = undefined
  flow.state = 'installing'; flow.message = 'Повторно устанавливаем локальный PKG после удаления запускателя'
  failConsoleRestart(ip, previousRestartId, 'Запускатель удалён; начато восстановление из локального PKG')
  set(ip, flow)
  try { flow.job = await submitServiceUpdate(ip, flow.input) }
  catch (e: any) { flow.message = e.message || 'Не удалось подтвердить новую задачу'; flow.state = [400, 401, 403, 404, 409, 503].includes(e.statusCode) ? 'failed' : 'uncertain' }
  set(ip, flow); return getMaintenance(ip)
}

/** Replace a completed but stalled launcher update with a newer, verified local PKG. */
export async function replaceStalledUpdate(ipValue: unknown, artifactId: string, baseUrl: string) {
  const ip = address(ipValue); const flow = readMaintenance()[ip]
  if (!flow || flow.kind !== 'update' || flow.state !== 'restarting' || !flow.restartId || flow.job?.state !== 'installed' || locks.has(ip))
    throw createError({ statusCode: 409, message: 'Нет завершённого обновления с ожидающим запуском' })
  assertNoInstallation(ip); assertNoRemoval(ip)
  const { serviceArtifact, comparePkgVersions } = await import('./service-updates')
  const artifact = serviceArtifact(artifactId)
  if (comparePkgVersions(artifact.version, flow.targetVersion) <= 0 || createHash('sha256').update(readFileSync(artifact.path)).digest('hex') !== artifact.sha256)
    throw createError({ statusCode: 409, message: 'Выберите проверенный PKG новее ожидающей версии' })
  const current = await readPs4Service(ip, '/system/info'); const info = current.body as any
  if (current.status !== 200 || info?.service !== 'PackegeFlowService' || info.environment !== 'ps4' || typeof info.pkgVersion !== 'string' || comparePkgVersions(info.pkgVersion, artifact.version) >= 0)
    throw createError({ statusCode: 409, message: 'Текущая версия PS4 не подтверждает необходимость восстановления' })
  const catalog = await getConsoleCatalog(ip)
  if (!catalog.complete || (await consoleRuntime(ip, 'PFLS00001')).running)
    throw createError({ statusCode: 409, message: 'Закройте запускатель и обновите полный список приложений PS4' })
  const oldJob = await getServiceInstallJob(ip, flow.input.requestId)
  if (oldJob.state !== 'installed') throw createError({ statusCode: 409, message: 'Прежнее задание установки ещё не завершено' })
  const previousRestartId = flow.restartId
  const replacement: any = { id: randomUUID(), kind: 'update', state: 'installing', targetVersion: artifact.version,
    input: { requestId: randomUUID(), titleId: 'PFLS00001', contentId: 'IV0000-PFLS00001_00-PACKAGEFLOWSRV00', title: `PackageFlowService ${artifact.version}`,
      url: `${baseUrl}/service-update/manifest/${artifact.id}.json`, contentType: 'PS4GDE', size: artifact.size },
    previousAttempt: { requestId: flow.input.requestId, restartId: previousRestartId, targetVersion: flow.targetVersion },
    message: `Восстанавливаем обновление через локальный PKG ${artifact.version}`, dispatched: true }
  failConsoleRestart(ip, previousRestartId, `Запускатель PKG ${flow.targetVersion} не заменил работающую службу`)
  set(ip, replacement)
  try { replacement.job = await submitServiceUpdate(ip, replacement.input) }
  catch (e: any) { replacement.message = e.message || 'Не удалось подтвердить новую задачу'; replacement.state = [400, 401, 403, 404, 409, 503].includes(e.statusCode) ? 'failed' : 'uncertain' }
  set(ip, replacement); return getMaintenance(ip)
}
