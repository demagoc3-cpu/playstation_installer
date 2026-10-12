import { lstat, open } from 'node:fs/promises'
import { createBLAKE3 } from 'hash-wasm'
import { readPs5ImageMetadata } from './ps5-content-metadata'
import { ps5SourceStamp } from './ps5-source-hash'
import { Ps5SourceHashCache, cachedPs5SourceHash } from './ps5-source-hash-cache'
import { ps5SendChunks, ps5TransferProtocol } from './ps5-send-chunks'
import { Ps5QueueFailure, Ps5QueueUncertain, type Ps5Item } from './ps5-queue-core'
import type { FolderRequest } from './ps5-folder-driver'

export const ps5ImageFormats = ['ufs2', 'exfat', 'pfs', 'ffpfsc'] as const
export type Ps5ImageFormat = typeof ps5ImageFormats[number]
export interface ImagePlan {
  version: 1; id: string; root: string; format: Ps5ImageFormat
  title: string; content: string; appVersion: string; size: number
  stamp: string; imageId: string; imageHash: string; manifestHash: string
}
const fail = (message: string): never => { throw new Ps5QueueFailure(message) }
const digest = async (bytes: Uint8Array | string) => { const h = await createBLAKE3(256); h.update(bytes); return h.digest('hex') }
export const isPs5ImageFormat = (value: unknown): value is Ps5ImageFormat => ps5ImageFormats.some(format => format === value)
export function imageManifest(p: ImagePlan) {
  return `PF_IMAGE1 ${p.format} ${p.title} ${p.content} ${p.appVersion} ${p.imageId} ${p.imageHash} ${p.size}\n`
}
function identity(item: Ps5Item) {
  if (item.platform !== 'ps5' || item.order !== 0 || !isPs5ImageFormat(item.format) ||
      !/^PPSA\d{5}$/.test(item.titleId) || !/^[A-Z0-9_-]{1,63}$/.test(item.contentId || '') ||
      !item.contentId!.includes(`${item.titleId}_`) || !/^\d{2}\.\d{3}\.\d{3}$/.test(item.appVersion || '') ||
      !/^[0-9a-f]{32}$/.test(item.transferId) || !Number.isSafeInteger(item.size) || item.size <= 0) fail('Некорректные метаданные образа PS5')
}
export async function verifyImagePlan(p: ImagePlan, item: Ps5Item, root: string) {
  identity(item)
  if (p.version !== 1 || p.id !== item.transferId || p.root !== root || p.format !== item.format ||
      p.title !== item.titleId || p.content !== item.contentId || p.appVersion !== item.appVersion || p.size !== item.size ||
      typeof p.stamp !== 'string' || !p.stamp || !/^[0-9a-f]{64}$/.test(p.imageHash) ||
      p.imageId !== (await digest(`${p.id}/image`)).slice(0, 32) || p.manifestHash !== await digest(imageManifest(p)) ||
      item.hash && item.hash !== p.imageHash || item.sourceStamp && item.sourceStamp !== p.stamp) fail('Сохранённый план образа не соответствует заданию')
}
export async function createImagePlan(root: string, item: Ps5Item, signal: AbortSignal, progress: (bytes: number) => void): Promise<ImagePlan> {
  identity(item); signal.throwIfAborted()
  const source = await lstat(root)
  if (!source.isFile() || source.isSymbolicLink() || source.size !== item.size) fail('Источник образа должен быть неизменившимся обычным файлом')
  const file = await open(root, 'r'), stamp = ps5SourceStamp(source)
  const cache = new Ps5SourceHashCache(root)
  try {
    if (ps5SourceStamp(await file.stat()) !== stamp) fail('Образ изменился при открытии')
    // Re-read contents, never choose a mount driver from the filename suffix.
    const meta = await readPs5ImageMetadata(root)
    signal.throwIfAborted()
    if (meta.format !== item.format || meta.platform !== 'ps5' || meta.installOrder !== 0 || meta.titleId !== item.titleId ||
        meta.contentId !== item.contentId || meta.appVersion !== item.appVersion) fail('Формат или метаданные образа изменились. Просканируйте источник повторно')
    if (ps5SourceStamp(await lstat(root)) !== stamp || ps5SourceStamp(await file.stat()) !== stamp) fail('Образ изменился во время чтения метаданных')
    const imageHash = await cachedPs5SourceHash(cache, '.', file, item.size, stamp, signal, progress)
    if (ps5SourceStamp(await lstat(root)) !== stamp) fail('Образ заменён во время проверки')
    const p: ImagePlan = { version: 1, id: item.transferId, root, format: item.format as Ps5ImageFormat, title: item.titleId,
      content: item.contentId!, appVersion: item.appVersion!, size: item.size, stamp,
      imageId: (await digest(`${item.transferId}/image`)).slice(0, 32), imageHash, manifestHash: '' }
    p.manifestHash = await digest(imageManifest(p)); await verifyImagePlan(p, item, root); return p
  } finally { cache.flush(); await file.close() }
}
async function upload(id: string, size: number, hash: string, read: (buffer: Buffer, position: number) => Promise<number>, validateSource: () => Promise<boolean>, signal: AbortSignal, request: FolderRequest, progress: (bytes: number) => void, checking: () => void) {
  const valid = (b: any) => b?.id === id && b.size === size && b.blake3 === hash && b.cancelled === false &&
    Number.isSafeInteger(b.bytesDurable) && b.bytesDurable >= 0 && b.bytesDurable <= size
  let r = await request(id, '/api/v1/transfers/begin', { 'X-PackageFlow-Size': String(size), 'X-PackageFlow-Blake3': hash }, undefined, signal)
  if (r.status === 409) r = await request(id, '/api/v1/transfers/status', {}, undefined, signal)
  if (r.status !== 200 || !valid(r.body)) fail('PS5 не подтвердила состояние передачи образа')
  const protocol = ps5TransferProtocol(r.body)
  progress(r.body.bytesDurable)
  await ps5SendChunks({ read, validateSource, size, offset: r.body.bytesDurable, chunkSize: protocol.size, signal,
    send: async (position, bytes) => {
      const ack = await request(id, protocol.path, { 'X-PackageFlow-Offset': String(position) }, bytes, signal)
      if (ack.status !== 200 || !valid(ack.body) || ack.body.bytesDurable !== position + bytes.length) throw new Error('Image acknowledgement lost; reconcile durable offset')
    }, progress })
  checking()
  r = await request(id, '/api/v1/transfers/commit', {}, undefined, signal)
  if (![200, 202].includes(r.status)) throw new Error('Image verification unavailable')
  for (;;) {
    signal.throwIfAborted()
    r = await request(id, '/api/v1/transfers/status', {}, undefined, signal)
    if (r.status !== 200 || !valid(r.body)) fail('Состояние образа на PS5 изменилось')
    if (r.body.bytesDurable === size && r.body.verified === true) return
    const op = await request(id, '/api/v1/operations/status', {}, undefined, signal)
    if (op.body.id !== id || op.body.phase !== 'verifying') throw new Error('Image verification interrupted; retain verified transfer')
    if (op.body.running === false) fail('Проверка BLAKE3 образа не завершилась успешно')
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 250)
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
    })
  }
}
export function imagePublicationResult(p: ImagePlan, reply: { status: number; body: any }): Partial<Ps5Item> | undefined {
  if (reply.status !== 200) return
  const b = reply.body, suffix = { ufs2: 'ffpkg', exfat: 'exfat', pfs: 'ffpfs', ffpfsc: 'ffpfsc' }[p.format]
  if (b.id !== p.id || b.title !== p.title || b.content !== p.content || b.version !== p.appVersion || b.format !== p.format ||
      b.proof !== 'image-publication' || b.manifestHash !== p.manifestHash || b.imageHash !== p.imageHash || b.size !== p.size ||
      b.sourceName !== `${p.title}.${suffix}` || b.backend !== 'shadowmount' || b.installed !== false || b.registered !== false ||
      !['copying', 'prepared', 'published'].includes(b.state)) fail('Результат публикации образа не соответствует заданию')
  // No appmeta/mount.lnk shortcut. Publication is not a system registration.
  if (b.state === 'published') return { state: 'unconfirmed', detail: 'Образ опубликован для ShadowMount. Системная регистрация и запуск пока не подтверждены' }
}
export function imageRegistrationResult(p: ImagePlan, reply: { status: number; body: any }): Partial<Ps5Item> | undefined {
  if (reply.status !== 200) return
  const b = reply.body, suffix = { ufs2: 'ffpkg', exfat: 'exfat', pfs: 'ffpfs', ffpfsc: 'ffpfsc' }[p.format]
  if (b.id !== p.id || b.title !== p.title || b.content !== p.content || b.version !== p.appVersion || b.format !== p.format ||
      b.proof !== 'image-registration' || b.manifestHash !== p.manifestHash || b.imageHash !== p.imageHash || b.size !== p.size ||
      b.sourceName !== `${p.title}.${suffix}` || b.backend !== 'shadowmount' || !['copying', 'prepared', 'published', 'registered'].includes(b.state) ||
      b.installed !== (b.state === 'registered') || b.registered !== (b.state === 'registered')) fail('Подтверждение регистрации образа не соответствует заданию')
  if (b.state === 'registered') return { state: 'installed', confirmation: 'service-registration', confirmedAt: Date.now(), detail: `PS5 подтвердила системную регистрацию образа, версия ${p.appVersion}` }
}
/** A dispatched registration is reconciled by reads only, even without the
 * original local image. Publication receipts remain a separate legacy protocol. */
