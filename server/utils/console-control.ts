import { createError } from 'h3'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { writeDurableJson as writeJsonFile } from './durable-json'
import { assertNoMaintenance } from './maintenance-store'
import { ps4ServiceIp } from './ps4-service'
import { authenticatedServiceRequest } from './ps4-service-installer'
import { assertNoInstallation, assertNoRemoval } from './console-operation-store'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const file = resolve(process.cwd(), '.data/console-control.json')
function address(v: unknown) { const ip = ps4ServiceIp(v); if (!ip) throw createError({ statusCode: 400, message: 'Укажите IP PS4' }); return ip }
function read(): Record<string, any> { try { return JSON.parse(readFileSync(file, 'utf8')) } catch (e: any) { if (e.code === 'ENOENT') return {}; throw createError({ statusCode: 503, message: 'Журнал команд повреждён; повтор не отправлен' }) } }
function check(v: any, input: any) {
  if (!v || v.service !== 'PackegeFlowService' || v.requestId !== input.requestId || v.titleId !== input.titleId || v.action !== input.action || !['pending', 'running', 'stopped', 'failed', 'uncertain'].includes(v.state) || !Number.isInteger(v.appId) || !Number.isInteger(v.error) || !/^0x[0-9A-F]{8}$/.test(v.errorHex)) throw createError({ statusCode: 502, message: 'Неожиданный ответ команды PS4' })
  return v
}
export function confirmConsoleRestart(ip: string, requestId: string) {
  const data = read(); const previous = data[ip]
  if (previous?.input.requestId === requestId && previous.input.action === 'restart') { previous.result = { ...previous.result, state: 'running', message: 'Новая версия сервиса подтверждена' }; writeJsonFile(file, data) }
}
export function failConsoleRestart(ip: string, requestId: string, message: string) {
  const data = read(); const previous = data[ip]
  if (previous?.input.requestId === requestId && previous.input.action === 'restart' && ['pending', 'uncertain'].includes(previous.result?.state)) {
    previous.result = { ...previous.result, state: 'failed', message }
    writeJsonFile(file, data)
  }
}
export async function consoleRuntime(value: unknown, title: unknown) {
  if (typeof title !== 'string' || !/^[A-Z0-9]{9}$/.test(title)) throw createError({ statusCode: 400, message: 'Неверный TITLE_ID' })
  const v = await authenticatedServiceRequest(address(value), `/apps/runtime/${title}`, 'GET') as any
  if (v?.service !== 'PackegeFlowService' || v.titleId !== title || typeof v.running !== 'boolean' || !Number.isInteger(v.appId) || (v.running ? (v.appId >>> 24) !== 0x60 : v.appId !== -1)) throw createError({ statusCode: 502, message: 'Не удалось проверить запущенное приложение' })
  return v
}
export async function getConsoleControl(value: unknown) {
  const ip = address(value); const entry = read()[ip]; if (!entry) return null
  if (!uuid.test(entry.input?.requestId)) throw createError({ statusCode: 503, message: 'Журнал команд повреждён' })
  if (!['pending', 'uncertain'].includes(entry.result?.state)) return entry.result
  if (entry.input.action === 'restart') {
    // Restart replaces the daemon. Its new process does not know the old
    // control request, so confirm it from the installed PKG version instead.
    try { await (await import('./console-maintenance')).getMaintenance(ip) } catch { /* Keep the old result until version verification succeeds. */ }
    const confirmed = read()[ip]
    if (confirmed?.input.requestId === entry.input.requestId && !['pending', 'uncertain'].includes(confirmed.result?.state)) return confirmed.result
  }
  try {
    const result = check(await authenticatedServiceRequest(ip, `/apps/control/${entry.input.requestId}`, 'GET'), entry.input)
    const data = read(); data[ip] = { input: entry.input, result }; writeJsonFile(file, data); return result
  } catch { return { ...entry.result, message: 'Ответ команды пока не подтверждён. Повтор не отправлен' } }
}
export async function submitConsoleControl(value: unknown, body: any, allowRestart = false, owner?: string) {
  const ip = address(value)
  if (!body || !uuid.test(body.requestId) || !/^[A-Z0-9]{9}$/.test(body.titleId) || (!['launch', 'stop'].includes(body.action) && !(allowRestart && body.action === 'restart' && body.titleId === 'PFLS00001' && uuid.test(body.expected))) ||
    (body.action === 'launch' ? body.expected !== '' : body.action === 'stop' && !/^60[0-9A-F]{6}$/.test(body.expected))) throw createError({ statusCode: 400, message: 'Неверная команда приложения' })
  const input = { requestId: body.requestId, titleId: body.titleId, action: body.action, expected: body.expected }
  const data = read(); const previous = data[ip]
  if (previous?.input.requestId === input.requestId) { if (JSON.stringify(previous.input) !== JSON.stringify(input)) throw createError({ statusCode: 409, message: 'Команда изменена' }); return getConsoleControl(ip) }
  if (previous && ['pending', 'uncertain'].includes(previous.result?.state)) throw createError({ statusCode: 409, message: 'Сначала проверьте результат предыдущей команды' })
  assertNoMaintenance(ip, owner); assertNoInstallation(ip); assertNoRemoval(ip)
  data[ip] = { input, result: { ...input, appId: -1, state: 'uncertain', error: 0, errorHex: '0x00000000' } }; writeJsonFile(file, data)
  try {
    const result = check(await authenticatedServiceRequest(ip, '/apps/control', 'POST', input), input)
    const next = read(); next[ip] = { input, result }; writeJsonFile(file, next); return result
  } catch (e: any) {
    if (e.statusCode && [400, 401, 403, 409].includes(e.statusCode)) { const next = read(); next[ip].result = { ...data[ip].result, state: 'failed', message: e.message }; writeJsonFile(file, next); throw e }
    return getConsoleControl(ip)
  }
}
