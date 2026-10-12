import { randomBytes, randomUUID } from 'node:crypto'
import { TransferSpeed } from './transfer-speed'
import type { ContentPlatform, ContentFormat } from '../../shared/types/consoles'
import { installationTaskCategory } from '../../shared/types/tasks'

export type Ps5State = 'pending' | 'sending' | 'verifying' | 'installing' | 'waiting' | 'installed' | 'failed' | 'skipped' | 'cancelled' | 'unconfirmed'
export interface Ps5Item {
  packageId: string; title: string; fileName: string; size: number; type: string; titleId: string
  platform: ContentPlatform; format: ContentFormat; branch: string; order: number; appVersion?: string; contentId?: string
  alreadyPresent?: boolean; overwriteApproved?: boolean
  transferId: string; state: Ps5State; detail: string; bytesSent: number; completedAt?: number; installedAt?: number
  hash?: string; sourceStamp?: string; installDispatched?: boolean; serviceJobId?: string; cancelRequested?: boolean; hidden?: boolean
  queueId?: string; createdAt?: number; confirmation?: 'user' | 'service-registration' | 'service-existing' | 'recorded-existing'; confirmedAt?: number
  imagePublishedAt?: number
  progressPhase?: 'source-check' | 'transfer' | 'device-check'; bytesChecked?: number
}
export interface Ps5Queue {
  version: 1; id?: string; consoleId: string; psIp: string; transport: 'service'
  status: 'idle' | 'paused' | 'running' | 'completed' | 'failed' | 'cancelled'; items: Ps5Item[]; history: Ps5Item[][]
  createdAt: number; updatedAt: number; message: string
}
export class Ps5QueueFailure extends Error {}
export class Ps5QueueUncertain extends Error {}
export interface Ps5Driver {
  run(item: Ps5Item, signal: AbortSignal, checkpoint: (patch: Partial<Ps5Item>) => void): Promise<Partial<Ps5Item>>
  cancel(item: Ps5Item): Promise<void>
}
const terminal = (item: Ps5Item) => ['installed', 'failed', 'skipped', 'cancelled'].includes(item.state)
export const ps5CanCancel = (item: Ps5Item) => !terminal(item) && !item.installDispatched
export const ps5BlankQueue = (consoleId: string, psIp: string): Ps5Queue => ({ version: 1, consoleId, psIp, transport: 'service', status: 'idle', items: [], history: [], createdAt: 0, updatedAt: 0, message: '' })

/** No console-global state: a runner owns a captured destination and a durable store.
 * An uncertain system dispatch stops advancement until the backend reconciles it. */
