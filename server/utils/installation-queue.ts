import { assertDesktopWritable } from './desktop-lifecycle'
import { dataPath } from './data-path'
import { logEvent } from './event-log'
import { assertNoFileInstallation } from './console-file-install-store'
import { assertNoRemoval } from './console-operation-store'
import { assertNoMaintenance } from './maintenance-store'
import { existsSync, readFileSync } from 'node:fs'

import { writeJsonFile } from './json-store'
import { blockPackageDelivery, getPackage, getLibraryPackages, getPackageDelivery, markPackageInstalled, readPackageIcon, readPackageMetadata, resetPackageDelivery } from './package-library'
import { sendPackage, startInstaller } from './ps4-installer'
import { randomUUID } from 'node:crypto'
import { installationTransport, serviceJobDetail } from './installation-transport'
import { getInstallationPreference } from './installation-preference'
import { checkPs4InstallSpace, installSpaceMessage } from './installation-space'
import { checkPs4Firmware } from './installation-firmware'
import { cancelServiceInstallJob, getServiceInstallJob, getServiceInstallerStatus, serviceKeyConfigured, submitServicePackage, uploadServiceInstallIcon } from './ps4-service-installer'
import type { InstallationTransport, ServiceInstallJob } from '../../shared/types/installation'

export type InstallationItemState = 'pending' | 'sending' | 'waiting' | 'receiving' | 'installing' | 'verifying' | 'delivered' | 'installed' | 'unconfirmed' | 'skipped' | 'failed' | 'cancelled'

interface InstallationQueueItem {
  packageId: string
  title?: string
  fileName?: string
  size?: number
  type?: string
  titleId?: string
  url: string
  state: InstallationItemState
  detail: string
  bytesSent: number
  dispatchedAt?: number
  completedAt?: number
  installedAt?: number
  requestId?: string
  serviceDispatchedAt?: number
  serviceJobId?: string
  serviceTaskId?: number
  serviceIdleSince?: number
  serviceProgress?: string
  cancelRequested?: boolean
  serviceStallCancelled?: boolean
}

interface InstallationQueue {
  version: 1
  status: 'idle' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'
  transport?: InstallationTransport
  maintenanceId?: string
  id?: string
  psIp?: string
  items: InstallationQueueItem[]
  currentIndex?: number
  createdAt?: number
  updatedAt?: number
  message?: string
}

const queuePath = dataPath('installation-queue.json')
const historyPath = dataPath('installation-history.json')
const WAIT_INTERVAL_MS = 1500
const UNCONFIRMED_AFTER_MS = 20_000
const STALLED_DLC_MS = 3 * 60_000
const STALLED_PATCH_MS = 10 * 60_000
const STALLED_GAME_MS = 15 * 60_000
const STALLED_CANCEL_RETRY_MS = 60_000
let runner: Promise<void> | undefined

const blankQueue = (): InstallationQueue => ({ version: 1, status: 'idle', items: [] })

function readQueue(): InstallationQueue {
  try {
    const queue = JSON.parse(readFileSync(queuePath, 'utf8')) as InstallationQueue
    if (queue.version !== 1 || !Array.isArray(queue.items)) return blankQueue()
    try { queue.transport = installationTransport(queue.transport) }
    catch { queue.status = 'failed'; queue.message = 'Неизвестный сохранённый способ установки; повтор не отправлен' }
    return queue
  } catch { return blankQueue() }
}

function writeQueue(queue: InstallationQueue) {
  queue.updatedAt = Date.now()
  writeJsonFile(queuePath, queue)
}

function publicQueue(queue: InstallationQueue) {
  const missing = queue.items.some(item => !item.fileName)
  const packages = missing ? new Map(getLibraryPackages().map(item => [item.id, item])) : new Map()
  return { ...queue, items: queue.items.map((item) => {
    const pkg = packages.get(item.packageId)
    return { ...item, title: item.title || pkg?.title || item.packageId, fileName: item.fileName || pkg?.fileName || item.packageId,
      size: item.size ?? pkg?.size ?? 0, type: item.type || pkg?.type || 'PKG', titleId: item.titleId || pkg?.titleId || '' }
  }) }
}

export function getInstallationHistory(): InstallationQueue[] {
  try {
    const history = JSON.parse(readFileSync(historyPath, 'utf8'))
    return Array.isArray(history) ? history.filter(queue => queue.version === 1 && queue.id && Array.isArray(queue.items)).slice(0, 10) : []
  } catch { return [] }
}
function archiveQueue(queue: InstallationQueue) {
  if (!queue.id || !queue.items.length) return
  writeJsonFile(historyPath, [publicQueue(queue), ...getInstallationHistory().filter(previous => previous.id !== queue.id)].slice(0, 10))
}

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS))
const ACTIVE_STATES: InstallationItemState[] = ['pending', 'sending', 'waiting', 'receiving', 'installing', 'verifying']