export async function runRegisteredImagePlan(p: ImagePlan, item: Ps5Item, signal: AbortSignal, request: FolderRequest, save: (patch: Partial<Ps5Item>) => void) {
  return runImagePlan(p, item, signal, request, save, 'image-registration-v1')
}
export async function cancelImagePlan(p: ImagePlan | undefined, item: Ps5Item, request: FolderRequest) {
  if (item.installDispatched) throw new Ps5QueueUncertain('Образ уже передан на регистрацию. Отмена не отправлена')
  if (!p) { if (item.bytesSent) fail('План передаваемого образа недоступен'); return }
  await verifyImagePlan(p, item, p.root)
  const publication = await request(p.id, '/api/v1/images/status', {})
  if (publication.status !== 404) throw new Ps5QueueUncertain('Публикация образа могла начаться. Требуется сверка')
  for (const id of [p.imageId, p.id]) {
    const r = await request(id, '/api/v1/transfers/cancel', {})
    if ([200, 404].includes(r.status)) continue
    if (r.status === 409) {
      const status = await request(id, '/api/v1/transfers/status', {})
      if (status.status === 200 && status.body.id === id && status.body.verified === true) continue
    }
    throw new Error('Отмена передачи образа не подтверждена')
  }
}
/** Candidate for an explicitly coordinated image test. Public admission remains
 * disabled until the mount + system registration + lifecycle gate passes. */
