import { Ps5QueueFailure } from './ps5-queue-core';

/** Only the exact, hardware-qualified batch limit enables the pipelined route.
 * Older services keep their bounded chunk protocol. */
export function ps5TransferProtocol(reply: { chunkMax?: unknown; batchMax?: unknown }) {
  if (
    reply.batchMax === 16 * 1024 * 1024 ||
    reply.batchMax === 32 * 1024 * 1024 ||
    reply.batchMax === 64 * 1024 * 1024 ||
    reply.batchMax === 128 * 1024 * 1024
  )
    return { path: '/api/v1/transfers/batch' as const, size: reply.batchMax };
  const max = reply.chunkMax;
  const size =
    typeof max === 'number' &&
    Number.isInteger(max) &&
    max >= 262144 &&
    max <= 4194304 &&
    (max & (max - 1)) === 0
      ? max
      : 262144;
  return { path: '/api/v1/transfers/chunk' as const, size };
}

/* The PS5 service drops a batch whose body is not received within 60 s
 * (receive.c); nothing of it becomes durable. On a slow route (VPN, Wi-Fi) a
 * full 128 MiB batch can never fit, so the same batch would be resent forever.
 * Batches therefore aim at ~20 s each: fast links keep the qualified maximum,
 * slower ones shrink after a slow or timed-out batch, and the size is
 * remembered per console so a retry starts with a batch that fits. */
const BATCH_TARGET_MS = 20000,
  BATCH_SLOW_FAILURE_MS = 30000,
  BATCH_MIN = 1024 * 1024;
const batchSizes = new Map<string, number>();
function batchFit(bytes: number, elapsedMs: number) {
  const ideal = (bytes * BATCH_TARGET_MS) / Math.max(1, elapsedMs);
  let fit = BATCH_MIN;
  while (fit * 2 <= ideal) fit *= 2;
  return fit;
}
/** Test hook: forget remembered batch sizes. */
export function resetPs5BatchSizes() {
  batchSizes.clear();
}

/** Read one chunk ahead while PS5 receives/fsyncs the current chunk. The next
 * POST still waits for its predecessor's durable ACK; buffers never overlap. */
export async function ps5SendChunks(input: {
  read: (buffer: Buffer, position: number) => Promise<number>;
  size: number;
  offset: number;
  chunkSize: number;
  signal: AbortSignal;
  validateSource: () => Promise<boolean>;
  send: (offset: number, bytes: Uint8Array) => Promise<void>;
  progress: (offset: number) => void;
  /** Batch route only: remember the fitting batch size under this key (console). */
  adaptiveKey?: string;
  now?: () => number;
}) {
  const { size, chunkSize, signal } = input;
  signal.throwIfAborted();
  if (input.offset >= size) return;
  const key = input.adaptiveKey,
    now = input.now ?? (() => performance.now());
  let length = Math.max(
    1,
    Math.min(chunkSize, key ? (batchSizes.get(key) ?? chunkSize) : chunkSize),
  );
  const bufferSize = Math.min(chunkSize, size - input.offset);
  const buffers = [Buffer.alloc(bufferSize), Buffer.alloc(bufferSize)];
  let offset = input.offset,
    index = 0;
  // Catch immediately: an early read failure must not become an unhandled rejection
  // while the current network request is in flight.
  const read = (position: number, buffer: Buffer, want: number) =>
    input.read(buffer.subarray(0, want), position).then(
      (result) => ({ result, error: undefined, want }),
      (error) => ({ result: undefined, error, want }),
    );
  let pending = read(offset, buffers[index]!, Math.min(length, size - offset));
  try {
    while (offset < size) {
      signal.throwIfAborted();
      const part = await pending;
      if (part.error) throw part.error;
      const count = part.result!;
      if (count !== part.want || !(await input.validateSource()))
        throw new Ps5QueueFailure('Исходный файл изменился во время передачи');
      signal.throwIfAborted();
      const next = offset + count,
        current = buffers[index]!;
      index = 1 - index;
      if (next < size) pending = read(next, buffers[index]!, Math.min(length, size - next));
      const started = now();
      try {
        await input.send(offset, current.subarray(0, count));
      } catch (error) {
        const elapsed = now() - started;
        // Only a batch that ran into the time limit shrinks; a quick lost ACK
        // or reset keeps its size and is reconciled as before.
        if (key && !signal.aborted && elapsed >= BATCH_SLOW_FAILURE_MS)
          batchSizes.set(key, Math.max(BATCH_MIN, Math.min(count / 2, batchFit(count, elapsed))));
        throw error;
      }
      if (key) {
        const elapsed = now() - started;
        if (elapsed > BATCH_TARGET_MS) length = Math.min(length, batchFit(count, elapsed));
        else if (count === length && elapsed * 4 < BATCH_TARGET_MS)
          length = Math.min(chunkSize, length * 2);
        length = Math.max(Math.min(BATCH_MIN, chunkSize), length);
        if (length >= chunkSize) batchSizes.delete(key);
        else batchSizes.set(key, length);
      }
      signal.throwIfAborted();
      offset = next;
      input.progress(offset);
    }
  } finally {
    await pending;
  }
}