function stillCurrent(queue: InstallationQueue, index: number, status: InstallationQueue['status'] = 'running') {
  const updated = readQueue()
  return updated.status === status && updated.id === queue.id && updated.createdAt === queue.createdAt &&
    updated.items[index]?.packageId === queue.items[index]?.packageId &&
    ACTIVE_STATES.includes(updated.items[index]!.state) ? updated : null
}
function applyServiceJob(item: InstallationQueueItem, job: ServiceInstallJob) {
  item.serviceJobId = job.jobId; item.serviceTaskId = job.taskId
  item.bytesSent = job.downloadedBytes; item.detail = serviceJobDetail(job)
  item.state = job.state === 'installed' ? 'installed' : job.state === 'failed' ? 'failed' : job.state === 'cancelled' ? 'cancelled' :
    job.state === 'installing' ? 'installing' : job.state === 'uncertain' || job.state === 'cancelling' || job.pollError ? 'verifying' : job.downloadedBytes ? 'receiving' : 'waiting'
  if (item.state === 'failed' && job.errorHex.toUpperCase() === '0XFFFFD8D0') item.state = 'unconfirmed'
  if (item.state === 'installed') {
    item.completedAt ??= Date.now(); item.installedAt ??= Date.now(); markPackageInstalled(item.packageId, true)
  }
  if (item.serviceStallCancelled && item.state === 'cancelled') {
    item.state = 'unconfirmed'
    item.detail = 'PS4 не подтвердила установку после полной загрузки. Задание снято; проверьте результат на приставке'
  }
}
function stalledServiceJob(item: InstallationQueueItem, job: ServiceInstallJob, contentType: string, now = Date.now()) {
  const downloaded = job.downloadTotalBytes > 0 && job.downloadedBytes >= job.downloadTotalBytes
  const idle = job.state === 'installing' && downloaded && !job.pollError && !job.error && !job.installing && !job.updating
  if (!idle) { item.serviceIdleSince = undefined; item.serviceProgress = undefined; return false }
  const progress = [job.downloadedBytes, job.downloadTotalBytes, job.progressBits, job.preparingPercent, job.localCopyPercent].join(':')
  if (item.serviceProgress !== progress || !item.serviceIdleSince) {
    item.serviceProgress = progress
    item.serviceIdleSince = now
    return false
  }
  const limit = ['PS4AC', 'PS4AL'].includes(contentType) ? STALLED_DLC_MS : contentType === 'PS4GP' ? STALLED_PATCH_MS : STALLED_GAME_MS
  return now - item.serviceIdleSince >= limit
}
async function cancelServicePass(queue: InstallationQueue) {
  for (let index = 0; index < queue.items.length; index++) {
    const item = queue.items[index]!
    if (!ACTIVE_STATES.includes(item.state)) continue
    if (!item.serviceDispatchedAt || !item.requestId) { item.state = 'cancelled'; item.detail = 'Не отправлен: очередь отменена'; continue }
    try {
      const previous = await getServiceInstallJob(queue.psIp!, item.requestId)
      if (previous.state === 'cancelling' && previous.errorHex.toUpperCase() === '0X80990019') {
        if (!stillCurrent(queue, index, 'cancelling')) return
        item.state = 'unconfirmed'
        item.detail = 'Задача удалена на PS4 (0x80990019); установка не подтверждена'
        continue
      }
      const job = ['installed', 'failed', 'cancelled'].includes(previous.state) ? previous : await cancelServiceInstallJob(queue.psIp!, item.requestId)
      if (!stillCurrent(queue, index, 'cancelling')) return
      applyServiceJob(item, job)
    } catch (error: any) {
      if (!stillCurrent(queue, index, 'cancelling')) return
      item.state = 'verifying'; item.detail = error?.statusCode ? error.message : 'Связь потеряна; отмена принятого задания ещё не подтверждена'
    }
  }
  if (!queue.items.some(item => ACTIVE_STATES.includes(item.state))) {
    queue.status = 'cancelled'; queue.currentIndex = undefined
    queue.message = queue.items.some(item => item.state === 'unconfirmed')
      ? 'Очередь освобождена: системная задача PS4 удалена. Установка не подтверждена; перед новым заданием обновите службу.'
      : 'Очередь остановлена; результаты принятых заданий получены с PS4'
  } else queue.message = 'Ожидаем подтверждение отмены с PS4; новые задания не отправляются'
  if (readQueue().status !== 'cancelling' || readQueue().id !== queue.id) return
  writeQueue(queue)
}

