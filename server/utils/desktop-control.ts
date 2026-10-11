import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { createError, getHeader, type H3Event } from 'h3'
import { dataPath } from './data-path'
import { activePackageTransfers } from './package-library'
import { desktopRequests } from './desktop-lifecycle'

export function assertDesktopControl(event: H3Event) {
  const expected = process.env.PACKAGEFLOW_LAUNCHER_KEY || ''
  const supplied = getHeader(event, 'x-packageflow-launcher-key') || ''
  const digest = (key: string) => createHash('sha256').update(key).digest()
  if (!expected || !timingSafeEqual(digest(expected), digest(supplied)))
    throw createError({ statusCode: 404, message: 'Not found' })
}

function ledger(file: string, fallback: any) {
  const path = dataPath(file)
  if (!existsSync(path)) return fallback
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch { throw createError({ statusCode: 503, message: 'Не удалось проверить активные задания. Остановка заблокирована.' }) }
}

/** Conservative: an uncertain accepted operation must not be interrupted. */
export function desktopActivity() {
  const reasons: string[] = []
  if (desktopRequests()) reasons.push('request')
  const consoles = existsSync(dataPath('consoles')) ? readdirSync(dataPath('consoles'), { withFileTypes: true }).filter(item => item.isDirectory() && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(item.name)).map(item => item.name) : []
  const scoped = consoles.map(ip => ledger(`consoles/${ip}/installation-queue.json`, {}))
  const old = ledger('installation-queue.json', {})
  const queues = [...scoped, ...(!scoped.some(queue => queue.psIp === old.psIp) ? [old] : [])]
  if (queues.some(queue => ['running', 'cancelling'].includes(queue.status))) reasons.push('installation')
  if (activePackageTransfers()) reasons.push('transfer')
  const maintenance = ledger('console-maintenance.json', {})
  if (Object.values(maintenance).some((r: any) => !['completed', 'failed'].includes(r?.state))) reasons.push('maintenance')
  const removals = ledger('ps4-remove-operations.json', { operations: [] })
  if (!Array.isArray(removals.operations)) throw createError({ statusCode: 503, message: 'Invalid removal ledger' })
  if (removals.operations.some((r: any) => r.pending || ['queued', 'running', 'verifying', 'uncertain'].includes(r.result?.state))) reasons.push('removal')
  const files = ledger('console-file-installations.json', { jobs: [] })
  if (!Array.isArray(files.jobs)) throw createError({ statusCode: 503, message: 'Invalid installation ledger' })
  if (files.jobs.some((r: any) => !r.rejected && (r.pending || !r.job || !['installed', 'failed', 'cancelled'].includes(r.job.state)))) reasons.push('local-installation')
  const commands = ledger('console-app-commands.json', { records: [] })
  if (!Array.isArray(commands.records)) throw createError({ statusCode: 503, message: 'Invalid command ledger' })
  if (commands.records.some((r: any) => ['pending', 'uncertain'].includes(r.state))) reasons.push('command')
  const ids = existsSync(dataPath('consoles')) ? readdirSync(dataPath('consoles'),{withFileTypes:true}).filter(d=>d.isDirectory()&&/^[a-zA-Z0-9_-]{1,64}$/.test(d.name)).map(d=>d.name) : []
  if (ids.some(id=> {const q=ledger(`consoles/${id}/ps5-installation-queue.json`,{});return q.status==='running'||q.items?.some((i:any)=>['sending','verifying','installing','waiting','unconfirmed'].includes(i.state))})) reasons.push('ps5-installation')
  const setup = existsSync(dataPath('console-setup')) ? readdirSync(dataPath('console-setup')).filter(f=>/^bootstrap-[a-zA-Z0-9_-]+\.json$/.test(f)) : []
  if (setup.some(file=>!['completed','failed'].includes(ledger(`console-setup/${file}`,{}).state))) reasons.push('ps5-bootstrap')
  return { busy: reasons.length > 0, reasons }
}
