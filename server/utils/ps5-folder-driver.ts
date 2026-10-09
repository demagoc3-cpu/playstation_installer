import { lstat, readdir, readFile, open } from 'node:fs/promises'
import { join } from 'node:path'
import { createBLAKE3 } from 'hash-wasm'
import { ps5SourceHash, ps5SourceStamp } from './ps5-source-hash'
import { Ps5QueueFailure, type Ps5Item } from './ps5-queue-core'

export type FolderRequest = (id: string, path: string, headers?: Record<string, string>, body?: Uint8Array, signal?: AbortSignal) => Promise<{ status: number; body: any }>
type Entry = { path: string; dir: boolean; size: number; stamp: string; id?: string; hash?: string }
export interface FolderPlan { version: 1; id: string; root: string; title: string; content: string; appVersion: string; total: number; entries: Entry[]; metadataHash: string; manifestHash: string }
const fail = (message: string): never => { throw new Ps5QueueFailure(message) }
const digest = async (bytes: Uint8Array | string) => { const h = await createBLAKE3(256); h.update(bytes); return h.digest('hex') }
const sleep = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted(); const abort = () => { clearTimeout(timer); reject(signal.reason) }
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 1000)
  signal.addEventListener('abort', abort, { once: true })
})
export function folderRelativePath(path: string) {
  return Buffer.byteLength(path) <= 768 && !/[\x00-\x1f\x7f\\:]/.test(path) && path.split('/').every(p => p && p !== '.' && p !== '..' && Buffer.byteLength(p) <= 255)
}
async function entries(root: string, signal: AbortSignal) {
  const rootStat = await lstat(root); if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('Источник Folder должен быть обычной папкой')
  const result: Entry[] = []
  async function visit(relative: string) {
    for (const name of (await readdir(join(root, relative))).sort()) {
      signal.throwIfAborted(); const path = relative ? `${relative}/${name}` : name
      if (!folderRelativePath(path)) fail('Folder содержит неподдерживаемый путь')
      const s = await lstat(join(root, path))
      if (s.isSymbolicLink() || !s.isDirectory() && !s.isFile()) fail('Ссылки и специальные файлы в Folder не поддерживаются')
      if (result.length >= 50000 || !Number.isSafeInteger(s.size)) fail('Превышен предел файлов Folder')
      result.push({ path, dir: s.isDirectory(), size: s.isDirectory() ? 0 : s.size, stamp: s.isDirectory() ? '' : ps5SourceStamp(s) })
      if (s.isDirectory()) await visit(path)
    }
  }
  await visit(''); return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}
