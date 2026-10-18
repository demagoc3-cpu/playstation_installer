import { createRequire as moduleRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

/* BLAKE3 of a whole package takes minutes of CPU. On the main thread it slows
 * every other WEB request (install reviews, other consoles). The worker reads
 * the already open file by its descriptor and hashes it on its own thread; the
 * main thread only receives progress and the digest. Same hash-wasm BLAKE3,
 * same 1 MiB reads, so the digest is identical. */
const source = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const { createBLAKE3 } = require(workerData.hashWasm);
(async () => {
  const hash = await createBLAKE3(256), buffer = Buffer.alloc(1024 * 1024);
  let position = 0, reportedAt = Date.now();
  while (position < workerData.size) {
    const read = fs.readSync(workerData.fd, buffer, 0, Math.min(buffer.length, workerData.size - position), position);
    if (!read) return parentPort.postMessage({ truncated: true });
    hash.update(buffer.subarray(0, read));
    position += read;
    if (Date.now() - reportedAt >= 1000) {
      parentPort.postMessage({ progress: position });
      reportedAt = Date.now();
    }
  }
  parentPort.postMessage({ progress: position, digest: hash.digest('hex') });
})().catch((error) => parentPort.postMessage({ error: String((error && error.message) || error) }));
`;

let hashWasm: string | null | undefined;
function hashWasmPath() {
  if (hashWasm === undefined) {
    try {
      hashWasm =
        process.env.PACKAGEFLOW_HASH_WORKER === '0'
          ? null
          : moduleRequire(import.meta.url).resolve('hash-wasm');
    } catch {
      hashWasm = null;
    }
  }
  return hashWasm;
}

/** The digest of `size` bytes of `fd` from a worker thread, or null when no
 * worker can be started here (the caller then hashes on the main thread). */
export function ps5HashFileInWorker(
  fd: number,
  size: number,
  signal: AbortSignal,
  progress: (bytes: number) => void,
): Promise<string> | null {
  const path = hashWasmPath();
  if (!path) return null;
  let worker: Worker;
  try {
    worker = new Worker(source, { eval: true, workerData: { fd, size, hashWasm: path } });
  } catch {
    return null;
  }
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, digest?: string) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      void worker.terminate();
      if (error !== undefined) reject(error);
      else resolve(digest!);
    };
    const abort = () => finish(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    worker.on('message', (message: any) => {
      if (typeof message?.progress === 'number') progress(message.progress);
      if (message?.truncated) finish(new Error('Исходный пакет обрезан'));
      else if (typeof message?.error === 'string') finish(new Error(message.error));
      else if (typeof message?.digest === 'string') finish(undefined, message.digest);
    });
    worker.on('error', (error) => finish(error));
    worker.on('exit', () => finish(new Error('Поток подсчёта BLAKE3 завершился без результата')));
  });
}
