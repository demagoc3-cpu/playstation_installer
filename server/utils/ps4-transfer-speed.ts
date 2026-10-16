import { TransferSpeed } from './transfer-speed';

interface ProgressItem {
  packageId: string;
  state: string;
  bytesSent: number;
  size?: number;
  requestId?: string;
  dispatchedAt?: number;
  serviceDispatchedAt?: number;
}
interface ProgressQueue {
  id?: string;
  createdAt?: number;
  psIp?: string;
  status: string;
  items: ProgressItem[];
}
const downloading = (q: ProgressQueue, item: ProgressItem) =>
  q.status === 'running' &&
  (item.state === 'receiving' || item.state === 'installing') &&
  Number.isSafeInteger(item.bytesSent) &&
  item.bytesSent >= 0 &&
  Number.isSafeInteger(item.size) &&
  item.size! > item.bytesSent;
const queueKey = (q: ProgressQueue) => JSON.stringify([q.id, q.createdAt]);
const attemptKey = (item: ProgressItem) =>
  JSON.stringify([item.packageId, item.requestId, item.dispatchedAt, item.serviceDispatchedAt]);

/** Samples PS4's download counters; rates never enter durable queue/history JSON.
 * Existing bytes on restart/resume form the baseline, not newly transferred data.
 */
export class Ps4TransferSpeed {
  private consoles = new Map<string, { queue: string; items: Map<string, TransferSpeed> }>();
  private clock: () => number;
  constructor(clock: () => number = () => performance.now()) {
    this.clock = clock;
  }
  observe(queue: ProgressQueue) {
    const ip = queue.psIp || 'legacy',
      key = queueKey(queue);
    let owner = this.consoles.get(ip);
    if (!owner || owner.queue !== key) {
      owner = { queue: key, items: new Map() };
      this.consoles.set(ip, owner);
    }
    const active = new Set<string>();
    for (const item of queue.items) {
      if (!downloading(queue, item)) continue;
      const key = attemptKey(item);
      active.add(key);
      let speed = owner.items.get(key);
      if (!speed) {
        speed = new TransferSpeed(this.clock);
        owner.items.set(key, speed);
      }
      speed.observe(item.bytesSent);
    }
    for (const key of owner.items.keys()) if (!active.has(key)) owner.items.delete(key);
    if (!owner.items.size) this.consoles.delete(ip);
  }
  read(queue: ProgressQueue, item: ProgressItem) {
    const owner = this.consoles.get(queue.psIp || 'legacy');
    if (!downloading(queue, item) || owner?.queue !== queueKey(queue)) return {};
    const speed = owner.items.get(attemptKey(item));
    if (!speed) return {};
    return {
      progressPhase: 'transfer' as const,
      transferBytesPerSecond: speed.read() ?? 0,
      transferMeasuredAt: Date.now(),
    };
  }
}