async function runQueue() {
  try {
    while (true) {
      let queue = readQueue()
      if (queue.status === 'cancelling' && queue.transport === 'service' && queue.psIp) {
        await cancelServicePass(queue)
        if (readQueue().status !== 'cancelling') return
        await pause(); continue
      }
      if (queue.status !== 'running' || !queue.psIp) return
      const index = queue.items.findIndex((item) => ACTIVE_STATES.includes(item.state))
      if (index < 0) {
        queue.status = 'completed'
        queue.currentIndex = undefined
        const unconfirmed = queue.items.filter(item => item.state === 'unconfirmed').length
        const skipped = queue.items.filter(item => item.state === 'skipped').length
        const installed = queue.items.filter(item => item.state === 'installed').length
        const failed = queue.items.filter(item => item.state === 'failed').length
        const cancelled = queue.items.filter(item => item.state === 'cancelled').length
        queue.message = queue.transport === 'service' ? failed || cancelled || skipped || unconfirmed
          ? `Очередь завершена: PS4 подтвердила ${installed} пак., с ошибкой — ${failed}, отменено — ${cancelled}, без подтверждения — ${unconfirmed}, пропущено — ${skipped}. Причины указаны у пакетов.`
          : 'PS4 подтвердила установку всех пакетов очереди.' : unconfirmed
          ? `Очередь отправлена; для ${unconfirmed} пак. скачивание не подтверждено. Проверьте загрузки PS4.`
          : 'Все пакеты переданы PlayStation по очереди: игра → патчи/бэкпорты → DLC. Финальный результат проверьте на PS4.'
        logEvent(unconfirmed || skipped || failed || cancelled ? 'warn' : 'info', queue.message)
        writeQueue(queue)
        return
      }

      queue.currentIndex = index
      let item = queue.items[index]!
      const packageInfo = getPackage(item.packageId)

      if (queue.transport === 'service') {
        try {
          if (item.cancelRequested) {
            if (!item.serviceDispatchedAt || !item.requestId) {
              item.state = 'cancelled'; item.completedAt = Date.now(); item.detail = 'Не отправлен: пакет отменён'; writeQueue(queue); continue
            }
            const previous = await getServiceInstallJob(queue.psIp, item.requestId)
            const stopped = ['installed', 'failed', 'cancelled'].includes(previous.state) || (previous.state === 'cancelling' && previous.errorHex.toUpperCase() === '0X80990019')
              ? previous : await cancelServiceInstallJob(queue.psIp, item.requestId)
            const latest = stillCurrent(queue, index); if (!latest) return
            const target = latest.items[index]!
            applyServiceJob(target, stopped)
            if (stopped.state === 'cancelling' && stopped.errorHex.toUpperCase() === '0X80990019') {
              target.state = 'unconfirmed'; target.detail = 'Задача удалена на PS4; установка не подтверждена'
            }
            if (ACTIVE_STATES.includes(target.state)) target.detail = 'Ожидаем подтверждение отмены текущего пакета с PS4'
            writeQueue(latest)
            if (ACTIVE_STATES.includes(target.state)) await pause()
            continue
          }
          let job: ServiceInstallJob
          if (!item.serviceDispatchedAt) {
            if (packageInfo.contentType === 'PS4GDE') {
              const capability = await getServiceInstallerStatus(queue.psIp)
              if (!capability.ready) throw createError({ statusCode: 503, message: capability.message })
              if (!capability.contentTypes.includes('PS4GDE')) throw createError({ statusCode: 409, message: 'Для установки приложений PS4GDE обновите PackageFlowService до PKG 1.69 или новее' })
            }
            // Old library indexes predate firmware fields; read the original PKG
            // before dispatch so a stale cache cannot bypass the check.
            const metadata = packageInfo.requiredFirmware || packageInfo.sdkFirmware ? packageInfo
              : await readPackageMetadata(packageInfo.path, packageInfo.fileName).catch(() => packageInfo)
            const firmware = await checkPs4Firmware(queue.psIp, metadata)
            const checked = stillCurrent(queue, index); if (!checked) return
            queue = checked; item = queue.items[index]!
            if (item.cancelRequested) continue
            if (firmware.state !== 'compatible') {
              item.state = firmware.state === 'unavailable' ? 'pending' : 'skipped'
              item.detail = firmware.detail
              queue.message = `«${packageInfo.title}»: ${firmware.detail}`
              writeQueue(queue)
              if (firmware.state === 'unavailable') { await pause(); continue }
              logEvent('warn', queue.message)
              continue
            }
            const space = await checkPs4InstallSpace(queue.psIp, packageInfo.size)
            const refreshed = stillCurrent(queue, index); if (!refreshed) return
            queue = refreshed; item = queue.items[index]!
            if (item.cancelRequested) continue
            if (space.state !== 'enough') {
              item.state = space.state === 'insufficient' ? 'failed' : 'pending'
              item.detail = installSpaceMessage(space)
              queue.message = `«${packageInfo.title}»: ${item.detail}`
              if (space.state === 'insufficient') {
                queue.status = 'failed'
                for (const following of queue.items) if (following !== item && following.state === 'pending') {
                  following.state = 'cancelled'
                  following.detail = 'Не отправлен: очередь остановлена из-за нехватки места'
                }
              }
              writeQueue(queue)
              if (space.state === 'insufficient') { logEvent('warn', queue.message); return }
              await pause(); continue
            }
            item.requestId ??= randomUUID()
            item.state = 'sending'; item.detail = 'Отправляем задание сервису PS4…'; resetPackageDelivery(item.packageId); writeQueue(queue)
            const icon = await readPackageIcon(item.packageId).catch(() => undefined)
            if (icon) {
              try { await uploadServiceInstallIcon(queue.psIp, packageInfo.titleId, item.requestId, icon) }
              catch (error: any) { logEvent('warn', `Обложка «${packageInfo.title}» не передана на PS4: ${error?.message || error}`) }
            }
            const beforeDispatch = stillCurrent(queue, index); if (!beforeDispatch) return
            if (beforeDispatch.items[index]!.cancelRequested) continue
            beforeDispatch.items[index]!.serviceDispatchedAt = Date.now()
            beforeDispatch.items[index]!.dispatchedAt = Date.now()
            writeQueue(beforeDispatch)
            job = await submitServicePackage(queue.psIp, { requestId: item.requestId, titleId: packageInfo.titleId, contentId: packageInfo.contentId,
              title: packageInfo.title, url: item.url, contentType: packageInfo.contentType, size: packageInfo.size })
          } else {
            // The dispatch boundary is durable before the POST. A lost reply or
            // server restart only resumes GETs for that ID, never another POST.
            if (!item.requestId) throw createError({ statusCode: 409, message: 'Идентификатор принятого задания неизвестен; проверьте PS4' })
            job = await getServiceInstallJob(queue.psIp, item.requestId)
          }
          const updated = stillCurrent(queue, index) || stillCurrent(queue, index, 'cancelling'); if (!updated) return
          const current = updated.items[index]!
          applyServiceJob(current, job)
          const stalled = updated.status === 'running' && (current.serviceStallCancelled
            ? (job.state === 'cancelling' || job.state === 'uncertain') && Date.now() - (current.serviceIdleSince || Date.now()) >= STALLED_CANCEL_RETRY_MS
            : stalledServiceJob(current, job, packageInfo.contentType))
          updated.message = `${index + 1} из ${updated.items.length}: «${packageInfo.title}». ${current.detail}`
          writeQueue(updated)
          if (updated.status !== 'running') return
          if (stalled) {
            // BGFT can retain a suspended task with 100% transferred and no
            // error code. Stop it only after an extended period with no copy,
            // preparation, or AppInst activity; never infer installation.
            try {
              const stopped = await cancelServiceInstallJob(queue.psIp, item.requestId!)
              const latest = stillCurrent(updated, index); if (!latest) return
              const stalledItem = latest.items[index]!
              stalledItem.serviceStallCancelled = true
              stalledItem.serviceIdleSince = Date.now()
              applyServiceJob(stalledItem, stopped)
              if (stalledItem.state === 'verifying') stalledItem.detail = 'PS4 не подтвердила установку; ожидаем снятия остановленного задания'
              latest.message = `${index + 1} из ${latest.items.length}: «${packageInfo.title}». ${stalledItem.detail}`
              writeQueue(latest)
              continue
            } catch (error: any) {
              const latest = stillCurrent(updated, index); if (!latest) return
              latest.items[index]!.serviceIdleSince = Date.now()
              latest.items[index]!.detail = `Полная загрузка без подтверждения PS4; снять задание пока не удалось (${error?.message || 'нет ответа'})`
              latest.message = latest.items[index]!.detail
              writeQueue(latest)
              await pause(); continue
            }
          }
          if (current.state === 'installed') { logEvent('info', `PackageFlowService подтвердил установку «${packageInfo.title}» (задание PS4 ${job.taskId})`); continue }
          if (current.state === 'failed' || current.state === 'cancelled' || current.state === 'unconfirmed') {
            logEvent('warn', `PackageFlowService не установил «${packageInfo.title}»: ${current.detail}. Очередь продолжена.`)
            continue
          }
        } catch (error: any) {
          const updated = stillCurrent(queue, index) || stillCurrent(queue, index, 'cancelling'); if (!updated) return
          const current = updated.items[index]!
          const serviceError = error?.data?.serviceError
          const alreadyPresent = serviceError === 'component_already_installed' || serviceError === 'game_already_exists_no_overwrite'
          const packageRejected = alreadyPresent || serviceError === 'base_game_not_installed'
          if (packageRejected && updated.status === 'running') {
            current.state = 'skipped'
            current.detail = error.message
            updated.message = `${index + 1} из ${updated.items.length}: «${packageInfo.title}». ${current.detail}`
            writeQueue(updated)
            logEvent('warn', `PackageFlowService пропустил «${packageInfo.title}»: ${current.detail}. Очередь продолжена.`)
            continue
          }
          // Other explicit rejections stop the queue. Connection/5xx errors
          // may have occurred after acceptance, so keep observing the same ID.
          const rejected = error?.statusCode >= 400 && error.statusCode < 500
          current.state = rejected ? 'failed' : 'verifying'
          current.detail = error?.statusCode ? error.message : 'Связь с сервисом потеряна; проверяем прежнее задание без повторной отправки'
          updated.message = current.detail
          if (rejected && updated.status !== 'cancelling') updated.status = 'failed'
          writeQueue(updated)
          if (rejected) return
        }
        await pause(); continue
      }

      if (item.state === 'pending' || item.state === 'sending') {
        item.state = 'sending'
        item.detail = 'Передаём задание загрузчику…'
        queue.message = `Передаём ${index + 1} из ${queue.items.length}: «${packageInfo.title}»`
        writeQueue(queue)

        await startInstaller(queue.psIp)
        if (!stillCurrent(queue, index)) return
        resetPackageDelivery(item.packageId)
        const iconData = await readPackageIcon(item.packageId).catch(() => undefined)
        if (!stillCurrent(queue, index)) return
        await sendPackage({ url: item.url, title: packageInfo.title, contentId: packageInfo.contentId, contentType: packageInfo.contentType, size: packageInfo.size, iconData })

        const updated = readQueue()
        const current = updated.items[index]
        // Cancelled while the job was being handed over: the cancel already cut the transfer.
        if (!current || updated.id !== queue.id || updated.status !== 'running' || current.packageId !== item.packageId || !ACTIVE_STATES.includes(current.state)) return
        current.state = 'waiting'
        current.detail = 'Задание получено PS4; ожидаем скачивание'
        current.dispatchedAt = Date.now()
        updated.currentIndex = index
        updated.message = `PS4 загружает ${index + 1} из ${updated.items.length}: «${packageInfo.title}». Следующий пакет ожидает.`
        writeQueue(updated)
        continue
      }

      const delivery = getPackageDelivery(item.packageId)
      item.bytesSent = Math.min(delivery.bytesSent, delivery.size)
      if (delivery.completedAt) {
        item.state = 'delivered'
        item.completedAt = delivery.completedAt
        if (!delivery.partial) item.bytesSent = delivery.size
        item.detail = delivery.partial
          ? `PS4 перестала запрашивать данные (получено ${formatBytes(item.bytesSent)} из ${formatBytes(delivery.requiredSize)}). Проверьте результат на приставке`
          : 'PS4 скачала пакет полностью; установка идёт на приставке'
        logEvent(delivery.partial ? 'warn' : 'info', `«${packageInfo.title}» (${packageInfo.type}): ${item.detail}`)
        writeQueue(queue)
        continue
      }

      if (item.bytesSent > 0) {
        item.state = 'receiving'
        item.detail = `PS4 получила ${formatBytes(Math.min(item.bytesSent, delivery.requiredSize))} из ${formatBytes(delivery.requiredSize)}`
        writeQueue(queue)
      } else if (delivery.requests > 0) {
        // The console fetched the manifest/package but no bytes have streamed yet: keep waiting.
        if (item.detail !== 'PS4 запросила пакет, начинает скачивание…') { item.detail = 'PS4 запросила пакет, начинает скачивание…'; writeQueue(queue) }
      } else if (item.dispatchedAt && Date.now() - item.dispatchedAt >= UNCONFIRMED_AFTER_MS) {
        logEvent('warn', `PS4 не запросила «${packageInfo.title}» за 20 с — результат не подтверждён`)
        item.state = 'unconfirmed'
        item.detail = 'PS4 не запросила файл: проверьте загрузки на консоли; установка не подтверждена'
        writeQueue(queue)
        continue
      }
      await pause()
    }
  } catch (error: any) {
    const queue = readQueue()
    if (queue.status === 'running') {
      const current = queue.currentIndex === undefined ? undefined : queue.items[queue.currentIndex]
      if (current) { current.state = 'failed'; current.detail = (error?.statusCode && error.message) || 'Не удалось передать задание' }
      queue.status = 'failed'
      queue.message = (error?.statusCode && error.message) || 'Не удалось передать очередь установщику'
      logEvent('error', `Очередь установки остановлена: ${queue.message}`, error?.statusCode ? '' : error)
      writeQueue(queue)
    }
  } finally {
    runner = undefined
    const final = readQueue()
    if (final.status === 'cancelling' || (final.status === 'running' && final.items.some(item => ACTIVE_STATES.includes(item.state)))) ensureInstallationQueueRunning()
  }
}

