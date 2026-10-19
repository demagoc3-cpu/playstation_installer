import type { Ps5TransferProfile } from '../../shared/types/console-speed';
import { randomBytes, randomUUID } from 'node:crypto';
import { logEvent } from './event-log';
import { ps5QueueContext } from './ps5-transfer-context';
import { TransferSpeed } from './transfer-speed';
import type { ContentPlatform, ContentFormat } from '../../shared/types/consoles';
import { installationTaskCategory } from '../../shared/types/tasks';

export type Ps5State =
  | 'pending'
  | 'sending'
  | 'verifying'
  | 'installing'
  | 'waiting'
  | 'installed'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'unconfirmed';
export interface Ps5Item {
  packageId: string;
  title: string;
  fileName: string;
  size: number;
  type: string;
  titleId: string;
  platform: ContentPlatform;
  format: ContentFormat;
  branch: string;
  order: number;
  appVersion?: string;
  contentId?: string;
  alreadyPresent?: boolean;
  overwriteApproved?: boolean;
  transferId: string;
  state: Ps5State;
  detail: string;
  bytesSent: number;
  /** Request id of the approved deletion of an own Folder/image source. */
  sourceDeleteId?: string;
  /** Request id of the approved uninstall of an own orphaned registration. */
  orphanClearId?: string;
  /** Display only: bytes of the current batch already handed to the network. */
  bytesInFlight?: number;
  completedAt?: number;
  installedAt?: number;
  hash?: string;
  sourceStamp?: string;
  installDispatched?: boolean;
  serviceJobId?: string;
  cancelRequested?: boolean;
  /** 'done': the PS5 confirmed the cancel of this transfer and dropped its partial file. */
  partCleanup?: 'done';
  hidden?: boolean;
  queueId?: string;
  createdAt?: number;
  confirmation?:
    | 'user'
    | 'service-registration'
    | 'service-existing'
    | 'recorded-existing'
    // A patch: PS5 reports the game at this version or newer.
    | 'service-version'
    // A DLC: the system installer finished the job without an error code.
    | 'installer-result';
  confirmedAt?: number;
  imagePublishedAt?: number;
  observationStoppedAt?: number;
  registrationIdleSince?: number;
  registrationBlockedByApp?: boolean;
  folderPublishedAt?: number;
  transferProfile?: Ps5TransferProfile;
  progressPhase?: 'source-check' | 'transfer' | 'device-check';
  bytesChecked?: number;
}
export interface Ps5Queue {
  version: 1;
  id?: string;
  consoleId: string;
  psIp: string;
  transport: 'service';
  status: 'idle' | 'paused' | 'running' | 'completed' | 'failed' | 'cancelled';
  items: Ps5Item[];
  history: Ps5Item[][];
  createdAt: number;
  updatedAt: number;
  message: string;
}
export class Ps5QueueFailure extends Error {}
export class Ps5QueueUncertain extends Error {}
export interface Ps5Driver {
  run(
    item: Ps5Item,
    signal: AbortSignal,
    checkpoint: (patch: Partial<Ps5Item>) => void,
  ): Promise<Partial<Ps5Item>>;
  cancel(item: Ps5Item): Promise<void>;
}
/** A cancelled transfer that may still have a partial file on the PS5 and
 * never reached the installer: cancel it on the PS5 to free the space. */
export const ps5PartLeft = (item: Ps5Item) =>
  item.state === 'cancelled' &&
  !item.installDispatched &&
  item.partCleanup !== 'done' &&
  (item.bytesSent > 0 || !!item.hash);
const terminal = (item: Ps5Item) =>
  ['installed', 'failed', 'skipped', 'cancelled'].includes(item.state);
export const ps5CanCancel = (item: Ps5Item) => !terminal(item) && !item.installDispatched;
export const ps5BlankQueue = (consoleId: string, psIp: string): Ps5Queue => ({
  version: 1,
  consoleId,
  psIp,
  transport: 'service',
  status: 'idle',
  items: [],
  history: [],
  createdAt: 0,
  updatedAt: 0,
  message: '',
});

