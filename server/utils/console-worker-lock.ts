import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dataPath } from './data-path'

/** A shared data directory must have only one worker for each console operation. */
export function claimConsoleWorker(kind: 'installation' | 'reinstall' | 'bootstrap', ip: string): (() => void) | undefined {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) return undefined
  const directory = dataPath('consoles', ip)
  mkdirSync(directory, { recursive: true })
  const path = dataPath('consoles', ip, `${kind}-worker.lock`)
  const owner = { pid: process.pid, token: randomUUID() }
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number
    try { fd = openSync(path, 'wx', 0o600) }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error
      let previous: typeof owner
      try { previous = JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0 || typeof previous.token !== 'string') return undefined
      try { process.kill(previous.pid, 0); return undefined }
      catch (probe: any) { if (probe.code !== 'ESRCH') return undefined }
      // Serialize reclamation: two workers must never unlink each other's new lock.
      const reclaimPath = `${path}.reclaim`
      let reclaimFd: number
      try { reclaimFd = openSync(reclaimPath, 'wx', 0o600) } catch { return undefined }
      try {
        if (JSON.parse(readFileSync(path, 'utf8')).token !== previous.token) return undefined
        unlinkSync(path)
      } catch { return undefined }
      finally { closeSync(reclaimFd); try { unlinkSync(reclaimPath) } catch { /* Fail closed if cleanup fails. */ } }
      continue
    }
    try { writeFileSync(fd, JSON.stringify(owner)) } finally { closeSync(fd) }
    return () => {
      try { if (JSON.parse(readFileSync(path, 'utf8')).token === owner.token) unlinkSync(path) } catch { /* Already released or replaced. */ }
    }
  }
  return undefined
}
