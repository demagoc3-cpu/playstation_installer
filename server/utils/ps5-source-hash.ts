import type { FileHandle } from 'node:fs/promises';
import { createBLAKE3 } from 'hash-wasm';
import { ps5HashFileInWorker } from './ps5-hash-worker';

export const ps5SourceStamp = (s: { size: number; mtimeMs: number; ino: number }) =>
  `${s.size}:${s.mtimeMs}:${s.ino}`;

/** Hash the source separately from transfer progress; cancellation never yields a usable digest. */
export async function ps5SourceHash(
  file: FileHandle,
  size: number,
  identity: string,
  signal: AbortSignal,
  progress: (bytes: number) => void,
  now: () => number = Date.now,
) {
  signal.throwIfAborted();
  // Off the main thread when possible: the same digest, without slowing WEB.
  const inWorker = ps5HashFileInWorker(file.fd, size, signal, progress);
  if (inWorker) {
    progress(0);
    const digest = await inWorker;
    if (ps5SourceStamp(await file.stat()) !== identity)
      throw new Error('Исходный файл изменился во время проверки');
    signal.throwIfAborted();
    return digest;
  }
  const hash = await createBLAKE3(256),
    buffer = Buffer.alloc(1024 * 1024);
  let position = 0,
    reportedAt = now();
  progress(0);
  while (position < size) {
    signal.throwIfAborted();
    const read = await file.read(buffer, 0, Math.min(buffer.length, size - position), position);
    signal.throwIfAborted();
    if (!read.bytesRead) throw new Error('Исходный пакет обрезан');
    hash.update(buffer.subarray(0, read.bytesRead));
    position += read.bytesRead;
    const time = now();
    if (time - reportedAt >= 1000 || position === size) {
      progress(position);
      reportedAt = time;
    }
  }
  if (ps5SourceStamp(await file.stat()) !== identity)
    throw new Error('Исходный файл изменился во время проверки');
  signal.throwIfAborted();
  return hash.digest('hex');
}
