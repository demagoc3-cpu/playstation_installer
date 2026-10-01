import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createError } from 'h3'
import { writeDurableJson } from './durable-json'

const root = resolve(process.cwd(), '.data/save-restores')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface SaveRestoreRecord {
  rollbackId: string
  ip: string
  userId: string
  titleId: string
  slot: string
  sourceBackupId: string
  safetyBackupId: string
  verifiedBackupId: string
  createdAt: string
  state: 'pending' | 'accepted' | 'rolledBack' | 'uncertain'
}

export function readSaveRestore(id: unknown): SaveRestoreRecord {
  if (typeof id !== 'string' || !uuid.test(id)) throw createError({ statusCode: 400, message: 'Неверный номер восстановления' })
  try {
    const record = JSON.parse(readFileSync(resolve(root, `${id}.json`), 'utf8')) as SaveRestoreRecord
    if (record.rollbackId !== id || !['pending', 'accepted', 'rolledBack', 'uncertain'].includes(record.state)) throw new Error('invalid record')
    return record
  } catch { throw createError({ statusCode: 404, message: 'Восстановление не найдено' }) }
}

export function writeSaveRestore(record: SaveRestoreRecord) {
  if (!uuid.test(record.rollbackId)) throw new Error('Invalid restore ID')
  writeDurableJson(resolve(root, `${record.rollbackId}.json`), record)
}

export function pendingSaveRestores(ip: string, userId: string, titleId: string): SaveRestoreRecord[] {
  if (!existsSync(root)) return []
  return readdirSync(root).filter(name => uuid.test(name.slice(0, -5)) && name.endsWith('.json')).flatMap(name => {
    try {
      const record = readSaveRestore(name.slice(0, -5))
      return record.ip === ip && record.userId === userId && record.titleId === titleId && ['pending', 'uncertain'].includes(record.state) ? [record] : []
    } catch { return [] }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