/** No console-global state: a runner owns a captured destination and a durable store.
 * An uncertain system dispatch stops advancement until the backend reconciles it. */
export class Ps5QueueRunner {
  private active?: Promise<void>;
  private controller?: AbortController;
  private activeItem?: Ps5Item;
  private progressSavedAt = 0;
  private speed: TransferSpeed;
  constructor(
    readonly queue: Ps5Queue,
    private persist: (queue: Ps5Queue) => void,
    private driver: Ps5Driver,
    private interval = 2000,
    private installed: (item: Ps5Item) => void = () => {},
    clock?: () => number,
  ) {
    // A 128 MiB durable ACK or an intermediate Folder check can exceed five
    // seconds. Include that time in the rate; a longer silence is still a stall.
    this.speed = new TransferSpeed(clock, 15000);
  }
  private save() {
    this.queue.updatedAt = Date.now();
    this.persist(this.queue);
  }
  private transmissionActive(item: Ps5Item) {
    return (
      (item.state === 'sending' && item.progressPhase === 'transfer') ||
      (item.format === 'folder' &&
        item.state === 'verifying' &&
        item.progressPhase === 'device-check' &&
        item.bytesSent < item.size)
    );
  }
  transferTelemetry(item: Ps5Item) {
    if (
      this.queue.status !== 'running' ||
      item.cancelRequested ||
      item !== this.activeItem ||
      !this.transmissionActive(item)
    )
      return {};
    // This is the time the live rate was sampled, not the last durable ACK.
    // The browser's freshness limit detects lost WEB polls independently.
    return { transferBytesPerSecond: this.speed.read() ?? 0, transferMeasuredAt: Date.now() };
  }
  snapshot() {
    return structuredClone(this.queue);
  }
  enqueue(
    items: Omit<Ps5Item, 'transferId' | 'state' | 'detail' | 'bytesSent'>[],
    queueId?: string,
    initialQueueId?: string,
  ) {
    if (!items.length || items.length > 10000)
      throw new Ps5QueueFailure('Выберите пакеты для установки');
    if (
      initialQueueId &&
      (queueId || !/^[a-f0-9]{32}$/.test(initialQueueId) || initialQueueId === this.queue.id)
    )
      throw new Ps5QueueFailure('Неверный номер новой очереди');
    if (queueId && (queueId !== this.queue.id || this.queue.status !== 'running'))
      throw new Ps5QueueFailure('Очередь изменилась. Обновите задания');
    if (this.queue.status === 'paused')
      throw new Ps5QueueFailure('Очередь приостановлена. Сначала продолжите её');
    if (!queueId && this.queue.status === 'running')
      throw new Ps5QueueFailure('Уже работает очередь этой PS5');
    if (!queueId) {
      if (this.queue.items.length)
        this.queue.history = [this.queue.items, ...this.queue.history].slice(0, 10);
      this.queue.items = [];
      this.queue.id = initialQueueId || randomUUID();
      this.queue.createdAt = Date.now();
    }
    const known = new Set(
      this.queue.items.filter((item) => item.state !== 'cancelled').map((item) => item.packageId),
    );
    // Games keep the order they were added in; inside one game the base comes
    // first, then patches and DLC.
    const rank = new Map<string, number>();
    for (const item of items) if (!rank.has(item.branch)) rank.set(item.branch, rank.size);
    const additions = items
      .filter((item) => !known.has(item.packageId) && (known.add(item.packageId), true))
      .sort(
        (a, b) =>
          rank.get(a.branch)! - rank.get(b.branch)! ||
          a.order - b.order ||
          (a.appVersion || '').localeCompare(b.appVersion || '', undefined, { numeric: true }) ||
          a.fileName.localeCompare(b.fileName),
      )
      .map((item) => ({
        ...item,
        queueId: this.queue.id,
        createdAt: this.queue.createdAt,
        transferId: randomBytes(16).toString('hex'),
        state: 'pending' as const,
        detail: 'В очереди',
        bytesSent: 0,
      }));
    if (this.queue.items.length + additions.length > 10000)
      throw new Ps5QueueFailure('В очереди может быть не больше 10000 пакетов');
    this.queue.items.push(...additions);
    // Waiting items: games in the order they first entered this queue (a later
    // patch joins its game), base before patches and DLC inside a game.
    const queueRank = new Map<string, number>();
    for (const item of this.queue.items.filter((entry) => !terminal(entry)))
      if (!queueRank.has(item.branch)) queueRank.set(item.branch, queueRank.size);
    const waiting = this.queue.items
      .filter((item) => item.state === 'pending' && item !== this.activeItem)
      .sort(
        (a, b) =>
          queueRank.get(a.branch)! - queueRank.get(b.branch)! ||
          a.order - b.order ||
          (a.appVersion || '').localeCompare(b.appVersion || '', undefined, { numeric: true }),
      );
    this.queue.items = [...this.queue.items.filter((item) => !waiting.includes(item)), ...waiting];
    this.queue.status = 'running';
    this.queue.message = 'Очередь PS5';
    this.save();
    this.wake();
    return this.snapshot();
  }
  cancel(queueId: string, packageIds?: string[], branches?: string[]) {
    if (!queueId || queueId !== this.queue.id)
      throw new Ps5QueueFailure('Очередь изменилась. Обновите задания');
    const selected = this.queue.items.filter(
      (item) =>
        (!packageIds && !branches) ||
        packageIds?.includes(item.packageId) ||
        branches?.includes(item.branch),
    );
    if (
      packageIds?.some((id) => !this.queue.items.some((item) => item.packageId === id)) ||
      branches?.some((id) => !this.queue.items.some((item) => item.branch === id))
    )
      throw new Ps5QueueFailure('Задание больше не существует');
    for (const item of selected) {
      if (!ps5CanCancel(item)) continue;
      if (item === this.activeItem) {
        item.cancelRequested = true;
        this.controller?.abort();
      } else {
        item.state = 'cancelled';
        item.detail = 'Убрано из очереди';
        item.completedAt = Date.now();
      }
    }
    this.queue.message = selected.some((item) => item.installDispatched && !terminal(item))
      ? 'Ожидающие пакеты убраны. Отмена принятой системой установки пока не поддерживается'
      : 'Отмена выбранных пакетов запрошена';
    if (this.queue.status === 'paused' && this.queue.items.every(terminal))
      this.queue.status = 'cancelled';
    this.save();
    this.wake();
    void this.cleanupCancelled(true);
    return this.snapshot();
  }
  private cleaning?: Promise<void>;
  private cleanedAt = 0;
  /** How often old cancelled transfers are retried when the PS5 did not answer. */
  static cleanupRetryMs = 5 * 60 * 1000;
  /** Ask the PS5 to drop the partial files of cancelled transfers (one at a
   * time, never during a transfer of this queue). A refused or unanswered
   * cancel stays pending and is tried again later; nothing is installed. */
  cleanupCancelled(force = false) {
    if (this.cleaning) return this.cleaning;
    if (!force && Date.now() - this.cleanedAt < Ps5QueueRunner.cleanupRetryMs)
      return Promise.resolve();
    const left = [...this.queue.items, ...this.queue.history.flat()].filter(ps5PartLeft);
    if (!left.length) return Promise.resolve();
    this.cleanedAt = Date.now();
    this.cleaning = (async () => {
      for (const item of left) {
        if (this.activeItem || !ps5PartLeft(item)) continue;
        try {
          await ps5QueueContext.run(this.queue.consoleId, () => this.driver.cancel(item));
        } catch (error) {
          // A refusal concerns only this transfer; a lost connection, all of them.
          if (error instanceof Ps5QueueFailure || error instanceof Ps5QueueUncertain) continue;
          return;
        }
        item.partCleanup = 'done';
        this.save();
      }
    })()
      .catch(() => {})
      .finally(() => {
        this.cleaning = undefined;
      });
    return this.cleaning;
  }
  confirmInstalled(queueId: string, packageId: string) {
    const item = (
      queueId === this.queue.id
        ? this.queue.items
        : this.queue.history.flat().filter((entry) => entry.queueId === queueId)
    ).find((entry) => entry.packageId === packageId);
    if (!queueId || !item) throw new Ps5QueueFailure('Задание больше не существует в этой очереди');
    if (item.state === 'installed' && item.confirmation === 'user') return this.snapshot();
    if (
      item.observationStoppedAt ||
      !item.installDispatched ||
      !item.serviceJobId ||
      item.bytesSent !== item.size ||
      !['installing', 'unconfirmed', 'failed'].includes(item.state)
    )
      throw new Ps5QueueFailure('Подтверждение доступно после передачи пакета установщику');
    const previous = structuredClone(item);
    Object.assign(item, {
      state: 'installed',
      confirmation: 'user',
      confirmedAt: Date.now(),
      installedAt: Date.now(),
      completedAt: Date.now(),
      detail: 'Установку подтвердил пользователь',
    });
    try {
      this.save();
    } catch (error) {
      for (const key of Object.keys(item)) delete (item as unknown as Record<string, unknown>)[key];
      Object.assign(item, previous);
      throw error;
    }
    this.installed(item);
    this.wake();
    return this.snapshot();
  }
  stopWaiting(queueId: string, packageId: string) {
    const item = this.queue.items.find((item) => item.packageId === packageId);
    if (
      queueId !== this.queue.id ||
      !item ||
      item.state !== 'unconfirmed' ||
      !item.installDispatched
    )
      throw new Ps5QueueFailure('Снять ожидание можно только для неподтверждённой установки');
    const previous = structuredClone(item);
    Object.assign(item, {
      state: 'failed',
      observationStoppedAt: Date.now(),
      completedAt: Date.now(),
      detail:
        'Ожидание снято пользователем. Результат установки на PS5 не подтверждён; повтор не отправлен',
    });
    try {
      this.save();
    } catch (error) {
      for (const key of Object.keys(item)) delete (item as unknown as Record<string, unknown>)[key];
      Object.assign(item, previous);
      throw error;
    }
    // Stop only our read-only reconciliation. Never call transfer cancellation
    // or undo a system dispatch whose outcome is still unknown.
    if (item === this.activeItem) this.controller?.abort(new Error('Observation stopped'));
    this.wake();
    return this.snapshot();
  }
  clear(selected: (item: Ps5Item) => boolean = () => true) {
    for (const item of [...this.queue.items, ...this.queue.history.flat()])
      if (terminal(item) && selected(item)) item.hidden = true;
    this.save();
    return this.snapshot();
  }
  async pause(queueId: string) {
    if (
      queueId !== this.queue.id ||
      this.queue.status !== 'running' ||
      this.queue.items.some((item) => item.installDispatched && !terminal(item))
    )
      throw new Ps5QueueFailure('Приостановка доступна до системной установки');
    this.queue.status = 'paused';
    this.queue.message = 'Передача приостановлена; данные докачки сохранены';
    this.save();
    this.controller?.abort(new Error('Queue paused'));
    await this.settled();
    return this.snapshot();
  }
  resume(queueId: string) {
    if (queueId !== this.queue.id || this.queue.status !== 'paused')
      throw new Ps5QueueFailure('Приостановленная очередь изменилась');
    this.queue.status = 'running';
    this.queue.message = 'Продолжаем передачу с подтверждённой позиции';
    this.save();
    this.wake();
    return this.snapshot();
  }
  wake() {
    if (this.active || this.queue.status !== 'running') return;
    this.active = this.run()
      .catch(() => {
        // Never continue dispatching after a durable write failed. The last
        // persisted intent still controls restart recovery.
        this.queue.message = 'Не удалось сохранить состояние очереди. Отправка приостановлена';
      })
      .finally(() => {
        this.active = undefined;
        void this.cleanupCancelled(true);
      });
  }
  async settled() {
    await this.active;
  }
  /** How long only-unconfirmed items keep a queue running (re-checked meanwhile). */
  static unconfirmedWindowMs = 2 * 60 * 1000;
  /** A transfer that moves no byte this long is aborted and resumed from the
   * offset the PS5 already confirmed (nothing is installed twice). */
  static stallMs = 90 * 1000;
  private unconfirmedSince?: number;
  private async run() {
    while (this.queue.status === 'running') {
      // An unconfirmed base holds only its own game (patches/DLC need the
      // base); an unconfirmed patch or DLC holds nothing, since the base is
      // already confirmed. Unconfirmed items are re-checked when nothing else
      // can run.
      const held = new Set(
        this.queue.items
          .filter((entry) => entry.state === 'unconfirmed' && entry.order === 0)
          .map((e) => e.branch),
      );
      const item =
        this.queue.items.find(
          (entry) => !terminal(entry) && entry.state !== 'unconfirmed' && !held.has(entry.branch),
        ) ?? this.queue.items.find((entry) => !terminal(entry));
      // Only unconfirmed results left: re-check them for a while, then release
      // the queue so a new installation starts its own. They stay in «Задания»
      // with «Установлено на PS5» / «Снять ожидание».
      if (item?.state === 'unconfirmed') {
        this.unconfirmedSince ??= Date.now();
        if (Date.now() - this.unconfirmedSince > Ps5QueueRunner.unconfirmedWindowMs) {
          this.unconfirmedSince = undefined;
          this.queue.status = this.queue.items.some((entry) => entry.state === 'failed')
            ? 'failed'
            : 'completed';
          this.queue.message = 'Очередь PS5 завершена; есть пакеты без подтверждения';
          this.save();
          return;
        }
      } else this.unconfirmedSince = undefined;
      if (!item) {
        this.queue.status = this.queue.items.every((entry) => entry.state === 'cancelled')
          ? 'cancelled'
          : this.queue.items.some(
                (entry) =>
                  entry.state === 'failed' || (entry.state === 'skipped' && !entry.alreadyPresent),
              )
            ? 'failed'
            : 'completed';
        this.queue.message = 'Очередь PS5 завершена';
        this.save();
        return;
      }
      const failedBase = this.queue.items.some(
        (entry) =>
          entry.branch === item.branch &&
          entry.order === 0 &&
          ['failed', 'cancelled', 'skipped'].includes(entry.state) &&
          !entry.alreadyPresent,
      );
      if (item.order > 0 && failedBase) {
        Object.assign(item, {
          state: 'skipped',
          detail: 'Базовая игра в этой очереди не установлена',
          completedAt: Date.now(),
        });
        this.save();
        continue;
      }
      this.activeItem = item;
      this.controller = new AbortController();
      this.speed.reset();
      const checkpoint = (patch: Partial<Ps5Item>) => {
        // A read-only poll that began before the human receipt cannot undo it.
        if (item.confirmation === 'user' || item.observationStoppedAt) return;
        Object.assign(item, patch);
        if (!this.transmissionActive(item)) this.speed.reset();
        else if (patch.bytesSent !== undefined || patch.bytesInFlight !== undefined)
          this.speed.observe(item.bytesSent + (item.bytesInFlight || 0));
        // Byte offsets are already durable on PS5. Coalesce only WEB progress;
        // dispatch intents, hashes and state transitions always fsync immediately.
        if (
          Object.keys(patch).length === 1 &&
          (patch.bytesSent !== undefined ||
            patch.bytesChecked !== undefined ||
            patch.bytesInFlight !== undefined) &&
          Date.now() - this.progressSavedAt < 1000
        )
          return;
        this.save();
        this.progressSavedAt = Date.now();
      };
      const controller = this.controller;
      let progressMark = -1;
      let progressAt = Date.now();
      let stalled = false;
      const watchdog = setInterval(
        () => {
          const sending = item.state === 'sending' && item.progressPhase === 'transfer';
          const mark = item.bytesSent + (item.bytesInFlight || 0);
          if (!sending || mark !== progressMark) {
            progressMark = mark;
            progressAt = Date.now();
          } else if (Date.now() - progressAt >= Ps5QueueRunner.stallMs && !stalled) {
            stalled = true;
            controller.abort(new Error('Transfer stalled'));
          }
        },
        Math.max(10, Math.min(5000, Ps5QueueRunner.stallMs / 4)),
      );
      watchdog.unref?.();
      try {
        if (item.cancelRequested) this.controller.abort();
        if (this.controller.signal.aborted) throw new Error('cancelled');
        const signal = this.controller.signal;
        const result = await ps5QueueContext.run(this.queue.consoleId, () =>
          this.driver.run(item, signal, checkpoint),
        );
        if (item.cancelRequested && !item.installDispatched) throw new Error('cancelled');
        checkpoint(result);
        if (item.state === 'installed' && item.confirmation !== 'user') {
          this.installed(item);
          checkpoint({ installedAt: Date.now(), completedAt: Date.now() });
        } else if (terminal(item)) checkpoint({ completedAt: Date.now() });
      } catch (error) {
        if (item.observationStoppedAt) {
          /* Explicitly stopped observation: preserve its durable unresolved result. */
        } else if ((this.queue.status as Ps5Queue['status']) === 'paused') {
          /* Retain durable offsets; never cancel receiver data. */
        } else if (item.cancelRequested && !item.installDispatched) {
          try {
            await ps5QueueContext.run(this.queue.consoleId, () => this.driver.cancel(item));
            checkpoint({
              state: 'cancelled',
              partCleanup: 'done',
              detail: 'Передача отменена',
              completedAt: Date.now(),
            });
          } catch {
            checkpoint({ detail: 'Ожидаем подтверждение отмены передачи от PS5' });
          }
        } else if (error instanceof Ps5QueueFailure)
          checkpoint({ state: 'failed', detail: error.message, completedAt: Date.now() });
        else if (error instanceof Ps5QueueUncertain)
          checkpoint({ state: 'unconfirmed', detail: error.message });
        else if (stalled) {
          logEvent(
            'warn',
            `PS5: передача «${item.title || item.packageId}» без движения ${Math.round(
              Ps5QueueRunner.stallMs / 1000,
            )} с. Продолжаем с подтверждённого места.`,
          );
          checkpoint({
            detail:
              'Передача остановилась без движения. Продолжаем с места, которое PS5 уже подтвердила',
          });
        } else {
          // Retried automatically; keep the cause visible in the WEB journal.
          const cause = (error as { cause?: { code?: unknown } })?.cause?.code;
          logEvent(
            'warn',
            `PS5: попытка «${item.title || item.packageId}» прервана: ${
              error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 160) : 'unknown'
            }${typeof cause === 'string' ? ` (${cause.slice(0, 40)})` : ''}. Повторяем.`,
          );
          checkpoint({
            detail:
              'Не получено подтверждение запроса PS5. Проверяем состояние передачи; повторная установка не отправлялась',
          });
        }
      }
      clearInterval(watchdog);
      // Bytes still on the way are never progress once the attempt has ended.
      if (item.bytesInFlight) item.bytesInFlight = 0;
      this.activeItem = undefined;
      this.controller = undefined;
      if (this.queue.status !== 'running') return;
      if (!terminal(item))
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.interval);
          timer.unref?.();
        });
    }
  }
}
export function ps5VisibleItems(queue: Ps5Queue) {
  return [...queue.items, ...queue.history.flat()]
    .filter((item) => !item.hidden)
    .sort(
      (a, b) =>
        Number(installationTaskCategory(b.state) === 'active') -
        Number(installationTaskCategory(a.state) === 'active'),
    );
}
