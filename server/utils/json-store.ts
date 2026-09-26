import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// On Windows, antivirus, the search indexer or OneDrive may briefly hold a
// freshly written file open. rename() then fails with EPERM/EBUSY/EACCES,
// which on Linux never happens. Retry a few times and, as a last resort,
// write the target directly instead of crashing the request.
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'])
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))
const sleep = (ms: number) => Atomics.wait(sleepBuffer, 0, 0, ms)

export function readJsonFile<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return fallback }
}

export function writeJsonFile(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  const data = JSON.stringify(value)
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, data)
  for (let attempt = 0; attempt < 8; attempt++) {
    try { renameSync(temporary, path); return } catch (error: any) {
      if (!RETRYABLE.has(error?.code)) { rmSync(temporary, { force: true }); throw error }
      sleep(15 * (attempt + 1))
    }
  }
  // Rename kept failing: fall back to a direct (non-atomic) write.
  try { writeFileSync(path, data) } finally { rmSync(temporary, { force: true }) }
}
