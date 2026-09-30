import { logEvent } from './event-log'
import { assertNoRemoval } from './console-operation-store'
import { assertNoMaintenance } from './maintenance-store'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { writeJsonFile } from './json-store'
import { blockPackageDelivery, getPackage, getPackageDelivery, markPackageInstalled, readPackageIcon, resetPackageDelivery } from './package-library'
import { sendPackage, startInstaller } from './ps4-installer'
import { randomUUID } from 'node:crypto'
import { installationTransport, serviceJobDetail } from './installation-transport'
import { cancelServiceInstallJob, getServiceInstallJob, serviceKeyConfigured, submitServicePackage } from './ps4-service-installer'
import type { InstallationTransport, ServiceInstallJob } from '../../shared/types/installation'

export type InstallationItemState = 'pending' | 'sending' | 'waiting' | 'receiving' | 'installing' | 'verifying' | 'delivered' | 'installed' | 'unconfirmed' | 'failed' | 'cancelled'

interface InstallationQueueItem {
  packageId: string
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

const queuePath = resolve(process.cwd(), '.data/installation-queue.json')
const WAIT_INTERVAL_MS = 1500
const UNCONFIRMED_AFTER_MS = 20_000
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
  return { ...queue, items: queue.items.map((item) => ({ ...item })) }
}

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS))
const ACTIVE_STATES: InstallationItemState[] = ['pending', 'sending', 'waiting', 'receiving', 'installing', 'verifying']

function stillCurrent(queue: InstallationQueue, index: number, status: InstallationQueue['status'] = 'running') {
  const updated = readQueue()
  return updated.status === status && updated.id === queue.id && updated.createdAt === queue.createdAt &&
    updated.items[index]?.packageId === queue.items[index]?.packageId ? updated : null
}
function applyServiceJob(item: InstallationQueueItem, job: ServiceInstallJob) {
  item.serviceJobId = job.jobId; item.serviceTaskId = job.taskId
  item.bytesSent = job.downloadedBytes; item.detail = serviceJobDetail(job)
  item.state = job.state === 'installed' ? 'installed' : job.state === 'failed' ? 'failed' : job.state === 'cancelled' ? 'cancelled' :
    job.state === 'installing' ? 'installing' : job.state === 'uncertain' || job.state === 'cancelling' || job.pollError ? 'verifying' : job.downloadedBytes ? 'receiving' : 'waiting'
  if (item.state === 'installed') {
    item.completedAt ??= Date.now(); item.installedAt ??= Date.now(); markPackageInstalled(item.packageId, true)
  }
}
async function cancelServicePass(queue: InstallationQueue) {
  for (let index = 0; index < queue.items.length; index++) {
    const item = queue.items[index]!
    if (!ACTIVE_STATES.includes(item.state)) continue
    if (!item.serviceDispatchedAt || !item.requestId) { item.state = 'cancelled'; item.detail = 'Не отправлен: очередь отменена'; continue }
    try {
      const previous = await getServiceInstallJob(queue.psIp!, item.requestId)
      const job = ['installed', 'failed', 'cancelled'].includes(previous.state) ? previous : await cancelServiceInstallJob(queue.psIp!, item.requestId)
      if (!stillCurrent(queue, index, 'cancelling')) return
      applyServiceJob(item, job)
    } catch (error: any) {
      if (!stillCurrent(queue, index, 'cancelling')) return
      item.state = 'verifying'; item.detail = error?.statusCode ? error.message : 'Связь потеряна; отмена принятого задания ещё не подтверждена'
    }
  }
  if (!queue.items.some(item => ACTIVE_STATES.includes(item.state))) {
    queue.status = 'cancelled'; queue.currentIndex = undefined; queue.message = 'Очередь остановлена; результаты принятых заданий получены с PS4'
  } else queue.message = 'Ожидаем подтверждение отмены с PS4; новые задания не отправляются'
  writeQueue(queue)
}

