import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
/** A dispatch ledger must never fall back to truncating its previous contents. */
export function writeDurableJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.${process.pid}.tmp`
  try {
    const fd = openSync(tmp, 'w', 0o600)
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
    for (let attempt = 0; ; attempt++) {
      try { renameSync(tmp, path); break } catch (e: any) {
        if (attempt >= 7 || !['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(e.code)) throw e
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * (attempt + 1))
      }
    }
  } finally { rmSync(tmp, { force: true }) }
}