/** Restarts a persisted queue after a browser or server reload without re-sending its current job. */
export function ensureInstallationQueueRunning() {
  const queue = readQueue()
  if ((queue.status === 'running' || queue.status === 'cancelling') && !runner) runner = runQueue()
  return publicQueue(queue)
}

export function getInstallationQueue() {
  if (existsSync(queuePath)) ensureInstallationQueueRunning()
  return publicQueue(readQueue())
}

function createQueueItems(packageIds: string[], packageUrls: Record<string, string>, transport: InstallationTransport): InstallationQueueItem[] {
  return packageIds.map((packageId) => {
    const item = getPackage(packageId)
    if (transport === 'service' && !['PS4GD', 'PS4GP', 'PS4AC', 'PS4AL', 'PS4GDE'].includes(item.contentType)) throw createError({ statusCode: 400, message: 'Этот тип PKG пока не поддерживается сервисом PS4' })
    const url = packageUrls[packageId]
    if (!url || !/^https?:\/\//.test(url)) throw createError({ statusCode: 400, message: `Не найден PS4 URL для «${item.title}»` })
    return { packageId, title: item.title, fileName: item.fileName, size: item.size, type: item.type, titleId: item.titleId, url, state: 'pending', detail: 'Ожидает очереди', bytesSent: 0 }
  })
}

export function startInstallationQueue(input: { psIp: string; packageIds: string[]; packageUrls: Record<string, string>; transport?: unknown; maintenanceId?: string }) {
  assertDesktopWritable()
  assertNoMaintenance(input.psIp, input.maintenanceId)
  assertNoRemoval(input.psIp)
  assertNoFileInstallation(input.psIp)
  const active = readQueue()
  if (active.status === 'running' || active.status === 'cancelling') throw createError({ statusCode: 409, message: 'Очередь уже работает; дождитесь её завершения или отмены' })
  let transport: InstallationTransport
  try { transport = input.transport === undefined ? getInstallationPreference() : installationTransport(input.transport) }
  catch { throw createError({ statusCode: 400, message: 'Неизвестный способ установки' }) }
  if (transport === 'service' && !serviceKeyConfigured(input.psIp)) throw createError({ statusCode: 409, message: 'Сначала введите код сопряжения с экрана PS4' })
  const packageIds = [...new Set(input.packageIds)]
  if (!packageIds.length) throw createError({ statusCode: 400, message: 'Нет пакетов для установки' })
  const items = createQueueItems(packageIds, input.packageUrls, transport)
  archiveQueue(active)
  const queue: InstallationQueue = { version: 1, id: input.maintenanceId || randomUUID(), maintenanceId: input.maintenanceId, transport, status: 'running', psIp: input.psIp, items, createdAt: Date.now(), message: 'Подготавливаем последовательную очередь установки…' }
  writeQueue(queue)
  logEvent('info', `${transport === 'service' ? 'PackageFlowService' : 'PyLoader'}: очередь установки, пакетов ${items.length}`)
  ensureInstallationQueueRunning()
  return publicQueue(queue)
}

/** Appends new packages without touching a job already accepted by PS4. */
export function appendInstallationQueue(input: { psIp: string; queueId: string; packageIds: string[]; packageUrls: Record<string, string> }) {
  const queue = readQueue()
  if (queue.status !== 'running' || !queue.id || queue.id !== input.queueId || queue.psIp !== input.psIp)
    throw createError({ statusCode: 409, message: 'Очередь изменилась. Обновите страницу и повторите добавление.' })
  if (queue.maintenanceId) throw createError({ statusCode: 409, message: 'Идёт обновление сервиса; дождитесь его завершения.' })
  assertNoMaintenance(input.psIp)
  assertNoRemoval(input.psIp)
  const seen = new Set(queue.items.map((item) => item.packageId))
  const packageIds = [...new Set(input.packageIds)].filter((id) => !seen.has(id))
  if (!packageIds.length) throw createError({ statusCode: 409, message: 'Выбранные пакеты уже находятся в очереди.' })
  const additions = createQueueItems(packageIds, input.packageUrls, queue.transport || 'payload')
  queue.items.push(...additions)
  writeQueue(queue)
  logEvent('info', `К текущей очереди добавлено пакетов: ${additions.length}`)
  ensureInstallationQueueRunning()
  return publicQueue(queue)
}

/** Capture the exact current package, so a delayed click cannot cancel its successor. */
export function cancelCurrentInstallation(expectedId: string, packageId: string, ip: string) {
  const queue = readQueue()
  const index = queue.items.findIndex(item => ACTIVE_STATES.includes(item.state))
  if (queue.id !== expectedId || queue.psIp !== ip || queue.transport !== 'service' || queue.status !== 'running' || index < 0 || queue.items[index]!.packageId !== packageId)
    throw createError({ statusCode: 409, message: 'Текущее задание изменилось. Обновите «Задания»' })
  queue.items[index]!.cancelRequested = true
  queue.items[index]!.detail = 'Запрошена отмена текущего пакета'
  writeQueue(queue); ensureInstallationQueueRunning(); return publicQueue(queue)
}

/** Keep indices stable: removing a pending row must never replace a runner's current item. */
export function cancelInstallationItem(expectedId: string, packageId: string, ip: string) {
  assertDesktopWritable()
  const queue = readQueue()
  const item = queue.items.find(item => item.packageId === packageId)
  const removable = queue.status === 'running' || (queue.status === 'failed' && item?.state === 'pending' && !item.serviceDispatchedAt)
  if (!expectedId || queue.id !== expectedId || queue.psIp !== ip || !removable || !item || !ACTIVE_STATES.includes(item.state))
    throw createError({ statusCode: 409, message: 'Задание изменилось. Обновите «Задания»' })
  if (queue.maintenanceId) throw createError({ statusCode: 409, message: 'Идёт обновление сервиса; дождитесь его завершения.' })
  if (item.state === 'pending' && !item.serviceDispatchedAt) {
    item.state = 'cancelled'; item.completedAt = Date.now(); item.detail = 'Убрано из очереди; пакет не отправлен'
  } else if (queue.transport === 'service') {
    item.cancelRequested = true; item.detail = 'Запрошена отмена пакета; ожидаем ответ PS4'
  } else {
    blockPackageDelivery(item.packageId)
    item.state = 'cancelled'; item.completedAt = Date.now()
    item.detail = 'Передача остановлена. Проверьте «Уведомления → Загрузки» на PS4'
  }
  writeQueue(queue); ensureInstallationQueueRunning()
  return publicQueue(queue)
}

/** Cancels only this library group. Accepted PS4 jobs are stopped by the runner;
 * queued packages keep their indices so concurrent snapshots remain valid. */
export function cancelGameInstallation(expectedId: string, ip: string, gameId: string) {
  const queue = readQueue()
  if (queue.id !== expectedId || queue.psIp !== ip || queue.transport !== 'service' || queue.status !== 'running')
    throw createError({ statusCode: 409, message: 'Очередь изменилась. Обновите карточку игры' })
  const targets = queue.items.filter(item => {
    const pkg = getPackage(item.packageId)
    return (pkg.titleId || pkg.id) === gameId && ACTIVE_STATES.includes(item.state)
  })
  if (!targets.length) throw createError({ statusCode: 409, message: 'У этой игры больше нет активных пакетов' })
  for (const item of targets) {
    item.cancelRequested = true
    item.detail = 'Запрошена отмена пакетов этой игры'
  }
  writeQueue(queue); ensureInstallationQueueRunning(); return publicQueue(queue)
}

/**
 * Stops the queue: unfinished packages become "cancelled", the transfer in
 * progress is cut and the console's further requests for them are refused.
 * A BGFT job already accepted by the PS4 then fails on the console side.
 */
export function cancelInstallationQueue() {
  const queue = readQueue()
  if (queue.status === 'cancelling') return publicQueue(queue)
  if (queue.status !== 'running') return publicQueue(queue)
  if (queue.transport === 'service') {
    queue.status = 'cancelling'; queue.message = 'Запрошена отмена; ожидаем подтверждение PS4'
    writeQueue(queue); ensureInstallationQueueRunning(); return publicQueue(queue)
  }
  let cancelled = 0
  for (const item of queue.items) {
    if (!ACTIVE_STATES.includes(item.state)) continue
    if (item.state !== 'pending') blockPackageDelivery(item.packageId)
    item.state = 'cancelled'
    item.detail = 'Установка отменена'
    item.bytesSent = 0
    cancelled += 1
  }
  queue.status = 'cancelled'
  queue.currentIndex = undefined
  queue.message = `Установка отменена${cancelled ? `: остановлено пакетов — ${cancelled}` : ''}. Если загрузка уже появилась на PS4, удалите её в «Уведомления → Загрузки».`
  writeQueue(queue)
  logEvent('info', 'Очередь установки отменена пользователем')
  return publicQueue(queue)
}

/** Releases a stale WEB queue after the user has checked Downloads on PS4.
 * No BGFT or package request is sent, and accepted jobs are never marked installed. */
export function resolveCancelledQueue(expectedId: string) {
  const queue = readQueue()
  if (queue.status !== 'cancelling' || !queue.id || queue.id !== expectedId)
    throw createError({ statusCode: 409, message: 'Очередь уже изменилась. Обновите страницу.' })
  for (const item of queue.items) {
    if (!ACTIVE_STATES.includes(item.state)) continue
    item.state = item.serviceDispatchedAt ? 'unconfirmed' : 'cancelled'
    item.detail = item.serviceDispatchedAt
      ? 'Ожидание снято вручную; результат задания PS4 не подтверждён'
      : 'Не отправлен: очередь отменена'
  }
  queue.status = 'cancelled'
  queue.currentIndex = undefined
  queue.message = 'Ожидание снято. Проверьте «Загрузки» на PS4 перед повторной установкой.'
  writeQueue(queue)
  logEvent('warn', `Ожидание отмены очереди ${queue.id} снято вручную; результат установки не подтверждён`)
  return publicQueue(queue)
}

/** Release only a failed or already cancelling WEB queue after PS4 has no live job. */
export function clearStaleInstallationQueue(ip: string, expectedId: string) {
  const queue = readQueue()
  if (queue.psIp !== ip || queue.id !== expectedId || !['failed', 'cancelling', 'cancelled'].includes(queue.status))
    throw createError({ statusCode: 409, message: 'Очередь изменилась. Обновите состояние и повторите проверку.' })
  for (const item of queue.items) {
    if (!ACTIVE_STATES.includes(item.state)) continue
    item.state = item.serviceDispatchedAt ? 'unconfirmed' : 'cancelled'
    item.detail = item.serviceDispatchedAt ? 'Задание PS4 не подтверждено; повтор не отправлен' : 'Не отправлен: очередь очищена'
  }
  queue.status = 'cancelled'; queue.currentIndex = undefined
  queue.message = 'Зависшее ожидание снято. Перед повторной установкой проверьте «Загрузки» PS4.'
  writeQueue(queue)
  logEvent('warn', `Зависшее ожидание очереди ${expectedId} снято после проверки PS4`)
  return publicQueue(queue)
}

/** Forgets a package's queue history so it can be installed again from scratch. */
export function forgetQueuedPackage(packageId: string) {
  const queue = readQueue()
  const item = queue.items.find((entry) => entry.packageId === packageId)
  if (!item) return
  if ((queue.status === 'running' || queue.status === 'cancelling') && item.state !== 'pending' && ACTIVE_STATES.includes(item.state)) {
    throw createError({ statusCode: 409, message: 'Пакет сейчас передаётся. Сначала отмените установку.' })
  }
  queue.items = queue.items.filter((entry) => entry.packageId !== packageId)
  queue.currentIndex = undefined
  if (queue.status !== 'running' && !queue.items.length) { queue.status = 'idle'; queue.message = undefined }
  writeQueue(queue)
}

function formatBytes(value: number) {
  if (!value) return '0 Б'
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / 1024 ** index).toFixed(index >= 3 ? 1 : 0)} ${units[index]}`
}
