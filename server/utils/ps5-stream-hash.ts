import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { createBLAKE3 } from 'hash-wasm'
import { dataPath } from './data-path'
import { writeDurableJson } from './durable-json'
import { ps5SourceStamp } from './ps5-source-hash'
import { Ps5QueueFailure } from './ps5-queue-core'

const checksum = (value: string) => createHash('sha256').update(value).digest('hex')
/** Private hash-wasm checkpoint, bound to an unchanged source. The PS5's
 * durable offset is authoritative; a missing/bad checkpoint costs a prefix
 * read on recovery, never a guessed content hash or a second network upload. */
export async function ps5StreamHasher(file: FileHandle, root: string, id: string, stamp: string, durable: number, signal: AbortSignal) {
  const hash = await createBLAKE3(256), path = dataPath(`source-stream-checkpoints/${checksum(`${root}/${id}`)}.json`)
  let hashed = 0, saved = 0
  try {
    if (statSync(path).size > 32768) throw new Error('oversized checkpoint')
    const record = JSON.parse(readFileSync(path, 'utf8'))
    if (record.version !== 1 || record.algorithm !== 'hash-wasm-blake3-v1' || record.stamp !== stamp || record.id !== id || record.root !== root || !Number.isSafeInteger(record.offset) || record.offset < 0 || record.offset > durable || typeof record.state !== 'string' || record.checksum !== checksum(`${stamp}/${record.offset}/${record.state}`)) throw new Error('stale checkpoint')
    hash.load(Buffer.from(record.state, 'base64')); hashed = saved = record.offset
  } catch { hash.init() }
  const validate = async () => {
    signal.throwIfAborted()
    if (ps5SourceStamp(await file.stat()) !== stamp) throw new Ps5QueueFailure('Файл Folder изменился во время передачи')
  }
  const pending = new Map<number, string>()
  const read = async (buffer: Buffer, position: number) => {
    await validate()
    if (position !== hashed) throw new Error('Source hash offset mismatch')
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position)
    await validate(); hash.update(buffer.subarray(0, bytesRead)); hashed += bytesRead
    pending.set(hashed, Buffer.from(hash.save()).toString('base64'))
    return bytesRead
  }
  // Normally this is zero or at most a few chunks since the last checkpoint.
  // Only a lost/stale checkpoint needs to read the already-uploaded prefix.
  const buffer = Buffer.alloc(4 * 1024 * 1024)
  while (hashed < durable) {
    const n = await read(buffer.subarray(0, Math.min(buffer.length, durable - hashed)), hashed)
    if (!n) throw new Ps5QueueFailure('Исходный файл Folder обрезан')
    pending.clear()
  }
  const acknowledge = (offset: number, final = false) => {
    const state = pending.get(offset)
    if (state && (final || offset - saved >= 16 * 1024 * 1024)) {
      writeDurableJson(path, { version: 1, algorithm: 'hash-wasm-blake3-v1', root, id, stamp, offset, state, checksum: checksum(`${stamp}/${offset}/${state}`) }); saved = offset
    }
    for (const n of pending.keys()) if (n <= offset) pending.delete(n)
  }
  return { read, validate, acknowledge, digest: () => hash.digest('hex') }
}