export async function runImagePlan(p: ImagePlan, item: Ps5Item, signal: AbortSignal, request: FolderRequest, save: (patch: Partial<Ps5Item>) => void, protocol: 'image-publication-v1' | 'image-registration-v1' = 'image-publication-v1'): Promise<Partial<Ps5Item>> {
  await verifyImagePlan(p, item, p.root); signal.throwIfAborted()
  if (item.installDispatched) {
    const r = await request(p.id, '/api/v1/images/status', {}, undefined, signal)
    const result = protocol === 'image-registration-v1' ? imageRegistrationResult(p, r) : imagePublicationResult(p, r); if (result) return result
    if (protocol === 'image-registration-v1' && r.status === 200 && r.body.state === 'published') {
      if (!item.imagePublishedAt) save({ imagePublishedAt: Date.now() })
      else if (Date.now() - item.imagePublishedAt > 120_000) throw new Ps5QueueUncertain('Образ передан, но системная регистрация ещё не подтверждена. Повтор не отправлен')
      return { state: 'installing', detail: 'Образ передан. Ожидаем системную регистрацию PS5' }
    }
    const op = await request(p.id, '/api/v1/operations/status', {}, undefined, signal)
    if (op.status === 200 && op.body.id === p.id && op.body.phase === 'publishing-image' && op.body.running === true) return { state: 'installing', detail: 'Служба подготавливает образ на PS5' }
    // Explicit resume can be added after inspecting a durable owned receipt.
    // A lost POST never silently publishes again or goes to the PKG installer.
    throw new Ps5QueueUncertain('Результат публикации образа неизвестен. Повтор не отправлен')
  }
  const source = await lstat(p.root)
  if (!source.isFile() || source.isSymbolicLink() || ps5SourceStamp(source) !== p.stamp) fail('Исходный образ изменился')
  const file = await open(p.root, 'r')
  try {
    if (ps5SourceStamp(await file.stat()) !== p.stamp) fail('Исходный образ заменён')
    save({ hash: p.imageHash, sourceStamp: p.stamp, state: 'sending', progressPhase: 'transfer', bytesSent: 0, detail: 'Передаём образ на PS5 с докачкой' })
    await upload(p.imageId, p.size, p.imageHash, async (b, position) => (await file.read(b, 0, b.length, position)).bytesRead,
      async () => ps5SourceStamp(await file.stat()) === p.stamp && ps5SourceStamp(await lstat(p.root)) === p.stamp, signal, request,
      bytesSent => save({ bytesSent }), () => save({ state: 'verifying', progressPhase: 'device-check', detail: 'PS5 проверяет BLAKE3 образа' }))
    if (ps5SourceStamp(await lstat(p.root)) !== p.stamp) fail('Образ заменён во время передачи')
  } finally { await file.close() }
  const manifest = Buffer.from(imageManifest(p))
  await upload(p.id, manifest.length, p.manifestHash, async (b, position) => { const n = Math.min(b.length, manifest.length - position); manifest.copy(b, 0, position, position + n); return n },
    async () => true, signal, request, () => {}, () => {})
  signal.throwIfAborted(); save({ state: 'installing', installDispatched: true, detail: 'Публикуем проверенный образ для ShadowMount' })
  const headers = protocol === 'image-registration-v1' ? { 'X-PackageFlow-Image-Protocol': protocol } : { 'X-PackageFlow-Experimental': protocol }
  const r = await request(p.id, '/api/v1/images/commit', headers, undefined, signal)
  if (![200, 202].includes(r.status)) throw new Ps5QueueUncertain('Ответ публикации потерян. Повтор не отправлен')
  return { state: 'installing' }
}
