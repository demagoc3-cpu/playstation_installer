import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { ps4ServiceIp } from './ps4-service'
import { validServiceJob } from './installation-transport'
import type { ServiceInstallCapabilities, ServiceInstallJob } from '../../shared/types/installation'

const settingsPath = resolve(process.cwd(), '.data/ps4-service-keys.json')
type Settings = Record<string, string>
function settings(): Settings {
  try { const data = JSON.parse(readFileSync(settingsPath, 'utf8')); return data && typeof data === 'object' && !Array.isArray(data) ? data : {} } catch { return {} }
}
function consoleIp(value: unknown) {
  const ip = ps4ServiceIp(value)
  if (!ip) throw createError({ statusCode: 400, message: 'Укажите корректный IPv4-адрес PS4' })
  return ip
}
function token(ip: string) {
  const key = settings()[ip]
  if (typeof key !== 'string' || !/^[0-9a-f]{32}$/.test(key)) throw createError({ statusCode: 409, message: 'Введите код сопряжения с экрана запускателя PS4' })
  return key
}
export function serviceKeyConfigured(ip: string) {
  const key = settings()[consoleIp(ip)]
  return typeof key === 'string' && /^[0-9a-f]{32}$/.test(key)
}

const explanations: Record<string, string> = {
  apps_unavailable: 'Управление установленными приложениями недоступно',
  inventory_scan_failed: 'Не удалось прочитать установленные приложения PS4',
  inventory_changed_refresh: 'Состав игры изменился или прочитан не полностью. Обновите список',
  console_operation_busy: 'На PS4 выполняется установка или удаление. Дождитесь завершения',
  application_installing: 'Игра сейчас устанавливается или обновляется',
  protected_application: 'Удаление системного приложения или самого сервиса запрещено',
  component_not_found: 'Компонент уже отсутствует. Обновите список',
  remove_history_full: 'История удалений сервиса заполнена',
  remove_journal_failed: 'PS4 не смогла сохранить задание удаления',
  request_id_conflict: 'Идентификатор уже использован для другой команды',
  remove_job_not_found: 'Прежнее задание не найдено. Повторная команда не отправлена',
  service_key_required: 'Сохранённый ключ не принят; выполните сопряжение с PS4 заново',
  pairing_code_invalid: 'Неверный код сопряжения',
  pairing_expired_reopen_launcher: 'Код истёк или уже использован. Откройте запускатель на PS4 для нового кода',
  game_already_exists_no_overwrite: 'Игра уже есть на PS4. Используйте «Переустановить» в библиотеке',
  application_changed_refresh: 'Запущенное приложение изменилось. Обновите его состояние',
  application_not_installed: 'Приложение больше не установлено на PS4',
  control_unavailable: 'Для запуска и остановки установите PKG 1.19',
  control_not_found: 'Команда не найдена на PS4. Повтор автоматически не отправлен',
  control_history_full: 'История команд сервиса заполнена',
  another_service_job_active: 'На PS4 уже есть активное задание сервиса',
  job_history_full: 'История заданий сервиса заполнена',
  job_not_found: 'PS4 не нашла прежнее задание. Автоматический повтор не отправлен',
  task_state_unknown_check_console: 'Проверьте принятое задание в загрузках PS4; его состояние неизвестно',
  invalid_game_request: 'Сервис 1.17 принимает только базовую игру, без патча или DLC',
}
/** Only internal callers construct routes. Credentials stay on the WEB server. */
export async function authenticatedServiceRequest(ip: string, path: string, method: 'GET' | 'POST', body?: unknown) {
  if (!/^\/apps\/(?:list(?:\?|$)|title\/|operations\/|remove$|control(?:\/|$)|runtime\/)/.test(path)) throw new Error('Unexpected console route')
  return request(ip, path, method, token(consoleIp(ip)), body)
}
export async function getServiceIcon(ip: string, titleId: string) {
  if (!/^[A-Z0-9]{9}$/.test(titleId)) throw createError({ statusCode: 400, message: 'Неверный TITLE_ID' })
  const response = await fetch(`http://${consoleIp(ip)}:12801/apps/icon/${titleId}`, { redirect: 'error', signal: AbortSignal.timeout(7000), headers: { Authorization: `Bearer ${token(consoleIp(ip))}` } })
  if (!response.ok || !response.body || !/^image\/png(?:;|$)/i.test(response.headers.get('content-type') || '')) throw createError({ statusCode: 404, message: 'Обложка отсутствует' })
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 512 * 1024) throw new Error('Image limit'); chunks.push(value) } }
  finally { await reader.cancel().catch(() => {}) }
  const data = Buffer.concat(chunks)
  if (data.length < 8 || !data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw createError({ statusCode: 404, message: 'Обложка отсутствует' })
  return data
}
async function request(ip: string, path: string, method: 'GET' | 'POST', key?: string, body?: unknown): Promise<unknown> {
  // Paths are constructed internally; keep a fixed port and forbid redirects.
  const response = await fetch(`http://${consoleIp(ip)}:12801${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(7000),
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
  })
  if (!response.body) throw new Error('Пустой ответ сервиса')
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 16384) throw new Error('Слишком большой ответ сервиса'); chunks.push(value) }
  } finally { await reader.cancel().catch(() => {}) }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!response.ok) {
    const message = explanations[data?.error] || 'Сервис не принял запрос'
    throw createError({ statusCode: response.status, message: `${message}${data?.errorHex ? ` (${data.errorHex})` : ''}` })
  }
  return data
}
function capabilities(value: unknown): ServiceInstallCapabilities {
  const c = value as Partial<ServiceInstallCapabilities> | null
  if (!c || c.service !== 'PackegeFlowService' || c.installApi !== 1 || c.authentication !== 'bearer' ||
    typeof c.ready !== 'boolean' || !Array.isArray(c.contentTypes) || !c.contentTypes.every(t => typeof t === 'string'))
    throw createError({ statusCode: 502, message: 'Неожиданный ответ API установки' })
  return c as ServiceInstallCapabilities
}
export async function getServiceInstallerStatus(ip: string) {
  ip = consoleIp(ip)
  const configured = serviceKeyConfigured(ip)
  try {
    const c = capabilities(await request(ip, '/install/capabilities', 'GET'))
    if (!c.ready) return { ready: false, configured, contentTypes: c.contentTypes, version: c.version, message: `API установки недоступен (${c.errorHex})` }
    if (!configured) return { ready: false, configured, contentTypes: c.contentTypes, version: c.version, message: 'Введите код сопряжения с экрана запускателя PS4' }
    capabilities(await request(ip, '/install/session', 'GET', token(ip)))
    return { ready: true, configured, contentTypes: c.contentTypes, version: c.version, message: 'Сервис готов к установке базовой игры' }
  } catch (error: any) {
    return { ready: false, configured, contentTypes: [], message: error?.statusCode === 404 ? 'Обновите PackegeFlowService до PKG 1.17' : error?.statusCode ? error.message : 'Сервис не отвечает на порту 12801' }
  }
}
export async function saveServiceKey(ip: string, value: unknown) {
  ip = consoleIp(ip)
  const code = typeof value === 'string' ? value.trim().toUpperCase() : ''
  if (!/^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(code)) throw createError({ statusCode: 400, message: 'Введите код вида F7Y-YUH с экрана PS4' })
  const paired = await request(ip, '/install/pair', 'POST', undefined, { code }) as { service?: string; token?: unknown; paired?: boolean }
  if (paired?.service !== 'PackegeFlowService' || paired.paired !== true || typeof paired.token !== 'string' || !/^[0-9a-f]{32}$/.test(paired.token))
    throw createError({ statusCode: 502, message: 'Неожиданный ответ сопряжения' })
  const key = paired.token
  const c = capabilities(await request(ip, '/install/session', 'GET', key))
  if (!c.ready) throw createError({ statusCode: 503, message: `API установки недоступен (${c.errorHex})` })
  const data = settings(); data[ip] = key
  mkdirSync(dirname(settingsPath), { recursive: true })
  const tmp = `${settingsPath}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 }); chmodSync(tmp, 0o600)
    // Windows antivirus may hold the old file briefly. Keep the previous
    // credentials intact if replacement fails; do not truncate the target.
    for (let attempt = 0; ; attempt++) {
      try { renameSync(tmp, settingsPath); break } catch (error: any) {
        if (attempt >= 7 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(error?.code)) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * (attempt + 1))
      }
    }
  } catch {
    throw createError({ statusCode: 500, message: 'WEB не смог сохранить подключение. Откройте запускатель PS4 для нового кода и повторите сопряжение' })
  } finally { rmSync(tmp, { force: true }) }
  // The saved key is never returned to the browser or printed to the event log.
  return { ready: true, configured: true, contentTypes: c.contentTypes, message: 'PS4 сопряжена с WEB; повторный ввод кода не требуется' }
}
export interface ServiceInstallInput { requestId: string; contentId: string; titleId: string; title: string; url: string; contentType: string; size: number }
function job(value: unknown, id: string): ServiceInstallJob {
  if (!validServiceJob(value) || value.requestId !== id) throw createError({ statusCode: 502, message: 'Сервис вернул неожиданный идентификатор или состояние задания' })
  return value
}
function jobPath(id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw createError({ statusCode: 400, message: 'Неверный идентификатор задания' })
  return `/install/jobs/${id}`
}
export async function submitServicePackage(ip: string, input: ServiceInstallInput) {
  jobPath(input.requestId)
  return job(await request(ip, '/install/jobs', 'POST', token(consoleIp(ip)), input), input.requestId)
}
export async function submitServiceUpdate(ip: string, input: ServiceInstallInput) {
  jobPath(input.requestId)
  if (input.titleId !== 'PFLS00001' || input.contentId !== 'IV0000-PFLS00001_00-PACKAGEFLOWSRV00') throw new Error('Unexpected update package')
  return job(await request(ip, '/install/service-update', 'POST', token(consoleIp(ip)), input), input.requestId)
}
export async function getServiceInstallJob(ip: string, id: string) {
  return job(await request(ip, jobPath(id), 'GET', token(consoleIp(ip))), id)
}
export async function cancelServiceInstallJob(ip: string, id: string) {
  return job(await request(ip, `${jobPath(id)}/cancel`, 'POST', token(consoleIp(ip))), id)
}