async function runQueue() {
  try {
    while (true) {
      const queue = readQueue()
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
        queue.message = queue.transport === 'service' ? 'PS4 подтвердила установку всех пакетов очереди.' : unconfirmed
          ? `Очередь отправлена; для ${unconfirmed} пак. скачивание не подтверждено. Проверьте загрузки PS4.`
          : 'Все пакеты переданы PlayStation по очереди: игра → патчи/бэкпорты → DLC. Финальный результат проверьте на PS4.'
        logEvent(unconfirmed ? 'warn' : 'info', queue.message)
        writeQueue(queue)
        return
      }

      queue.currentIndex = index
      const item = queue.items[index]!
      const packageInfo = getPackage(item.packageId)

      if (queue.transport === 'service') {
        try {
          let job: ServiceInstallJob
          if (!item.serviceDispatchedAt) {
            item.requestId ??= randomUUID(); item.serviceDispatchedAt = Date.now(); item.dispatchedAt = Date.now()
            item.state = 'sending'; item.detail = 'Отправляем задание сервису PS4…'; resetPackageDelivery(item.packageId); writeQueue(queue)
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
          updated.message = `${index + 1} из ${updated.items.length}: «${packageInfo.title}». ${current.detail}`
          if (updated.status !== 'cancelling' && (current.state === 'failed' || current.state === 'cancelled')) updated.status = 'failed'
          writeQueue(updated)
          if (updated.status !== 'running') return
          if (current.state === 'installed') { logEvent('info', `PackegeFlowService подтвердил установку «${packageInfo.title}» (задание PS4 ${job.taskId})`); continue }
        } catch (error: any) {
          const updated = stillCurrent(queue, index) || stillCurrent(queue, index, 'cancelling'); if (!updated) return
          const current = updated.items[index]!
          // Explicit rejection is terminal. Connection/5xx errors may have
          // occurred after acceptance, so keep observing the original ID.
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
        await sendPackage({ url: item.url, title: packageInfo.title, contentId: packageInfo.contentId, contentType: packageInfo.contentType, size: packageInfo.size, iconData: await readPackageIcon(item.packageId).catch(() => undefined) })

        const updated = readQueue()
        const current = updated.items[index]
        // Cancelled while the job was being handed over: the cancel already cut the transfer.
        if (!current || updated.status !== 'running' || current.packageId !== item.packageId) return
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
    if (readQueue().status === 'cancelling') ensureInstallationQueueRunning()
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

export function startInstallationQueue(input: { psIp: string; packageIds: string[]; packageUrls: Record<string, string>; transport?: unknown; maintenanceId?: string }) {
  assertNoMaintenance(input.psIp, input.maintenanceId)
  assertNoRemoval(input.psIp)
  const active = readQueue()
  if (active.status === 'running' || active.status === 'cancelling') throw createError({ statusCode: 409, message: 'Очередь уже работает; дождитесь её завершения или отмены' })
  let transport: InstallationTransport
  try { transport = installationTransport(input.transport) } catch { throw createError({ statusCode: 400, message: 'Неизвестный способ установки' }) }
  if (transport === 'service' && !serviceKeyConfigured(input.psIp)) throw createError({ statusCode: 409, message: 'Сначала введите код сопряжения с экрана PS4' })
  const packageIds = [...new Set(input.packageIds)]
  if (!packageIds.length) throw createError({ statusCode: 400, message: 'Нет пакетов для установки' })
  const items: InstallationQueueItem[] = packageIds.map((packageId) => {
    const item = getPackage(packageId)
    if (transport === 'service' && !['PS4GD', 'PS4GP', 'PS4AC'].includes(item.contentType)) throw createError({ statusCode: 400, message: 'Этот тип PKG пока не поддерживается сервисом PS4' })
    const url = input.packageUrls[packageId]
    if (!url || !/^https?:\/\//.test(url)) throw createError({ statusCode: 400, message: `Не найден PS4 URL для «${item.title}»` })
    return { packageId, url, state: 'pending', detail: 'Ожидает очереди', bytesSent: 0 }
  })
  const queue: InstallationQueue = { version: 1, id: input.maintenanceId || randomUUID(), maintenanceId: input.maintenanceId, transport, status: 'running', psIp: input.psIp, items, createdAt: Date.now(), message: 'Подготавливаем последовательную очередь установки…' }
  writeQueue(queue)
  logEvent('info', `${transport === 'service' ? 'PackegeFlowService' : 'PyLoader'}: очередь установки, пакетов ${items.length}`)
  ensureInstallationQueueRunning()
  return publicQueue(queue)
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
