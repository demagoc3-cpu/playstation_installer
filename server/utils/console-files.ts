import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { dirname, resolve, posix } from 'node:path'
import { createError } from 'h3'
import { consoleFilePath, consoleFileRead, consoleFileRequest, consoleFileWrite } from './ps4-service-installer'
import { ps4ServiceIp } from './ps4-service'
import { logEvent } from './event-log'
import type { ConsoleFileJob, ConsoleFileStat, ConsoleTrashItem, FileAction } from '../../shared/types/console-files'

const root = resolve(process.cwd(), '.data/console-files')
const active = new Set<string>()
const pauseRequests = new Set<string>()
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const textLimit = 128 * 1024
interface Step { kind: 'mkdir' | 'move' | 'copy' | 'replace' | 'delete'; path?: string; destination: string; revision?: string; identity?: string; directory?: boolean; purgeId?: string; targetRevision?: string; size?: number; uploadId: string; done?: boolean; resultRevision?: string; text?: string; attempted?: boolean; trash?: ConsoleTrashItem }
interface StoredJob extends ConsoleFileJob { steps: Step[]; planned: boolean; input: { paths: string[]; destination?: string; name?: string; revision?: string; trashId?: string; trashIds?: string[] } }
export function fileIp(value: unknown) { const ip = ps4ServiceIp(value); if (!ip) throw createError({ statusCode: 400, message: 'Укажите адрес PS4' }); return ip }
function fail(message: string, statusCode = 400): never { throw createError({ statusCode, message }) }
export function userFilePath(value: unknown, write = false) {
  const path = consoleFilePath(value)
  if (path.split('/').some(p => p.includes('.pfs-') || p.includes('.packageflow-'))) fail('Служебные файлы передачи и корзины защищены', 403)
  if (write) {
    if (!/^\/(?:data\/|mnt\/usb[0-7]\/)/.test(path)) fail('Изменения доступны только внутри /data и USB', 403)
    if (path.split('/').some(p => ['PackegeFlowService', 'PackageFlowService'].includes(p))) fail('Файлы службы защищены от изменения', 403)
  }
  return path
}
export function fileName(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value === '.' || value === '..' || /[\/\\\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > 200 || value.includes('.pfs-') || value.includes('.packageflow-') || ['web-key', 'PackegeFlowService', 'PackageFlowService'].includes(value)) fail('Недопустимое имя файла или папки')
  return value
}
function ledgerPath(ip: string) { return resolve(root, `${ip}.json`) }
function readLedger(ip: string): { jobs: StoredJob[]; trash: ConsoleTrashItem[] } {
  try {
    const data = JSON.parse(readFileSync(ledgerPath(ip), 'utf8'))
    if (data.version !== 1 || !Array.isArray(data.jobs) || !Array.isArray(data.trash) || !data.jobs.every((j: any) => j?.ip === ip && uuid.test(j.id) && Array.isArray(j.steps) && Array.isArray(j.paths) && j.input && ['planning', 'running', 'paused', 'completed', 'failed'].includes(j.state)) || !data.trash.every((t: any) => t?.ip === ip && uuid.test(t.id) && typeof t.original === 'string' && typeof t.stored === 'string')) throw new Error('invalid')
    return data
  } catch (cause: any) { if (cause.code === 'ENOENT') return { jobs: [], trash: [] }; fail('Не удалось прочитать журнал файловых операций', 503) }
}
function persist(ip: string, ledger: ReturnType<typeof readLedger>) {
  mkdirSync(root, { recursive: true })
  const file = ledgerPath(ip), temporary = `${file}.tmp`
  const fd = openSync(temporary, 'w', 0o600)
  try { writeFileSync(fd, JSON.stringify({ version: 1, ...ledger })); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, file)
}
function publicJob(job: StoredJob): ConsoleFileJob { const { steps, input, planned, ...result } = job; return result }
export function fileJobs(value: unknown) {
  const ip = fileIp(value), ledger = readLedger(ip)
  // A WEB restart does not repeat mutations automatically. Resume uses recorded receipts.
  let changed = false
  for (const job of ledger.jobs) if (['planning', 'running'].includes(job.state) && !active.has(job.id)) { job.state = 'paused'; job.error = 'WEB был перезапущен. Можно продолжить прежнюю операцию'; changed = true }
  if (changed) persist(ip, ledger)
  return { jobs: ledger.jobs.map(publicJob).reverse(), trash: ledger.trash.filter(t => !t.restored && !t.purged).reverse() }
}
export async function fileCapabilities(ip: string) {
  try { return await consoleFileRequest(ip, 'capabilities', {}) } catch (cause: any) {
    if (cause.statusCode === 404) return { fileApi: 1, textLimit, trash: false }
    throw cause
  }
}
async function stat(ip: string, path: string): Promise<ConsoleFileStat> {
  const s = await consoleFileRequest(ip, 'stat', { path }) as ConsoleFileStat
  if (!s || !['file', 'directory', 'link'].includes(s.type) || !Number.isSafeInteger(s.size) || s.size < 0 || !/^[0-9a-f]{16}$/.test(s.revision)) fail('Обновите PackageFlowService до PKG 1.52', 409)
  return s
}
async function maybeStat(ip: string, path: string) { try { return await stat(ip, path) } catch (cause: any) { if (cause.statusCode === 404) return null; throw cause } }
function volume(path: string) { return path.startsWith('/data/') ? '/data' : /^\/mnt\/usb[0-7](?=\/)/.exec(path)?.[0] || '' }
function trashItem(ip: string, path: string, reason: ConsoleTrashItem['reason']): ConsoleTrashItem {
  const id = randomUUID(); return { id, ip, original: path, stored: `${volume(path)}/.packageflow-trash/${id}`, createdAt: new Date().toISOString(), reason }
}
function step(kind: Step['kind'], destination: string, extra: Partial<Step> = {}): Step { return { kind, destination, uploadId: randomUUID(), ...extra } }
async function enumerate(ip: string, source: string, destination: string, steps: Step[], depth = 0) {
  if (steps.length >= 10000 || depth > 32) fail('Слишком большая или глубокая папка: выберите её части отдельно')
  const s = await stat(ip, source)
  if (s.type === 'link') fail('Символические ссылки не копируются')
  if (s.type === 'file') { steps.push(step('copy', destination, { path: source, revision: s.revision, size: s.size })); return }
  steps.push(step('mkdir', destination))
  let offset = 0
  do {
    const listing = await consoleFileRequest(ip, 'list', { path: source, offset }) as { entries: { name: string; type: string }[]; nextOffset: number; hasMore: boolean }
    if ((listing as any).restricted) fail('Папка содержит защищённые файлы или незавершённые передачи. Выберите другое содержимое', 403)
    for (const entry of listing.entries) { fileName(entry.name); await enumerate(ip, `${source}/${entry.name}`, `${destination}/${entry.name}`, steps, depth + 1) }
    if (!listing.hasMore) break
    if (!Number.isSafeInteger(listing.nextOffset) || listing.nextOffset <= offset) fail('PS4 вернула неверную страницу папки', 502)
    offset = listing.nextOffset
  } while (true)
  if ((await stat(ip, source)).revision !== s.revision) fail('Состав исходной папки изменился. Повторите выбор', 409)
}
function checkedTrashPath(ip: string, item: ConsoleTrashItem) {
  const original = userFilePath(item.original, true)
  if (item.ip !== ip || !uuid.test(item.id) || ![`${volume(original)}/.packageflow-trash/${item.id}`, `${original}.packageflow-backup-${item.id}`].includes(item.stored)) fail('Неверный путь копии в корзине', 403)
  return item.stored
}
async function enumerateDelete(ip: string, path: string, steps: Step[], depth = 0) {
  if (steps.length >= 10000 || depth > 32) fail('Слишком большая или глубокая папка: выберите её части отдельно')
  const s = await stat(ip, path)
  if (!s.writable || s.type === 'link') fail('Путь защищён от удаления или содержит ссылку', 403)
  if (!/^[0-9a-f]{16}$/.test(s.identity || '')) fail('Для удаления обновите PackageFlowService до PKG 1.55', 409)
  if (s.type === 'directory') {
    let offset = 0
    do {
      const listing = await consoleFileRequest(ip, 'list', { path, offset }) as { entries: { name: string }[]; nextOffset: number; hasMore: boolean; restricted?: boolean }
      if (listing.restricted) fail('Папка содержит защищённые файлы или незавершённые передачи. Удаление не начато', 403)
      for (const e of listing.entries) { fileName(e.name); await enumerateDelete(ip, `${path}/${e.name}`, steps, depth + 1) }
      if (!listing.hasMore) break
      if (!Number.isSafeInteger(listing.nextOffset) || listing.nextOffset <= offset) fail('PS4 вернула неверную страницу папки', 502)
      offset = listing.nextOffset
    } while (true)
    if ((await stat(ip, path)).revision !== s.revision) fail('Состав папки изменился. Повторите выбор', 409)
  }
  if (steps.length >= 10000) fail('Слишком много элементов для одной операции')
  steps.push(step('delete', path, { path, revision: s.revision, identity: s.identity, directory: s.type === 'directory' }))
}
async function plan(job: StoredJob, ledger: ReturnType<typeof readLedger>) {
  const { ip, action, input } = job
  const steps: Step[] = []
  if (action === 'mkdir') steps.push(step('mkdir', userFilePath(`${input.paths[0] === '/' ? '' : input.paths[0]}/${fileName(input.name)}`, true)))
  else if (action === 'delete') {
    for (const path of input.paths) await enumerateDelete(ip, userFilePath(path, true), steps)
  } else if (action === 'purge') {
    for (const id of input.trashIds!) {
      const item = ledger.trash.find(t => t.id === id && !t.restored && !t.purged)
      if (!item || item.purging) fail('Копия недоступна или её удаление уже начато. Проверьте историю операций', 409)
      const path = checkedTrashPath(ip, item)
      await enumerateDelete(ip, path, steps)
      steps.at(-1)!.purgeId = id
    }
    job.paths = input.trashIds!.map(id => ledger.trash.find(t => t.id === id)!.original)
  } else if (action === 'restore') {
    const t = ledger.trash.find(t => t.id === input.trashId && !t.restored && !t.purged)
    if (!t) fail('Копия уже возвращена или не найдена', 404)
    if (t.purging) fail('Удаление этой копии уже начато. Продолжите его в истории операций; частично удалённая копия не восстанавливается', 409)
    const s = await stat(ip, checkedTrashPath(ip, t))
    if (await maybeStat(ip, t.original)) fail('Исходное имя занято. Сначала переименуйте существующий файл', 409)
    steps.push(step('move', t.original, { path: t.stored, revision: s.revision }))
  } else if (action === 'replace') {
    const source = input.paths[0]!, target = userFilePath(input.destination, true)
    const current = await stat(ip, target), staged = await stat(ip, source)
    if (current.type !== 'file' || staged.type !== 'file' || current.revision !== input.revision) fail('Файл изменился после открытия. Замена остановлена', 409)
    const id = randomUUID()
    steps.push(step('replace', target, { path: source, revision: staged.revision, targetRevision: current.revision, size: staged.size, uploadId: id,
      trash: { id, ip, original: target, stored: `${target}.packageflow-backup-${id}`, createdAt: new Date().toISOString(), reason: 'replaced' } }))
  } else {
    for (const source of input.paths) {
      const s = await stat(ip, source)
      if (s.type === 'link') fail('Операции с символическими ссылками не поддерживаются')
      if (['rename', 'move', 'trash'].includes(action) && !s.writable) fail('Исходный путь защищён от изменения', 403)
      if (action === 'trash') {
        const t = trashItem(ip, source, 'deleted')
        const folder = `${volume(source)}/.packageflow-trash`
        if (!steps.some(x => x.destination === folder) && !(await maybeStat(ip, folder))) steps.push(step('mkdir', folder))
        steps.push(step('move', t.stored, { path: source, revision: s.revision, trash: t })); continue
      }
      const dest = userFilePath(action === 'rename' ? `${posix.dirname(source)}/${fileName(input.name)}` : `${input.destination}/${posix.basename(source)}`, true)
      if (dest === source || dest.startsWith(source + '/')) fail('Нельзя поместить папку внутрь самой себя')
      if (await maybeStat(ip, dest)) fail(`Имя уже занято: ${posix.basename(dest)}. Выберите другую папку или переименуйте файл`, 409)
      if (action === 'rename' || (action === 'move' && volume(source) === volume(dest))) steps.push(step('move', dest, { path: source, revision: s.revision }))
      else {
        await enumerate(ip, source, dest, steps)
        if (action === 'move') {
          const t = trashItem(ip, source, 'moved'), folder = `${volume(source)}/.packageflow-trash`
          if (!steps.some(x => x.destination === folder) && !(await maybeStat(ip, folder))) steps.push(step('mkdir', folder))
          steps.push(step('move', t.stored, { path: source, revision: s.revision, trash: t }))
        }
      }
    }
  }
  job.steps = steps; job.total = steps.length; job.totalBytes = steps.filter(s => s.kind === 'copy' || s.kind === 'replace').reduce((n, s) => n + (s.size || 0), 0); job.planned = true
  if (action === 'purge') for (const id of input.trashIds!) ledger.trash.find(t => t.id === id)!.purging = job.id
  persist(ip, ledger)
}
function issue(cause: any) { return cause?.data?.message || cause?.message || 'Нет ответа от PS4' }
async function execute(job: StoredJob, ledger: ReturnType<typeof readLedger>) {
  active.add(job.id); pauseRequests.delete(job.id)
  const checkPause = () => { if (pauseRequests.has(job.id)) fail('Операция приостановлена. Можно продолжить с прежнего места', 503) }
  try {
    if (!job.planned) { job.state = 'planning'; persist(job.ip, ledger); await plan(job, ledger) }
    if (job.action === 'purge') for (const s of job.steps.filter(s => s.purgeId && !s.done)) {
      const item = ledger.trash.find(t => t.id === s.purgeId)
      if (!item || item.restored || item.purged || (item.purging && item.purging !== job.id)) fail('Копия уже возвращена или удаляется другим заданием', 409)
      item.purging = job.id
    }
    job.state = 'running'; job.error = ''; persist(job.ip, ledger)
    for (const s of job.steps) {
      checkPause()
      if (s.done) continue
      job.current = s.path || s.destination; persist(job.ip, ledger)
      const target = await maybeStat(job.ip, s.destination)
      if (s.kind === 'delete') {
        if (!target) { if (!s.attempted) fail('Элемент исчез до удаления. Проверьте папку', 409) }
        else {
          if (target.identity !== s.identity || (!s.directory && target.revision !== s.revision)) fail('Элемент изменился после проверки. Удаление остановлено', 409)
          s.attempted = true; persist(job.ip, ledger)
          await consoleFileRequest(job.ip, 'delete', { path: s.path, revision: target.revision, identity: s.identity })
        }
        if (s.purgeId) { const t = ledger.trash.find(t => t.id === s.purgeId)!; t.purged = true; delete t.purging }
      } else if (s.kind === 'mkdir') {
        // On resume, an empty planned directory may have been created before the response was lost.
        if (target && (!s.attempted || target.type !== 'directory')) fail('Имя папки занято файлом', 409)
        if (!target) { s.attempted = true; persist(job.ip, ledger); await consoleFileRequest(job.ip, 'mkdir', { path: s.destination }) }
      } else {
        const source = await maybeStat(job.ip, s.path!)
        if (s.kind === 'move') {
          if (!source) { if (!target || target.revision !== s.revision) fail('Результат перемещения неизвестен. Проверьте оба пути', 409) }
          else {
            if (source.revision !== s.revision || target) fail('Файл изменился или имя назначения занято', 409)
            await consoleFileRequest(job.ip, 'move', { path: s.path, destination: s.destination, revision: s.revision })
          }
        } else if (s.kind === 'replace') {
          if (!source) {
            if (!target || target.revision !== s.revision || !(await maybeStat(job.ip, s.trash!.stored))) fail('Результат замены неизвестен. Проверьте копию в корзине', 409)
          } else {
            if (source.revision !== s.revision) fail('Подготовленный файл изменился', 409)
            const backup = await maybeStat(job.ip, s.trash!.stored)
            if (!target && backup?.revision === s.targetRevision) {
              await consoleFileRequest(job.ip, 'move', { path: s.path, destination: s.destination, revision: s.revision })
            } else {
              if (target?.revision !== s.targetRevision) fail('Файл изменился. Замена остановлена', 409)
              await consoleFileRequest(job.ip, 'replace', { path: s.path, destination: s.destination, revision: s.targetRevision, id: s.uploadId })
            }
          }
          job.bytes += s.size || 0
        } else {
          if (!source || source.revision !== s.revision) fail('Исходный файл изменился. Копирование остановлено', 409)
          if (target) {
            if (target.revision !== s.resultRevision) fail('Имя назначения занято. Существующий файл не заменён', 409)
          } else {
            // Staging keeps incomplete copies out of the final destination and enables chunk resume.
            const staging = `${s.destination}.packageflow-stage-${s.uploadId}`
            let ready = await maybeStat(job.ip, staging)
            if (ready && (ready.type !== 'file' || ready.size !== s.size)) fail('Незавершённая копия не совпадает с источником', 409)
            if (!ready) {
              const session = await consoleFileRequest(job.ip, 'upload/start', { path: staging, id: s.uploadId, size: s.size }) as { offset: number }
              if (!Number.isSafeInteger(session.offset) || session.offset < 0 || session.offset > s.size!) fail('Неверная позиция копирования', 502)
              let offset = session.offset
              while (offset < s.size!) {
                checkPause()
                const chunk = await consoleFileRead(job.ip, s.path!, offset, Math.min(256 * 1024, s.size! - offset))
                if (!chunk.length) fail('Исходный файл изменился', 409)
                await consoleFileWrite(job.ip, s.uploadId, offset, chunk); offset += chunk.length
                job.bytes = job.steps.filter(x => x.done && ['copy', 'replace'].includes(x.kind)).reduce((n, x) => n + (x.size || 0), 0) + offset
                persist(job.ip, ledger)
              }
              if ((await stat(job.ip, s.path!)).revision !== s.revision) fail('Исходный файл изменился во время копирования', 409)
              await consoleFileRequest(job.ip, 'upload/finish', { id: s.uploadId })
              ready = await stat(job.ip, staging)
            }
            s.resultRevision = ready.revision; persist(job.ip, ledger)
            await consoleFileRequest(job.ip, 'move', { path: staging, destination: s.destination, revision: ready.revision })
          }
        }
      }
      s.done = true; job.done++
      if (s.trash && !ledger.trash.some(t => t.id === s.trash!.id)) ledger.trash.push(s.trash)
      persist(job.ip, ledger)
    }
    if (job.action === 'restore') { const t = ledger.trash.find(t => t.id === job.input.trashId); if (t) t.restored = true }
    job.state = 'completed'; job.current = ''; job.bytes = job.totalBytes; persist(job.ip, ledger)
    logEvent('info', `Файлы PS4 ${job.ip}: ${job.action}, завершено ${job.done} операций`)
  } catch (cause: any) {
    // Preserve a previous version even if the connection failed between native renames.
    for (const s of job.steps.filter(s => s.kind === 'replace' && s.trash)) {
      try { if ((await maybeStat(job.ip, s.trash!.stored))?.revision === s.targetRevision && !ledger.trash.some(t => t.id === s.trash!.id)) ledger.trash.push(s.trash!) } catch {}
    }
    if (job.action === 'purge' && !job.steps.some(s => s.attempted)) for (const t of ledger.trash.filter(t => t.purging === job.id)) delete t.purging
    job.state = pauseRequests.has(job.id) || (['copy', 'move', 'delete', 'purge'].includes(job.action) && (!cause.statusCode || cause.statusCode >= 500)) ? 'paused' : 'failed'
    job.error = issue(cause); persist(job.ip, ledger)
    logEvent('warn', `Файлы PS4 ${job.ip}: ${job.error}`)
  } finally { active.delete(job.id); pauseRequests.delete(job.id) }
}
function launch(job: StoredJob, ledger: ReturnType<typeof readLedger>) {
  void execute(job, ledger).catch(cause => logEvent('error', `Не удалось сохранить состояние файловой операции ${job.id}: ${issue(cause)}`))
}
function pruneJobs(ledger: ReturnType<typeof readLedger>) {
  const recent = new Set(ledger.jobs.filter(j => j.state === 'completed').slice(-100).map(j => j.id))
  ledger.jobs = ledger.jobs.filter(j => j.state !== 'completed' || recent.has(j.id))
  if (ledger.jobs.length >= 500) fail('Слишком много незавершённых операций. Сначала проверьте предыдущие задания', 409)
}
export function startFileJob(value: unknown, body: any) {
  const ip = fileIp(value), action = body?.action as FileAction
  if (!['mkdir', 'rename', 'copy', 'move', 'trash', 'restore', 'replace', 'delete', 'purge'].includes(action)) fail('Неизвестная файловая операция')
  if (['delete', 'purge'].includes(action) && body.confirmPermanent !== true) fail('Подтвердите безвозвратное удаление', 400)
  const ledger = readLedger(ip)
  if (body.requestId !== undefined) {
    if (typeof body.requestId !== 'string' || !uuid.test(body.requestId)) fail('Неверный идентификатор операции')
    const prior = ledger.jobs.find(j => j.id === body.requestId)
    if (prior) {
      if (prior.action !== action || JSON.stringify(prior.input.paths) !== JSON.stringify(body.paths) || prior.input.destination !== body.destination || prior.input.name !== body.name) fail('Идентификатор уже используется другой операцией', 409)
      return publicJob(prior)
    }
  }
  if (ledger.jobs.some(j => active.has(j.id))) fail('Дождитесь текущей файловой операции', 409)
  const paths: string[] = ['restore', 'purge'].includes(action) ? [] : Array.isArray(body.paths) && body.paths.length && body.paths.length <= 100 ? [...new Set<string>(body.paths.map((p: unknown) => userFilePath(p, !['copy', 'mkdir'].includes(action))))] : fail('Выберите от 1 до 100 элементов')
  const trashIds: string[] | undefined = action === 'purge' ? Array.isArray(body.trashIds) && body.trashIds.length && body.trashIds.length <= 1000 && body.trashIds.every((id: unknown) => typeof id === 'string' && uuid.test(id)) ? [...new Set<string>(body.trashIds)] : fail('Выберите элементы корзины') : undefined
  if (trashIds?.some(id => !ledger.trash.some(t => t.id === id && !t.restored && !t.purged && !t.purging))) fail('Выбранная копия недоступна для удаления', 409)
  if (paths.some((p, i) => paths.some((q, j) => i !== j && p.startsWith(q + '/')))) fail('Выберите папку целиком или её содержимое, не оба одновременно')
  if (['rename', 'replace', 'mkdir'].includes(action) && paths.length !== 1) fail('Выберите один элемент')
  pruneJobs(ledger)
  const destination = ['copy', 'move', 'replace'].includes(action) ? consoleFilePath(body.destination) : undefined
  if (action === 'replace') fail('Используйте подтверждённую замену загружаемого файла')
  if (['copy', 'move'].includes(action)) userFilePath(`${destination}/placeholder`, true)
  if (action === 'restore' && !uuid.test(body.trashId || '')) fail('Выберите копию из корзины')
  const job: StoredJob = { id: body.requestId || randomUUID(), ip, action, state: 'planning', paths, destination, current: '', done: 0, total: 0, bytes: 0, totalBytes: 0, error: '', createdAt: new Date().toISOString(), steps: [], planned: false,
    input: { paths, destination, ...(['mkdir', 'rename'].includes(action) ? { name: fileName(body.name) } : {}), ...(action === 'replace' ? { revision: String(body.revision || '') } : {}), ...(action === 'restore' ? { trashId: body.trashId } : {}), ...(trashIds ? { trashIds } : {}) } }
  ledger.jobs.push(job); persist(ip, ledger)
  launch(job, ledger)
  return publicJob(job)
}
export function pauseFileJob(value: unknown, id: unknown) {
  const ip = fileIp(value), ledger = readLedger(ip), job = ledger.jobs.find(j => j.id === id)
  if (!job) fail('Задание не найдено', 404)
  if (active.has(job.id)) pauseRequests.add(job.id)
  return publicJob(job)
}
export function resumeFileJob(value: unknown, id: unknown) {
  const ip = fileIp(value)
  if (typeof id !== 'string' || !uuid.test(id)) fail('Неверное задание')
  const ledger = readLedger(ip), job = ledger.jobs.find(j => j.id === id)
  if (!job) fail('Задание не найдено', 404)
  if (ledger.jobs.some(j => active.has(j.id))) fail('Дождитесь текущей операции', 409)
  if (job.state === 'completed') return publicJob(job)
  launch(job, ledger); return publicJob(job)
}
function editable(path: string) { return /\.(?:txt|json|ini|cfg|conf|xml|ya?ml|log|csv|md)$/i.test(path) }
export async function readConsoleText(value: unknown, valuePath: unknown) {
  const ip = fileIp(value), path = userFilePath(valuePath)
  if (!editable(path)) fail('Редактор поддерживает TXT, JSON, конфигурации и другие текстовые файлы')
  const s = await stat(ip, path)
  if (s.type !== 'file' || s.size > textLimit) fail('Для редактора нужен текстовый файл размером до 128 КиБ')
  const buffer = s.size ? await consoleFileRead(ip, path, 0, s.size) : Buffer.alloc(0)
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); if (text.includes('\0')) throw new Error('binary') } catch { fail('Файл не является текстом UTF-8') }
  return { path, text, revision: s.revision, writable: s.writable, digest: createHash('sha256').update(buffer).digest('hex') }
}
export function replaceUploadedFile(value: unknown, pathValue: unknown, idValue: unknown, revision: unknown) {
  const ip = fileIp(value), path = userFilePath(pathValue, true)
  if (typeof idValue !== 'string' || !uuid.test(idValue) || typeof revision !== 'string' || !/^[0-9a-f]{16}$/.test(revision)) fail('Неверная замена файла')
  const ledger = readLedger(ip)
  const existing = ledger.jobs.find(j => j.id === idValue)
  if (existing) { if (existing.destination !== path || existing.input.revision !== revision) fail('Идентификатор уже используется', 409); return publicJob(existing) }
  if (ledger.jobs.some(j => active.has(j.id))) fail('Дождитесь текущей операции', 409)
  pruneJobs(ledger)
  const job: StoredJob = { id: idValue, ip, action: 'replace', state: 'planning', paths: [path], destination: path, current: '', done: 0, total: 1, bytes: 0, totalBytes: 0, error: '', createdAt: new Date().toISOString(), planned: false, steps: [], input: { paths: [replacementStage(path, idValue)], destination: path, revision } }
  ledger.jobs.push(job); persist(ip, ledger); launch(job, ledger); return publicJob(job)
}
export function replacementStage(path: string, id: string) { return consoleFilePath(`${path}.packageflow-upload-${id}`) }
export async function saveConsoleText(value: unknown, body: any) {
  const ip = fileIp(value), path = userFilePath(body?.path, true)
  if (body.requestId !== undefined) {
    if (typeof body.requestId !== 'string' || !uuid.test(body.requestId)) fail('Неверный идентификатор сохранения')
    const existing = readLedger(ip).jobs.find(j => j.id === body.requestId)
    if (existing) {
      if (existing.action !== 'replace' || existing.destination !== path || existing.input.revision !== body.revision) fail('Идентификатор уже используется', 409)
      return publicJob(existing)
    }
  }
  if (typeof body?.text !== 'string' || Buffer.byteLength(body.text) > textLimit || body.text.includes('\0')) fail('Текст слишком велик или содержит недопустимые символы')
  const original = await readConsoleText(ip, path)
  if (!original.writable || original.revision !== body.revision || original.digest !== body.digest) fail('Файл изменился после открытия. Перечитайте его перед сохранением', 409)
  if (original.text === body.text) return { unchanged: true }
  const id = body.requestId || randomUUID(), staging = replacementStage(path, id), data = Buffer.from(body.text)
  await consoleFileRequest(ip, 'upload/start', { path: staging, id, size: data.length })
  if (data.length) await consoleFileWrite(ip, id, 0, data)
  await consoleFileRequest(ip, 'upload/finish', { id })
  return replaceUploadedFile(ip, path, id, original.revision)
}
