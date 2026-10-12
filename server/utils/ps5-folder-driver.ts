import { lstat, readdir, readFile, open } from 'node:fs/promises'
import { join } from 'node:path'
import { createBLAKE3 } from 'hash-wasm'
import { ps5SourceStamp } from './ps5-source-hash'
import { Ps5SourceHashCache, cachedPs5SourceHash } from './ps5-source-hash-cache'
import { seedPs5SourceHashHistory } from './ps5-source-hash-history'
import { ps5StreamHasher } from './ps5-stream-hash'
import { ps5SendChunks } from './ps5-send-chunks'
import { Ps5QueueFailure, type Ps5Item } from './ps5-queue-core'

export type FolderRequest = (id: string, path: string, headers?: Record<string, string>, body?: Uint8Array, signal?: AbortSignal) => Promise<{ status: number; body: any }>
type Entry = { path: string; dir: boolean; size: number; stamp: string; id?: string; hash?: string }
export interface FolderPlan { version: 1 | 2; planHash?: string; id: string; root: string; title: string; content: string; appVersion: string; total: number; entries: Entry[]; metadataHash: string; manifestHash: string }
const fail = (message: string): never => { throw new Ps5QueueFailure(message) }
const digest = async (bytes: Uint8Array | string) => { const h = await createBLAKE3(256); h.update(bytes); return h.digest('hex') }
const sleep = (signal: AbortSignal, milliseconds = 1000) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted(); const abort = () => { clearTimeout(timer); reject(signal.reason) }
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
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
  return `PF_FOLDER${p.version} ${p.title} ${p.content} ${p.appVersion} ${p.total} ${p.entries.length}\n` + p.entries.map(e => e.dir ? `D ${Buffer.from(e.path).toString('hex')}\n` : `F ${e.id} ${e.hash} ${e.size} ${Buffer.from(e.path).toString('hex')}\n`).join('')
}
const structuralPlanHash = (p: FolderPlan) => digest(JSON.stringify({ id: p.id, root: p.root, title: p.title, content: p.content, appVersion: p.appVersion, total: p.total, metadataHash: p.metadataHash, entries: p.entries.map(({ path, dir, size, stamp, id }) => ({ path, dir, size, stamp, id })) }))
export async function verifyFolderPlan(p: FolderPlan, item: Ps5Item, root: string) {
  if (![1,2].includes(p.version) || p.id !== item.transferId || p.root !== root || p.title !== item.titleId || p.content !== item.contentId || p.appVersion !== item.appVersion || p.total !== item.size || !Array.isArray(p.entries) || !/^[0-9a-f]{64}$/.test(p.metadataHash)) fail('Сохранённый план Folder не соответствует заданию')
  if (p.version === 2 && p.planHash !== await structuralPlanHash(p)) fail('Сохранённый состав Folder изменился')
  if ((p.version === 1 || p.manifestHash) && (p.entries.some(e => !e.dir && !/^[0-9a-f]{64}$/.test(e.hash || '')) || p.manifestHash !== await digest(folderManifest(p)))) fail('Контрольные суммы Folder не соответствуют плану')
  if (item.hash && item.hash !== p.manifestHash) fail('Сохранённый план Folder не соответствует заданию')
}
export async function verifyFolderSource(p: FolderPlan, item: Ps5Item, root: string, signal: AbortSignal) {
  await verifyFolderPlan(p, item, root)
  const current = await entries(root, signal)
  if (current.length !== p.entries.length || current.some((e, i) => e.path !== p.entries[i].path || e.dir !== p.entries[i].dir || e.size !== p.entries[i].size || e.stamp !== p.entries[i].stamp)) fail('Исходная папка изменилась; передача остановлена')
}
export async function createFolderPlan(root: string, item: Ps5Item, signal: AbortSignal, progress: (bytes: number) => void, streaming = false): Promise<FolderPlan> {
  if (item.platform !== 'ps5' || item.order !== 0 || !/^PPSA\d{5}$/.test(item.titleId) || !/^[A-Z0-9_-]{1,63}$/.test(item.contentId || '') || !item.contentId!.includes(item.titleId) || !/^\d{2}\.\d{3}\.\d{3}$/.test(item.appVersion || '') || !/^[0-9a-f]{32}$/.test(item.transferId)) fail('Не удалось определить метаданные Folder')
  const list = await entries(root, signal), total = list.reduce((n, e) => n + e.size, 0)
  if (!Number.isSafeInteger(total) || total !== item.size || !list.some(e => e.path === 'eboot.bin' && !e.dir && e.size > 0) || !list.some(e => e.path === 'sce_sys/param.json' && !e.dir && e.size > 0 && e.size <= 65536)) fail('Folder неполный или изменился. Переиндексируйте хранилище')
  const param = await readFile(join(root, 'sce_sys/param.json')); let metadata: any
  try { metadata = JSON.parse(param.toString('utf8')) } catch { fail('Некорректный param.json Folder') }
  if (metadata.titleId !== item.titleId || metadata.contentId !== item.contentId || metadata.contentVersion !== item.appVersion) fail('Метаданные Folder не соответствуют библиотеке')
  const cache = new Ps5SourceHashCache(root)
  if (!streaming) await seedPs5SourceHashHistory(cache, signal)
  let checked = 0; progress(0)
  try {
    for (const entry of list) {
      if (entry.dir) continue
      entry.id = (await digest(`${item.transferId}/${entry.path}`)).slice(0, 32)
      if (streaming) { if (!entry.size) entry.hash = await digest(''); continue }
      const file = await open(join(root, entry.path), 'r')
      try { if (ps5SourceStamp(await file.stat()) !== entry.stamp) fail('Исходный файл изменился'); entry.hash = await cachedPs5SourceHash(cache, entry.path, file, entry.size, entry.stamp, signal, n => progress(checked + n)) }
      finally { await file.close() }
      checked += entry.size
    }
    const p: FolderPlan = { version: streaming ? 2 : 1, id: item.transferId, root, title: item.titleId, content: item.contentId!, appVersion: item.appVersion!, total, entries: list, metadataHash: await digest(param), manifestHash: '' }
    if (!streaming && list.find(e => e.path === 'sce_sys/param.json')!.hash !== p.metadataHash) fail('Метаданные Folder изменились во время проверки')
    if (streaming) p.planHash = await structuralPlanHash(p); else p.manifestHash = await digest(folderManifest(p))
    if (!streaming) await verifyFolderSource(p, item, root, signal)
    progress(streaming ? 0 : total); return p
  } finally { cache.flush() }
}
async function upload(id: string, size: number, hash: string, read: (buffer: Buffer, position: number) => Promise<number>, signal: AbortSignal, request: FolderRequest, progress: (bytes: number) => void, checking: () => void = () => {}, background?: (verification: Promise<void>) => void, stream?: { identity: string; prepare: (offset: number) => Promise<void>; acknowledge: (offset: number) => void; finish: () => Promise<string> }) {
  let r = await request(id, '/api/v1/transfers/begin', { 'X-PackageFlow-Size': String(size), 'X-PackageFlow-Blake3': stream?.identity || hash, ...(stream ? { 'X-PackageFlow-Stream': 'folder-stream-v2' } : {}) }, undefined, signal)
  if (r.status === 409) r = await request(id, '/api/v1/transfers/status', {}, undefined, signal)
  const valid = (r: any) => r?.id === id && r.size === size && (stream ? r.sourceIdentity === stream.identity && typeof r.hashPending === 'boolean' && (r.hashPending ? !r.verified && r.blake3 === stream.identity : /^[0-9a-f]{64}$/.test(r.blake3 || '') && (!hash || r.blake3 === hash)) : r.blake3 === hash) && r.cancelled === false && Number.isSafeInteger(r.bytesDurable) && r.bytesDurable >= 0 && r.bytesDurable <= size
  if (r.status !== 200 || !valid(r.body)) fail('PS5 не подтвердила файл Folder')
  const max = r.body.chunkMax, chunk = typeof max === 'number' && max >= 262144 && max <= 4194304 && (max & (max - 1)) === 0 ? max : 262144
  const offset = r.body.bytesDurable; progress(offset)
  if (stream && r.body.verified === true && hash && r.body.blake3 === hash && offset === size) return
  if (stream) await stream.prepare(offset)
  await ps5SendChunks({ read, size, offset, chunkSize: chunk, signal, validateSource: async () => true,
    send: async (position, bytes) => {
      r = await request(id, '/api/v1/transfers/chunk', { 'X-PackageFlow-Offset': String(position) }, bytes, signal)
      if (r.status !== 200 || !valid(r.body) || r.body.bytesDurable !== position + bytes.length) throw new Error('Folder acknowledgement lost; reconcile durable offset')
    }, progress: n => { stream?.acknowledge(n); progress(n) },
  })
  if (stream) hash = await stream.finish()
  if (r.body.verified === true && r.body.bytesDurable === size && r.body.blake3 === hash) return
  checking()
  r = await request(id, '/api/v1/transfers/commit', stream ? { 'X-PackageFlow-Stream': 'folder-stream-v2', 'X-PackageFlow-Blake3': hash } : {}, undefined, signal)
  if (r.status === 409) throw new Error('Root worker busy')
  if (![200, 202].includes(r.status)) fail('Проверка файла Folder не началась')
  if (r.status === 200 && valid(r.body) && r.body.bytesDurable === size && r.body.verified === true) return
  const verify = async () => {
    let delay = 25
    for (;;) {
      signal.throwIfAborted()
      const op = await request(id, '/api/v1/operations/status', {}, undefined, signal)
      if (op.status === 200 && op.body.id === id && op.body.phase === 'verifying') {
        if (op.body.running === false && op.body.status === 200 && valid(op.body.result) && op.body.result.bytesDurable === size && op.body.result.verified === true) return
        if (op.body.running === false && op.body.status !== 200) fail('BLAKE3 файла Folder не совпал')
        if (op.body.running === true) { await sleep(signal, delay); delay = Math.min(500, delay * 2); continue }
      }
      // Older services without an exact worker receipt must still prove the file.
      r = await request(id, '/api/v1/transfers/status', {}, undefined, signal)
      if (r.status !== 200 || !valid(r.body)) fail('Состояние файла Folder изменилось')
      if (r.body.verified === true && r.body.bytesDurable === size) return
      if (!op.body.running) throw new Error('Verification interrupted; retry verified transfer only')
      await sleep(signal, delay); delay = Math.min(500, delay * 2)
    }
  }
  const verification = verify()
  if (background) background(verification)
  else await verification
}
export async function runFolderPlan(p: FolderPlan, item: Ps5Item, signal: AbortSignal, request: FolderRequest, save: (patch: Partial<Ps5Item>) => void, verificationWindow = 0, persist: (p: FolderPlan) => void = () => {}): Promise<Partial<Ps5Item>> {
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
    if (op.body.id === p.id && op.body.phase === 'publishing-folder') {
      if (!op.body.running && op.body.status !== 200) fail(`Служба не опубликовала Folder (${op.body.status})`)
      const prepared = op.body.result?.bytesPrepared, total = op.body.result?.bytesTotal
      if (op.body.running && Number.isSafeInteger(prepared) && prepared >= 0 && total === p.total && prepared <= total) {
        const gib = (n: number) => (n / 1024 ** 3).toFixed(2).replace('.', ',')
        return { state: 'installing', detail: `Подготавливаем Folder на PS5: ${gib(prepared)} / ${gib(total)} ГБ` }
      }
    }
    // Unlike an opaque Sony PKG submission, root publishes a tree bound to this
    // durable manifest ID. Retrying an absent/prepared intent cannot create a
    // second title and never replaces a foreign/existing publication.
  } else {
    await verifyFolderSource(p, item, p.root, signal)
    let sent = 0; save({ state: 'sending', progressPhase: 'transfer', detail: 'Передаём файлы Folder на PS5 с докачкой', bytesSent: 0 })
    const window = verificationWindow === 2 ? 2 : 0
    const stop = new AbortController(), transferSignal = AbortSignal.any([signal, stop.signal])
    const pending: Promise<void>[] = []
    const streamedCache = p.version === 2 ? new Ps5SourceHashCache(p.root) : undefined
    const track = (verification: Promise<void>) => {
      // Catch immediately: verification can fail while the next POST is running.
      pending.push(verification.catch(error => { stop.abort(error) }))
    }
    const drainOne = async () => { await pending.shift(); transferSignal.throwIfAborted() }
    try {
      for (const e of p.entries) {
        transferSignal.throwIfAborted()
        if (e.dir || e.size === 0) continue
        if (window && pending.length >= window) await drainOne()
        save({ state: 'sending', progressPhase: 'transfer', detail: 'Передаём файлы Folder на PS5 с докачкой' })
        const f = await open(join(p.root, e.path), 'r')
        try {
          if (ps5SourceStamp(await f.stat()) !== e.stamp) fail('Файл Folder изменился')
          let streamHash: Awaited<ReturnType<typeof ps5StreamHasher>> | undefined
          const stream = p.version === 2 ? {
            identity: await digest(`${p.planHash}/${e.id}/${e.stamp}`),
            prepare: async (offset: number) => { streamHash = await ps5StreamHasher(f, p.root, e.id!, e.stamp, offset, transferSignal) },
            acknowledge: (offset: number) => streamHash!.acknowledge(offset, offset === e.size),
            finish: async () => { await streamHash!.validate(); const hash = streamHash!.digest(); if (e.hash && e.hash !== hash || e.path === 'sce_sys/param.json' && hash !== p.metadataHash) fail('Содержимое Folder изменилось'); e.hash = hash; streamedCache?.put(e.path, await f.stat(), hash); persist(p); return hash },
          } : undefined
          await upload(e.id!, e.size, e.hash!, async (buffer, position) => {
            if (streamHash) return streamHash.read(buffer, position)
            const result = await f.read(buffer, 0, buffer.length, position)
            if (ps5SourceStamp(await f.stat()) !== e.stamp) fail('Файл Folder изменился во время передачи')
            return result.bytesRead
          }, transferSignal, request, n => save({ bytesSent: sent + n }), () => { if (!window) save({ state: 'verifying', progressPhase: 'device-check', detail: 'PS5 проверяет переданный файл Folder' }) }, window ? track : undefined, stream)
        } finally { await f.close() }
        sent += e.size
      }
      if (pending.length) save({ state: 'verifying', progressPhase: 'device-check', detail: 'PS5 завершает проверки переданных файлов Folder' })
      while (pending.length) await drainOne()
    } finally {
      stop.abort(); await Promise.all(pending); streamedCache?.flush()
    }
    await verifyFolderSource(p, item, p.root, signal)
    if (p.version === 2) { p.manifestHash = await digest(folderManifest(p)); persist(p); save({ hash: p.manifestHash, bytesChecked: p.total }) }
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