export function folderManifest(p: FolderPlan) {
  return `PF_FOLDER1 ${p.title} ${p.content} ${p.appVersion} ${p.total} ${p.entries.length}\n` + p.entries.map(e => e.dir ? `D ${Buffer.from(e.path).toString('hex')}\n` : `F ${e.id} ${e.hash} ${e.size} ${Buffer.from(e.path).toString('hex')}\n`).join('')
}
export async function verifyFolderPlan(p: FolderPlan, item: Ps5Item, root: string) {
  if (p.version !== 1 || p.id !== item.transferId || p.root !== root || p.title !== item.titleId || p.content !== item.contentId || p.appVersion !== item.appVersion || p.total !== item.size || !Array.isArray(p.entries) || !/^[0-9a-f]{64}$/.test(p.metadataHash) || p.manifestHash !== await digest(folderManifest(p)) || item.hash && item.hash !== p.manifestHash) fail('Сохранённый план Folder не соответствует заданию')
}
export async function verifyFolderSource(p: FolderPlan, item: Ps5Item, root: string, signal: AbortSignal) {
  await verifyFolderPlan(p, item, root)
  const current = await entries(root, signal)
  if (current.length !== p.entries.length || current.some((e, i) => e.path !== p.entries[i].path || e.dir !== p.entries[i].dir || e.size !== p.entries[i].size || e.stamp !== p.entries[i].stamp)) fail('Исходная папка изменилась; передача остановлена')
}
export async function createFolderPlan(root: string, item: Ps5Item, signal: AbortSignal, progress: (bytes: number) => void): Promise<FolderPlan> {
  if (item.platform !== 'ps5' || item.order !== 0 || !/^PPSA\d{5}$/.test(item.titleId) || !/^[A-Z0-9_-]{1,63}$/.test(item.contentId || '') || !item.contentId!.includes(item.titleId) || !/^\d{2}\.\d{3}\.\d{3}$/.test(item.appVersion || '') || !/^[0-9a-f]{32}$/.test(item.transferId)) fail('Не удалось определить метаданные Folder')
  const list = await entries(root, signal), total = list.reduce((n, e) => n + e.size, 0)
  if (!Number.isSafeInteger(total) || total !== item.size || !list.some(e => e.path === 'eboot.bin' && !e.dir && e.size > 0) || !list.some(e => e.path === 'sce_sys/param.json' && !e.dir && e.size > 0 && e.size <= 65536)) fail('Folder неполный или изменился. Переиндексируйте хранилище')
  const param = await readFile(join(root, 'sce_sys/param.json')); let metadata: any
  try { metadata = JSON.parse(param.toString('utf8')) } catch { fail('Некорректный param.json Folder') }
  if (metadata.titleId !== item.titleId || metadata.contentId !== item.contentId || metadata.contentVersion !== item.appVersion) fail('Метаданные Folder не соответствуют библиотеке')
  let checked = 0; progress(0)
  for (const entry of list) {
    if (entry.dir) continue
    entry.id = (await digest(`${item.transferId}/${entry.path}`)).slice(0, 32)
    const file = await open(join(root, entry.path), 'r')
    try { if (ps5SourceStamp(await file.stat()) !== entry.stamp) fail('Исходный файл изменился'); entry.hash = await ps5SourceHash(file, entry.size, entry.stamp, signal, n => progress(checked + n)) }
    finally { await file.close() }
    checked += entry.size
  }
  const p: FolderPlan = { version: 1, id: item.transferId, root, title: item.titleId, content: item.contentId!, appVersion: item.appVersion!, total, entries: list, metadataHash: await digest(param), manifestHash: '' }
  if (list.find(e => e.path === 'sce_sys/param.json')!.hash !== p.metadataHash) fail('Метаданные Folder изменились во время проверки')
  p.manifestHash = await digest(folderManifest(p)); await verifyFolderSource(p, item, root, signal); progress(total); return p
}
async function upload(id: string, size: number, hash: string, read: (buffer: Buffer, position: number) => Promise<number>, signal: AbortSignal, request: FolderRequest, progress: (bytes: number) => void, checking: () => void = () => {}) {
  let r = await request(id, '/api/v1/transfers/begin', { 'X-PackageFlow-Size': String(size), 'X-PackageFlow-Blake3': hash }, undefined, signal)
  if (r.status === 409) r = await request(id, '/api/v1/transfers/status', {}, undefined, signal)
  const valid = (r: any) => r?.id === id && r.size === size && r.blake3 === hash && r.cancelled === false && Number.isSafeInteger(r.bytesDurable) && r.bytesDurable >= 0 && r.bytesDurable <= size
  if (r.status !== 200 || !valid(r.body)) fail('PS5 не подтвердила файл Folder')
  const max = r.body.chunkMax, chunk = typeof max === 'number' && max >= 262144 && max <= 4194304 && (max & (max - 1)) === 0 ? max : 262144
  const buffer = Buffer.alloc(chunk); let offset = r.body.bytesDurable; progress(offset)
  while (offset < size) {
    signal.throwIfAborted(); const n = await read(buffer.subarray(0, Math.min(chunk, size - offset)), offset)
    if (!n) fail('Файл Folder обрезан')
    r = await request(id, '/api/v1/transfers/chunk', { 'X-PackageFlow-Offset': String(offset) }, buffer.subarray(0, n), signal)
    if (r.status !== 200 || !valid(r.body) || r.body.bytesDurable !== offset + n) throw new Error('Folder acknowledgement lost; reconcile durable offset')
    offset += n; progress(offset)
  }
  if (r.body.verified) return
  checking()
  r = await request(id, '/api/v1/transfers/commit', {}, undefined, signal)
  if (r.status === 409) throw new Error('Root worker busy')
  if (![200, 202].includes(r.status)) fail('Проверка файла Folder не началась')
  for (;;) {
    signal.throwIfAborted(); r = await request(id, '/api/v1/transfers/status', {}, undefined, signal)
    if (r.status !== 200 || !valid(r.body)) fail('Состояние файла Folder изменилось')
    if (r.body.verified) return
    const op = await request(id, '/api/v1/operations/status', {}, undefined, signal)
    if (!op.body.running) {
      if (op.body.id === id && op.body.status !== 200) fail('BLAKE3 файла Folder не совпал')
      throw new Error('Verification interrupted; retry verified transfer only')
    }
    await sleep(signal)
  }
}
export async function runFolderPlan(p: FolderPlan, item: Ps5Item, signal: AbortSignal, request: FolderRequest, save: (patch: Partial<Ps5Item>) => void): Promise<Partial<Ps5Item>> {
  await verifyFolderPlan(p, item, p.root)
  const finish = (r: any): Partial<Ps5Item> | undefined => {
    if (r.status !== 200) return
    if (r.body.id !== item.transferId || r.body.title !== p.title || r.body.proof !== 'folder-registration' || r.body.manifestHash !== p.manifestHash || r.body.metadataHash !== p.metadataHash || !['prepared', 'published', 'registered'].includes(r.body.state)) fail('Результат Folder не соответствует переданной папке')
    if (r.body.state === 'registered') return { state: 'installed', confirmation: 'service-registration', confirmedAt: Date.now(), detail: `PS5 подтвердила регистрацию Folder, версия ${p.appVersion}` }
    if (r.body.state === 'published') return { state: 'installing', detail: 'Folder передан. Ожидаем регистрацию игры на PS5' }
  }
  if (item.installDispatched) {
    const r = await request(p.id, '/api/v1/folder/status', {}, undefined, signal), done = finish(r)
    if (done) return done
    if (![200,404].includes(r.status)) throw new Error('Folder receipt unavailable')
    const op = await request(p.id, '/api/v1/operations/status', {}, undefined, signal)
    if (op.body.id === p.id && op.body.phase === 'publishing-folder' && !op.body.running && op.body.status !== 200) fail(`Служба не опубликовала Folder (${op.body.status})`)
    // Unlike an opaque Sony PKG submission, root publishes a tree bound to this
    // durable manifest ID. Retrying an absent/prepared intent cannot create a
    // second title and never replaces a foreign/existing publication.
  } else {
    await verifyFolderSource(p, item, p.root, signal)
    let sent = 0; save({ state: 'sending', progressPhase: 'transfer', detail: 'Передаём файлы Folder на PS5 с докачкой', bytesSent: 0 })
    for (const e of p.entries) {
      if (e.dir || e.size === 0) continue
      save({ state: 'sending', progressPhase: 'transfer', detail: 'Передаём файлы Folder на PS5 с докачкой' })
      const f = await open(join(p.root, e.path), 'r')
      try {
        if (ps5SourceStamp(await f.stat()) !== e.stamp) fail('Файл Folder изменился')
        await upload(e.id!, e.size, e.hash!, async (buffer, position) => {
          const result = await f.read(buffer, 0, buffer.length, position)
          if (ps5SourceStamp(await f.stat()) !== e.stamp) fail('Файл Folder изменился во время передачи')
          return result.bytesRead
        }, signal, request, n => save({ bytesSent: sent + n }), () => save({ state: 'verifying', progressPhase: 'device-check', detail: 'PS5 проверяет переданный файл Folder' }))
      } finally { await f.close() }
      sent += e.size
    }
    await verifyFolderSource(p, item, p.root, signal)
    const manifest = Buffer.from(folderManifest(p))
    if (manifest.length > 16 * 1024 * 1024) fail('Слишком большой список файлов Folder')
    save({ state: 'verifying', progressPhase: 'device-check', bytesSent: p.total, detail: 'PS5 проверяет комплект файлов Folder' })
    await upload(p.id, manifest.length, p.manifestHash, async (buffer, position) => { const n = Math.min(buffer.length, manifest.length - position); manifest.copy(buffer, 0, position, position + n); return n }, signal, request, () => {})
    signal.throwIfAborted(); save({ state: 'installing', installDispatched: true, detail: 'Регистрируем проверенную папку на PS5' })
  }
  const r = await request(p.id, '/api/v1/folder/commit', {}, undefined, signal)
  if (r.status === 409) {
    const op = await request(p.id, '/api/v1/operations/status', {}, undefined, signal)
    if (!op.body.running) fail('На PS5 уже существует другая папка с этим Title ID')
    return { state: 'installing', detail: 'Служба завершает публикацию Folder' }
  }
  if (![200,202].includes(r.status)) throw new Error('Folder publication reply lost; read receipt')
  return { state: 'installing', detail: 'Ожидаем регистрацию Folder на PS5' }
}
export async function cancelFolderPlan(p: FolderPlan | undefined, item: Ps5Item, request: FolderRequest) {
  if (item.installDispatched) fail('Folder уже передан для регистрации')
  if (p) await verifyFolderPlan(p, item, p.root)
  for (const id of [...(p?.entries.filter(e => !e.dir && e.size).map(e => e.id!) || []), item.transferId]) {
    const r = await request(id, '/api/v1/transfers/cancel')
    if ([200,404].includes(r.status)) continue
    if (r.status === 409) { const s = await request(id, '/api/v1/transfers/status'); if (s.status === 200 && s.body.id === id && s.body.verified === true) continue }
    throw new Error('Folder cancellation not confirmed')
  }
}
