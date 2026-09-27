import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { writeJsonFile } from './json-store'
import { blockPackageDelivery, getPackage, getPackageDelivery, markPackageInstalled, readPackageIcon, resetPackageDelivery } from './package-library'
import { sendPackage, startInstaller } from './ps4-installer'

export type InstallationItemState = 'pending' | 'sending' | 'waiting' | 'receiving' | 'delivered' | 'installed' | 'failed' | 'cancelled'

interface InstallationQueueItem {
  packageId: string
  url: string
  state: InstallationItemState
  detail: string
  bytesSent: number
  dispatchedAt?: number
  completedAt?: number
  installedAt?: number
}

interface InstallationQueue {
  version: 1
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'
  psIp?: string
  items: InstallationQueueItem[]
  currentIndex?: number
  createdAt?: number
  updatedAt?: number
  message?: string
}

const queuePath = resolve(process.cwd(), '.data/installation-queue.json')
const WAIT_INTERVAL_MS = 1500
const ALREADY_INSTALLED_AFTER_MS = 20_000
let runner: Promise<void> | undefined

const blankQueue = (): InstallationQueue => ({ version: 1, status: 'idle', items: [] })

function readQueue(): InstallationQueue {
  try {
    const queue = JSON.parse(readFileSync(queuePath, 'utf8')) as InstallationQueue
    return queue.version === 1 && Array.isArray(queue.items) ? queue : blankQueue()
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

async function runQueue() {
  try {
    while (true) {
      const queue = readQueue()
      if (queue.status !== 'running' || !queue.psIp) return
      const index = queue.items.findIndex((item) => item.state === 'pending' || item.state === 'sending' || item.state === 'waiting' || item.state === 'receiving')
      if (index < 0) {
        queue.status = 'completed'
        queue.currentIndex = undefined
        queue.message = 'Все пакеты переданы PlayStation по очереди: игра → патчи/бэкпорты → DLC.'
        writeQueue(queue)
        return
      }

      queue.currentIndex = index
      const item = queue.items[index]!
      const packageInfo = getPackage(item.packageId)

      if (item.state === 'pending' || item.state === 'sending') {
        item.state = 'sending'
        item.detail = 'Передаём задание загрузчику…'
        queue.message = `Передаём ${index + 1} из ${queue.items.length}: «${packageInfo.title}»`
        writeQueue(queue)

        await startInstaller(queue.psIp)
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
        item.detail = 'Файл полностью передан PlayStation; можно передавать следующий пакет'
        writeQueue(queue)
        continue
      }

      if (item.bytesSent > 0) {
        item.state = 'receiving'
        item.detail = `PS4 получила ${formatBytes(item.bytesSent)} из ${formatBytes(delivery.size)}`
        writeQueue(queue)
      } else if (delivery.requests > 0) {
        // The console fetched the manifest/package but no bytes have streamed yet: keep waiting.
        if (item.detail !== 'PS4 запросила пакет, начинает скачивание…') { item.detail = 'PS4 запросила пакет, начинает скачивание…'; writeQueue(queue) }
      } else if (item.dispatchedAt && Date.now() - item.dispatchedAt >= ALREADY_INSTALLED_AFTER_MS) {
        console.log(`[PackageFlow] PS4 не обратилась за «${packageInfo.title}» за 20 с — считаем пакет уже установленным`)
        markPackageInstalled(item.packageId, true)
        item.state = 'installed'
        item.installedAt = Date.now()
        item.detail = 'PS4 не запросила файл за 20 с: отмечен как уже установленный'
        writeQueue(queue)
        continue
      }
      await pause()
    }
  } catch (error: any) {
    const queue = readQueue()
    if (queue.status === 'running') {
      const current = queue.currentIndex === undefined ? undefined : queue.items[queue.currentIndex]
      if (current) { current.state = 'failed'; current.detail = error?.statusMessage || 'Не удалось передать задание' }
      queue.status = 'failed'
      queue.message = error?.statusMessage || 'Не удалось передать очередь установщику'
      writeQueue(queue)
    }
  } finally { runner = undefined }
}

/** Restarts a persisted queue after a browser or server reload without re-sending its current job. */
export function ensureInstallationQueueRunning() {
  const queue = readQueue()
  if (queue.status === 'running' && !runner) runner = runQueue()
  return publicQueue(queue)
}

export function getInstallationQueue() {
  if (existsSync(queuePath)) ensureInstallationQueueRunning()
  return publicQueue(readQueue())
}

export function startInstallationQueue(input: { psIp: string; packageIds: string[]; packageUrls: Record<string, string> }) {
  const active = readQueue()
  if (active.status === 'running') throw createError({ statusCode: 409, statusMessage: 'Очередь уже передаётся на PlayStation' })
  const packageIds = [...new Set(input.packageIds)]
  if (!packageIds.length) throw createError({ statusCode: 400, statusMessage: 'Нет пакетов для установки' })
  const items: InstallationQueueItem[] = packageIds.map((packageId) => {
    const item = getPackage(packageId)
    const url = input.packageUrls[packageId]
    if (!url || !/^https?:\/\//.test(url)) throw createError({ statusCode: 400, statusMessage: `Не найден PS4 URL для «${item.title}»` })
    return { packageId, url, state: 'pending', detail: 'Ожидает очереди', bytesSent: 0 }
  })
  const queue: InstallationQueue = { version: 1, status: 'running', psIp: input.psIp, items, createdAt: Date.now(), message: 'Подготавливаем последовательную очередь установки…' }
  writeQueue(queue)
  ensureInstallationQueueRunning()
  return publicQueue(queue)
}

const ACTIVE_STATES: InstallationItemState[] = ['pending', 'sending', 'waiting', 'receiving']

/**
 * Stops the queue: unfinished packages become "cancelled", the transfer in
 * progress is cut and the console's further requests for them are refused.
 * A BGFT job already accepted by the PS4 then fails on the console side.
 */
export function cancelInstallationQueue() {
  const queue = readQueue()
  if (queue.status !== 'running') return publicQueue(queue)
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
  console.log('[PackageFlow] Очередь установки отменена пользователем')
  return publicQueue(queue)
}

/** Forgets a package's queue history so it can be installed again from scratch. */
export function forgetQueuedPackage(packageId: string) {
  const queue = readQueue()
  const item = queue.items.find((entry) => entry.packageId === packageId)
  if (!item) return
  if (queue.status === 'running' && item.state !== 'pending' && ACTIVE_STATES.includes(item.state)) {
    throw createError({ statusCode: 409, statusMessage: 'Пакет сейчас передаётся. Сначала отмените установку.' })
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
