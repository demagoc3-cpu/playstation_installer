import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createError } from 'h3'
import { writeDurableJson } from './durable-json'
export const maintenanceFile = resolve(process.cwd(), '.data/console-maintenance.json')
export function readMaintenance(): Record<string, any> {
  try { const data = JSON.parse(readFileSync(maintenanceFile, 'utf8')); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid ledger'); return data }
  catch (e: any) { if (e.code === 'ENOENT') return {}; throw createError({ statusCode: 503, message: 'Журнал обслуживания повреждён; новая команда не отправлена' }) }
}
export function saveMaintenance(data: Record<string, any>) { writeDurableJson(maintenanceFile, data) }
export function assertNoMaintenance(ip: string, owner?: string) {
  const flow = readMaintenance()[ip]
  if (flow && flow.id !== owner && !['completed', 'failed'].includes(flow.state)) throw createError({ statusCode: 409, message: 'Дождитесь обновления сервиса или переустановки игры в WEB' })
}
