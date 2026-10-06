import { dataPath } from './data-path'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createError } from 'h3'
import { assertNoFileInstallation } from './console-file-install-store'
import type { RemoveInput, RemoveOperation } from '../../shared/types/console-apps'

export interface StoredRemoval { ip: string; input: RemoveInput; result: RemoveOperation; createdAt: number; pending: boolean; libraryUpdated?: boolean }
const path = dataPath('ps4-remove-operations.json')
export function readRemovals(): StoredRemoval[] {
  if (!existsSync(path)) return []
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    if (data.version !== 1 || !Array.isArray(data.operations) || data.operations.length > 256 || !data.operations.every((r: any) => r && typeof r.ip === 'string' && r.input && r.result &&
      /^[0-9a-f-]{36}$/.test(r.input.requestId) && /^[A-Z0-9]{9}$/.test(r.input.titleId) && ['game', 'patch', 'dlc', 'dlcs'].includes(r.input.kind) &&
      typeof r.input.componentId === 'string' && /^[0-9a-f]{16}$/.test(r.input.revision) && r.input.confirmTitleId === r.input.titleId &&
      r.input.requestId === r.result.requestId && r.input.titleId === r.result.titleId && r.input.kind === r.result.kind && r.input.componentId === r.result.componentId &&
      ['queued', 'running', 'verifying', 'removed', 'failed', 'partial', 'uncertain'].includes(r.result.state) && typeof r.pending === 'boolean')) throw new Error('invalid ledger')
    return data.operations
  } catch { throw createError({ statusCode: 503, message: 'Не удалось прочитать историю удалений WEB. Новая команда не отправлена' }) }
}
export function saveRemovals(operations: StoredRemoval[]) {
  mkdirSync(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.tmp`
  try {
    const fd = openSync(temporary, 'w', 0o600)
    try { writeFileSync(fd, JSON.stringify({ version: 1, operations })); fsyncSync(fd) } finally { closeSync(fd) }
    for (let attempt = 0; ; attempt++) {
      try { renameSync(temporary, path); break } catch (error: any) {
        if (attempt >= 7 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(error?.code)) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * (attempt + 1))
      }
    }
  } catch { throw createError({ statusCode: 503, message: 'WEB не смог сохранить задание удаления. Проверьте прежнюю операцию перед новой командой' }) }
  finally { rmSync(temporary, { force: true }) }
}
export function assertNoRemoval(ip: string) {
  if (readRemovals().some(r => r.ip === ip && (r.pending || ['queued', 'running', 'verifying'].includes(r.result.state))))
    throw createError({ statusCode: 409, message: 'Дождитесь удаления на PS4. Его состояние видно в разделе «На консоли»' })
}
export function assertNoInstallation(ip: string) {
  assertNoFileInstallation(ip)
  const queuePath = dataPath('installation-queue.json')
  if (!existsSync(queuePath)) return
  let q: any
  try { q = JSON.parse(readFileSync(queuePath, 'utf8')) } catch { throw createError({ statusCode: 503, message: 'Не удалось проверить очередь установки' }) }
  if (q.psIp === ip && ['running', 'cancelling'].includes(q.status)) throw createError({ statusCode: 409, message: 'Дождитесь завершения или отмены установки' })
}
