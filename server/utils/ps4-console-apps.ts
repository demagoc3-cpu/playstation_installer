import { createError } from 'h3'
import { ps4ServiceIp } from './ps4-service'
import { authenticatedServiceRequest } from './ps4-service-installer'
import { assertNoInstallation, assertNoRemoval, readRemovals, saveRemovals, type StoredRemoval } from './console-operation-store'
import { clearConsoleInstallation } from './package-library'
import { forgetQueuedPackage } from './installation-queue'
import { logEvent } from './event-log'
import type { ConsoleApp, ConsoleCatalog, ConsoleComponent, ConsoleDetails, RemoveInput, RemoveOperation } from '../../shared/types/console-apps'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const titleId = /^[A-Z0-9]{9}$/
const revision = /^[0-9a-f]{16}$/
const kinds = ['game', 'patch', 'dlc', 'dlcs']
const submitting = new Set<string>()
function invalid(): never { throw createError({ statusCode: 502, message: 'Неожиданный ответ списка приложений PS4' }) }
function ipAddress(value: unknown) { const ip = ps4ServiceIp(value); if (!ip) throw createError({ statusCode: 400, message: 'Укажите IPv4-адрес PS4' }); return ip }
function text(value: unknown, max: number) { return typeof value === 'string' && value.length <= max }
function app(v: any): ConsoleApp {
  if (!v || !titleId.test(v.titleId) || !text(v.title, 128) || !text(v.version, 16) || typeof v.installed !== 'boolean' || typeof v.protected !== 'boolean') invalid()
  return v
}
function component(v: any): ConsoleComponent {
  if (!v || !['base', 'patch', 'dlc'].includes(v.kind) || !text(v.title, 128) || !text(v.version, 16) || !text(v.contentId, 36) ||
    !Number.isSafeInteger(v.sizeBytes) || v.sizeBytes < 0 || !['internal', 'external', 'mixed'].includes(v.storage) || typeof v.canRemove !== 'boolean' ||
    (v.kind === 'base' ? v.id !== 'base' : v.kind === 'patch' ? v.id !== 'patch' : !/^[A-Z0-9_]{16}$/.test(v.id))) invalid()
  return v
}
function page(v: any, offset: number, limit: number) {
  if (!v || v.service !== 'PackegeFlowService' || !revision.test(v.revision) || typeof v.complete !== 'boolean' ||
    !Number.isInteger(v.total) || v.total < offset || v.total > limit || (v.next !== null && (!Number.isInteger(v.next) || v.next !== offset + 8 || v.next >= v.total))) invalid()
  return v
}
async function readConsole(ip: string, path: string) {
  try { return await authenticatedServiceRequest(ip, path, 'GET') as any } catch (error: any) {
    if (error?.statusCode === 404) throw createError({ statusCode: 409, message: 'Для раздела «На консоли» установите PackegeFlowService PKG 1.18' })
    throw error
  }
}
export async function getConsoleCatalog(value: unknown): Promise<ConsoleCatalog> {
  const ip = ipAddress(value); let offset = 0; let snapshot = ''; let complete = true; const apps: ConsoleApp[] = []
  for (;;) {
    const v = page(await readConsole(ip, `/apps/list?offset=${offset}${offset ? `&revision=${snapshot}` : ''}`), offset, 512)
    if (v.appsApi !== 1 || !Array.isArray(v.apps) || v.apps.length !== Math.min(8, v.total - offset) || (offset && v.revision !== snapshot)) invalid()
    snapshot = v.revision; complete &&= v.complete; apps.push(...v.apps.map(app))
    if (v.next === null) break; offset = v.next
  }
  if (new Set(apps.map(a => a.titleId)).size !== apps.length) invalid()
  return { apps, complete, revision: snapshot }
}
export async function getConsoleDetails(value: unknown, id: unknown): Promise<ConsoleDetails> {
  const ip = ipAddress(value); if (typeof id !== 'string' || !titleId.test(id)) throw createError({ statusCode: 400, message: 'Неверный TITLE_ID' })
  let offset = 0; let result: ConsoleDetails | undefined
  for (;;) {
    const v = page(await readConsole(ip, `/apps/title/${id}?offset=${offset}${offset ? `&revision=${result!.revision}` : ''}`), offset, 130)
    const a = app(v.app)
    if (a.titleId !== id || !Array.isArray(v.components) || v.components.length !== Math.min(8, v.total - offset) || (result && result.revision !== v.revision)) invalid()
    result ??= { app: a, complete: v.complete, revision: v.revision, components: [] }
    result.complete &&= v.complete; result.components.push(...v.components.map(component))
    if (v.next === null) break; offset = v.next
  }
  if (new Set(result.components.map(c => `${c.kind}/${c.id}`)).size !== result.components.length) invalid()
  return result
}
export function validateRemoval(value: unknown): RemoveInput {
  const v = value as RemoveInput
  if (!v || !uuid.test(v.requestId) || !titleId.test(v.titleId) || !kinds.includes(v.kind) || !revision.test(v.revision) || v.confirmTitleId !== v.titleId ||
    (v.kind === 'game' || v.kind === 'dlcs' ? v.componentId !== 'all' : v.kind === 'patch' ? v.componentId !== 'patch' : !/^[A-Z0-9_]{16}$/.test(v.componentId)))
    throw createError({ statusCode: 400, message: 'Проверьте выбранный компонент и введите TITLE_ID игры для подтверждения' })
  return { requestId: v.requestId, titleId: v.titleId, kind: v.kind, componentId: v.componentId, revision: v.revision, confirmTitleId: v.confirmTitleId }
}
export function validateRemoveResult(value: any, input: RemoveInput): RemoveOperation {
  if (!value || value.service !== 'PackegeFlowService' || value.requestId !== input.requestId || value.titleId !== input.titleId || value.kind !== input.kind || value.componentId !== input.componentId ||
    !['queued', 'running', 'verifying', 'removed', 'failed', 'partial', 'uncertain'].includes(value.state) || !Number.isInteger(value.completed) || !Number.isInteger(value.total) || value.total < 0 || value.total > 130 || value.completed < 0 || value.completed > value.total ||
    !Number.isInteger(value.error) || !Number.isInteger(value.pollError) || !/^0x[0-9A-F]{8}$/.test(value.errorHex) || (value.state === 'removed' && (!value.total || value.completed !== value.total || value.error))) invalid()
  const { requestId, titleId, kind, componentId, state, completed, total, error, errorHex, pollError } = value
  return { requestId, titleId, kind, componentId, state, completed, total, error, errorHex, pollError }
}
function publicResult(r: StoredRemoval): RemoveOperation { return { ...r.result, pending: r.pending } }
function updateStored(r: StoredRemoval) {
  const all = readRemovals(); const index = all.findIndex(x => x.input.requestId === r.input.requestId && x.ip === r.ip)
  if (index < 0) throw new Error('Removal ledger entry disappeared')
  if (r.result.state === 'removed' && !r.libraryUpdated) {
    for (const id of clearConsoleInstallation(r.input.titleId, r.input.kind, r.input.componentId)) forgetQueuedPackage(id)
    r.libraryUpdated = true
    logEvent('info', `PS4 подтвердила удаление ${r.input.titleId}: ${r.input.kind} / ${r.input.componentId}`)
  }
  all[index] = r; saveRemovals(all)
}
export async function getConsoleRemoval(value: unknown): Promise<RemoveOperation | null> {
  const ip = ipAddress(value); const r = readRemovals().filter(x => x.ip === ip).at(-1)
  if (!r) return null
  if (submitting.has(`${ip}/${r.input.requestId}`)) return publicResult(r)
  if (!r.pending && ['removed', 'failed', 'partial'].includes(r.result.state)) { updateStored(r); return publicResult(r) }
  try {
    r.result = validateRemoveResult(await authenticatedServiceRequest(ip, `/apps/operations/${r.input.requestId}`, 'GET'), r.input); r.pending = false
  } catch (error: any) {
    r.result.message = error?.statusCode === 404 ? 'PS4 не нашла задание. Проверьте состав игры перед новой операцией; повторная команда не отправлена' : 'Не удалось получить результат от PS4. Наблюдение продолжится после подключения'
    // A transport error cannot establish whether the command was accepted.
    if (error?.statusCode === 404) { r.result.state = 'uncertain'; r.pending = false }
  }
  updateStored(r); return publicResult(r)
}
export async function submitConsoleRemoval(value: unknown, body: unknown): Promise<RemoveOperation> {
  const ip = ipAddress(value); const input = validateRemoval(body); const all = readRemovals()
  const previous = all.find(x => x.ip === ip && x.input.requestId === input.requestId)
  if (previous) {
    if (JSON.stringify(previous.input) !== JSON.stringify(input)) throw createError({ statusCode: 409, message: 'Идентификатор команды уже занят' })
    return publicResult(previous) // Recovery always uses GET; never POST again.
  }
  assertNoInstallation(ip); assertNoRemoval(ip)
  if (all.length >= 256) throw createError({ statusCode: 409, message: 'История удалений WEB заполнена' })
  const r: StoredRemoval = { ip, input, createdAt: Date.now(), pending: true, result: { ...input, state: 'queued', completed: 0, total: 0, error: 0, errorHex: '0x00000000', pollError: 0 } }
  // Persist the exact command before the only POST, including across WEB restarts.
  all.push(r); saveRemovals(all); const key = `${ip}/${input.requestId}`; submitting.add(key)
  try {
    r.result = validateRemoveResult(await authenticatedServiceRequest(ip, '/apps/remove', 'POST', input), input); r.pending = false
  } catch (error: any) {
    if ([400, 401, 403, 404, 409, 503].includes(error?.statusCode)) {
      r.pending = false; r.result.state = 'failed'; r.result.error = -1; r.result.errorHex = '0xFFFFFFFF'
      r.result.message = error?.statusCode === 404 ? 'Обновите PackegeFlowService до PKG 1.18' : error.message
    } else { r.result.state = 'uncertain'; r.result.message = 'Связь прервалась. Проверяем прежнее задание, без повторной команды' }
  } finally { submitting.delete(key) }
  updateStored(r); return publicResult(r)
}
