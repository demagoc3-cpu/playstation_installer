import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createError } from 'h3'
import { writeDurableJson } from './durable-json'
import type { ConsolePackageInstallation } from '../../shared/types/console-file-install'
const file = resolve(process.cwd(), '.data/console-file-installations.json')
export const localInstallActive = (record: ConsolePackageInstallation) => !record.rejected && (record.pending || !record.job || !['installed', 'failed', 'cancelled'].includes(record.job.state))
export function readFileInstallations(): ConsolePackageInstallation[] {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (data.version !== 1 || !Array.isArray(data.jobs) || !data.jobs.every((j: any) => typeof j.ip === 'string' && /^[0-9a-f-]{36}$/.test(j.id) && typeof j.path === 'string' && typeof j.pending === 'boolean')) throw new Error('invalid')
    return data.jobs
  } catch (cause: any) {
    if (cause.code === 'ENOENT') return []
    throw createError({ statusCode: 503, message: 'Не удалось прочитать журнал установки из файлов' })
  }
}
export function saveFileInstallations(jobs: ConsolePackageInstallation[]) { writeDurableJson(file, { version: 1, jobs }) }
export function assertNoFileInstallation(ip: string) {
  if (readFileInstallations().some(j => j.ip === ip && localInstallActive(j))) throw createError({ statusCode: 409, message: 'Дождитесь установки PKG в разделе «Файлы» или отмените её там' })
}