export class Ps5QueueRunner {
  private active?: Promise<void>
  private controller?: AbortController
  private activeItem?: Ps5Item
  private progressSavedAt = 0
  private speed: TransferSpeed
  private speedUpdatedAt = 0
  constructor(readonly queue: Ps5Queue, private persist: (queue: Ps5Queue) => void,
    private driver: Ps5Driver, private interval = 2000, private installed: (item: Ps5Item) => void = () => {}, clock?: () => number) { this.speed = new TransferSpeed(clock) }
  private save() { this.queue.updatedAt = Date.now(); this.persist(this.queue) }
  private transmissionActive(item: Ps5Item) {
    return item.state === 'sending' && item.progressPhase === 'transfer' || item.format === 'folder' && item.state === 'verifying' && item.progressPhase === 'device-check' && item.bytesSent < item.size
  }
  transferTelemetry(item: Ps5Item) {
    if (item !== this.activeItem || !this.transmissionActive(item)) return {}
    return { transferBytesPerSecond: this.speed.read() ?? 0, transferMeasuredAt: this.speedUpdatedAt || Date.now() }
  }
  snapshot() { return structuredClone(this.queue) }
  enqueue(items: Omit<Ps5Item, 'transferId' | 'state' | 'detail' | 'bytesSent'>[], queueId?: string, initialQueueId?: string) {
    if (!items.length || items.length > 10000) throw new Ps5QueueFailure('Выберите пакеты для установки')
    if (initialQueueId && (queueId || !/^[a-f0-9]{32}$/.test(initialQueueId) || initialQueueId === this.queue.id)) throw new Ps5QueueFailure('Неверный номер новой очереди')
    if (queueId && (queueId !== this.queue.id || this.queue.status !== 'running')) throw new Ps5QueueFailure('Очередь изменилась. Обновите задания')
    if (this.queue.status === 'paused') throw new Ps5QueueFailure('Очередь приостановлена. Сначала продолжите её')
    if (!queueId && this.queue.status === 'running') throw new Ps5QueueFailure('Уже работает очередь этой PS5')
    if (!queueId) {
      if (this.queue.items.length) this.queue.history = [this.queue.items, ...this.queue.history].slice(0, 10)
      this.queue.items = []; this.queue.id = initialQueueId || randomUUID(); this.queue.createdAt = Date.now()
    }
    const known = new Set(this.queue.items.filter(item => item.state !== 'cancelled').map(item => item.packageId))
    const additions = items.filter(item => !known.has(item.packageId) && (known.add(item.packageId), true))
      .sort((a, b) => a.branch.localeCompare(b.branch) || a.order - b.order || (a.appVersion || '').localeCompare(b.appVersion || '', undefined, { numeric: true }) || a.fileName.localeCompare(b.fileName))
      .map(item => ({ ...item, queueId: this.queue.id, createdAt: this.queue.createdAt, transferId: randomBytes(16).toString('hex'), state: 'pending' as const, detail: 'В очереди', bytesSent: 0 }))
    if (this.queue.items.length + additions.length > 10000) throw new Ps5QueueFailure('В очереди может быть не больше 10000 пакетов')
    this.queue.items.push(...additions)
    const waiting = this.queue.items.filter(item => item.state === 'pending' && item !== this.activeItem)
      .sort((a,b)=>a.branch.localeCompare(b.branch) || a.order-b.order || (a.appVersion || '').localeCompare(b.appVersion || '',undefined,{numeric:true}))
    this.queue.items = [...this.queue.items.filter(item=>!waiting.includes(item)), ...waiting]
    this.queue.status = 'running'; this.queue.message = 'Очередь PS5'; this.save(); this.wake()
    return this.snapshot()
  }
  cancel(queueId: string, packageIds?: string[], branches?: string[]) {
    if (!queueId || queueId !== this.queue.id) throw new Ps5QueueFailure('Очередь изменилась. Обновите задания')
    const selected = this.queue.items.filter(item => !packageIds && !branches || packageIds?.includes(item.packageId) || branches?.includes(item.branch))
    if (packageIds?.some(id => !this.queue.items.some(item => item.packageId === id)) || branches?.some(id => !this.queue.items.some(item => item.branch === id))) throw new Ps5QueueFailure('Задание больше не существует')
    for (const item of selected) {
      if (!ps5CanCancel(item)) continue
      if (item === this.activeItem) { item.cancelRequested = true; this.controller?.abort() }
      else { item.state = 'cancelled'; item.detail = 'Убрано из очереди'; item.completedAt = Date.now() }
    }
    this.queue.message = selected.some(item => item.installDispatched && !terminal(item)) ? 'Ожидающие пакеты убраны. Отмена принятой системой установки пока не поддерживается' : 'Отмена выбранных пакетов запрошена'
    if (this.queue.status === 'paused' && this.queue.items.every(terminal)) this.queue.status = 'cancelled'
    this.save(); this.wake(); return this.snapshot()
  }
  confirmInstalled(queueId: string, packageId: string) {
    const item = (queueId === this.queue.id ? this.queue.items : this.queue.history.flat().filter(entry => entry.queueId === queueId)).find(entry => entry.packageId === packageId)
    if (!queueId || !item) throw new Ps5QueueFailure('Задание больше не существует в этой очереди')
    if (item.state === 'installed' && item.confirmation === 'user') return this.snapshot()
    if (!item.installDispatched || !item.serviceJobId || item.bytesSent !== item.size || !['installing','unconfirmed','failed'].includes(item.state)) throw new Ps5QueueFailure('Подтверждение доступно после передачи пакета установщику')
    const previous = structuredClone(item)
    Object.assign(item, { state: 'installed', confirmation: 'user', confirmedAt: Date.now(), installedAt: Date.now(), completedAt: Date.now(), detail: 'Установку подтвердил пользователь' })
    try { this.save() } catch(error) { for (const key of Object.keys(item)) delete (item as unknown as Record<string, unknown>)[key]; Object.assign(item,previous); throw error }
    this.installed(item); this.wake()
    return this.snapshot()
  }
  clear(selected: (item:Ps5Item)=>boolean = ()=>true) {
    for (const item of [...this.queue.items, ...this.queue.history.flat()]) if (terminal(item)&&selected(item)) item.hidden = true
    this.save(); return this.snapshot()
  }
  async pause(queueId: string) {
    if (queueId !== this.queue.id || this.queue.status !== 'running' || this.queue.items.some(item => item.installDispatched && !terminal(item))) throw new Ps5QueueFailure('Приостановка доступна до системной установки')
    this.queue.status = 'paused'; this.queue.message = 'Передача приостановлена; данные докачки сохранены'; this.save()
    this.controller?.abort(new Error('Queue paused')); await this.settled()
    return this.snapshot()
  }
  resume(queueId: string) {
    if (queueId !== this.queue.id || this.queue.status !== 'paused') throw new Ps5QueueFailure('Приостановленная очередь изменилась')
    this.queue.status = 'running'; this.queue.message = 'Продолжаем передачу с подтверждённой позиции'; this.save(); this.wake(); return this.snapshot()
  }
  wake() {
    if (this.active || this.queue.status !== 'running') return
    this.active = this.run().catch(() => {
      // Never continue dispatching after a durable write failed. The last
      // persisted intent still controls restart recovery.
      this.queue.message = 'Не удалось сохранить состояние очереди. Отправка приостановлена'
    }).finally(() => { this.active = undefined })
  }
  async settled() { await this.active }
  private async run() {
    while (this.queue.status === 'running') {
      const item = this.queue.items.find(entry => !terminal(entry))
      if (!item) {
        this.queue.status = this.queue.items.every(entry => entry.state === 'cancelled') ? 'cancelled' : this.queue.items.some(entry => entry.state === 'failed' || entry.state === 'skipped' && !entry.alreadyPresent) ? 'failed' : 'completed'
        this.queue.message = 'Очередь PS5 завершена'; this.save(); return
      }
      const failedBase = this.queue.items.some(entry => entry.branch === item.branch && entry.order === 0 && ['failed','cancelled','skipped'].includes(entry.state) && !entry.alreadyPresent)
      if (item.order > 0 && failedBase) { Object.assign(item, { state: 'skipped', detail: 'Базовая игра в этой очереди не установлена', completedAt: Date.now() }); this.save(); continue }
      this.activeItem = item; this.controller = new AbortController(); this.speed.reset(); this.speedUpdatedAt = 0
      const checkpoint = (patch: Partial<Ps5Item>) => {
        // A read-only poll that began before the human receipt cannot undo it.
        if (item.confirmation === 'user') return
        Object.assign(item, patch)
        if (!this.transmissionActive(item)) this.speed.reset()
        else if (patch.bytesSent !== undefined) { this.speed.observe(item.bytesSent); this.speedUpdatedAt = Date.now() }
        // Byte offsets are already durable on PS5. Coalesce only WEB progress;
        // dispatch intents, hashes and state transitions always fsync immediately.
        if (Object.keys(patch).length === 1 && (patch.bytesSent !== undefined || patch.bytesChecked !== undefined) && Date.now()-this.progressSavedAt < 1000) return
        this.save(); this.progressSavedAt = Date.now()
      }
      try {
        if (item.cancelRequested) this.controller.abort()
        if (this.controller.signal.aborted) throw new Error('cancelled')
        const result = await this.driver.run(item, this.controller.signal, checkpoint)
        if (item.cancelRequested && !item.installDispatched) throw new Error('cancelled')
        checkpoint(result)
        if (item.state === 'installed' && item.confirmation !== 'user') { this.installed(item); checkpoint({ installedAt: Date.now(), completedAt: Date.now() }) }
        else if (terminal(item)) checkpoint({ completedAt: Date.now() })
      } catch (error) {
        if (this.queue.status === 'paused') { /* Retain durable offsets; never cancel receiver data. */ }
        else if (item.cancelRequested && !item.installDispatched) {
          try { await this.driver.cancel(item); checkpoint({ state: 'cancelled', detail: 'Передача отменена', completedAt: Date.now() }) }
          catch { checkpoint({ detail: 'Ожидаем подтверждение отмены передачи от PS5' }) }
        } else if (error instanceof Ps5QueueFailure) checkpoint({ state: 'failed', detail: error.message, completedAt: Date.now() })
        else if (error instanceof Ps5QueueUncertain) checkpoint({ state: 'unconfirmed', detail: error.message })
        else checkpoint({ detail: 'PS5 недоступна. Ожидаем связь; повторная установка не отправлялась' })
      }
      this.activeItem = undefined; this.controller = undefined
      if (this.queue.status !== 'running') return
      if (!terminal(item)) await new Promise<void>(resolve => { const timer = setTimeout(resolve, this.interval); timer.unref?.() })
    }
  }
}
export function ps5VisibleItems(queue: Ps5Queue) { return [...queue.items, ...queue.history.flat()].filter(item => !item.hidden).sort((a,b) => Number(installationTaskCategory(b.state) === 'active') - Number(installationTaskCategory(a.state) === 'active')) }
