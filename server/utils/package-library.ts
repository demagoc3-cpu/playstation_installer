import { logEvent } from './event-log'
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readSync } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { readJsonFile as readJson, writeJsonFile as writeJson } from './json-store'

const PKG_MAGIC = Buffer.from([0x7f, 0x43, 0x4e, 0x54])
const SFO_MAGIC = Buffer.from([0x00, 0x50, 0x53, 0x46])
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const HEADER_BYTES = 64 * 1024
const SFO_BYTES = 128 * 1024
// Some large retail PKG files place PARAM.SFO just after the first 4 MiB.
// The scan is streamed in 256 KiB blocks, so this raises compatibility without
// copying a multi-gigabyte package into memory.
const SFO_SEARCH_LIMIT = 32 * 1024 * 1024
const SFO_SEARCH_CHUNK = 256 * 1024
const COVER_CHUNK = 256 * 1024
const siteLibraryPath = resolve(process.cwd(), '.data/package-library.json')

export interface LocalPackage {
  id: string
  title: string
  fileName: string
  size: number
  type: 'Игра' | 'Патч' | 'Бэкпорт' | 'DLC'
  titleId: string
  installOrder: number
  contentId: string
  contentType: string
  packageDigest: string
  iconSize: number
  libraryRoot: string
  installedAt?: number
}

interface PackageIcon { offset: number; size: number }
interface StoredPackage extends LocalPackage { path: string; sourceModifiedAt: number; coverPath?: string; icon: PackageIcon }
interface DeliveryStatus { requests: number; bytesSent: number; ranges: Array<{ start: number; end: number }>; startedAt?: number; completedAt?: number; lastActivityAt?: number; partial?: boolean }
interface FolderCacheEntry { size: number; modifiedAt: number; item: StoredPackage }
interface FolderCache { version: 1; packages: Record<string, FolderCacheEntry> }
interface SiteLibrary { version: 2; packages: StoredPackage[]; deliveries: Record<string, DeliveryStatus> }

const blankLibrary = (): SiteLibrary => ({ version: 2, packages: [], deliveries: {} })
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32)
const cacheDirectory = (root: string) => join(root, '.packageflow')
const cachePath = (root: string) => join(cacheDirectory(root), 'index.json')
const coversDirectory = (root: string) => join(cacheDirectory(root), 'covers')

// Delivery progress lives in memory: the PS4 fires many Range requests per
// package and persisting each one made Windows fail on locked files.
let deliveryCache: Record<string, DeliveryStatus> | undefined
let deliveryFlushTimer: ReturnType<typeof setTimeout> | undefined

function readLibraryFile() {
  const library = readJson(siteLibraryPath, blankLibrary())
  return library.version === 2 ? library : blankLibrary()
}

function deliveries() {
  deliveryCache ||= readLibraryFile().deliveries || {}
  return deliveryCache
}

function readLibrary() {
  const library = readLibraryFile()
  library.deliveries = deliveries()
  return library
}

function writeLibrary(library: SiteLibrary) {
  if (deliveryFlushTimer) { clearTimeout(deliveryFlushTimer); deliveryFlushTimer = undefined }
  writeJson(siteLibraryPath, { ...library, deliveries: deliveries() })
}

function scheduleDeliveryFlush() {
  if (deliveryFlushTimer) return
  deliveryFlushTimer = setTimeout(() => {
    deliveryFlushTimer = undefined
    try { writeLibrary(readLibraryFile()) } catch (error) { logEvent('warn', 'Не удалось сохранить прогресс передачи:', error) }
  }, 1000)
}
function publicItem({ path: _, sourceModifiedAt: __, coverPath: ___, icon: ____, ...item }: StoredPackage): LocalPackage { return item }

async function findSfoOffset(handle: Awaited<ReturnType<typeof open>>, header: Buffer) {
  const headerOffset = header.indexOf(SFO_MAGIC)
  if (headerOffset >= 0) return headerOffset
  const chunk = Buffer.alloc(SFO_SEARCH_CHUNK)
  let tail = Buffer.alloc(0)
  for (let offset = HEADER_BYTES; offset < SFO_SEARCH_LIMIT; offset += SFO_SEARCH_CHUNK) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset)
    if (!bytesRead) break
    const current = Buffer.concat([tail, chunk.subarray(0, bytesRead)])
    const found = current.indexOf(SFO_MAGIC)
    if (found >= 0) return offset - tail.length + found
    tail = current.subarray(Math.max(0, current.length - 3))
  }
  return -1
}

function parseSfo(data: Buffer) {
  if (!data.subarray(0, 4).equals(SFO_MAGIC) || data.length < 20) throw new Error('PARAM.SFO не найден')
  const keyTable = data.readUInt32LE(8)
  const dataTable = data.readUInt32LE(12)
  const count = data.readUInt32LE(16)
  const values = new Map<string, string>()
  for (let index = 0; index < count; index++) {
    const entry = 20 + index * 16
    if (entry + 16 > data.length) break
    const keyStart = keyTable + data.readUInt16LE(entry)
    const length = data.readUInt32LE(entry + 4)
    const valueStart = dataTable + data.readUInt32LE(entry + 12)
    if (keyStart >= data.length || valueStart + length > data.length) continue
    const keyEnd = data.indexOf(0, keyStart)
    const key = data.subarray(keyStart, keyEnd < 0 ? data.length : keyEnd).toString('utf8')
    values.set(key, data.subarray(valueStart, valueStart + length).toString('utf8').replace(/\0/g, '').trim())
  }
  return values
}

function extractIconEntry(header: Buffer): PackageIcon {
  if (header.length < 0x20) return { offset: 0, size: 0 }
  const tableOffset = header.readUInt32BE(0x18)
  const entryCount = header.readUInt32BE(0x10)
  for (let index = 0; index < entryCount; index++) {
    const entry = tableOffset + index * 0x20
    if (entry + 0x20 > header.length || header.readUInt32BE(entry) !== 0x1200) continue
    const offset = header.readUInt32BE(entry + 0x10)
    const size = header.readUInt32BE(entry + 0x14)
    return size > 0 && size <= 2 * 1024 * 1024 ? { offset, size } : { offset: 0, size: 0 }
  }
  return { offset: 0, size: 0 }
}

export async function readPackageMetadata(path: string, fileName: string) {
  const handle = await open(path, 'r')
  try {
    const header = Buffer.alloc(HEADER_BYTES)
    const { bytesRead: headerBytes } = await handle.read(header, 0, header.length, 0)
    const data = header.subarray(0, headerBytes)
    if (data.length < 0x1000 || !data.subarray(0, 4).equals(PKG_MAGIC)) throw new Error('Некорректный заголовок PKG')
    const sfoOffset = await findSfoOffset(handle, data)
    if (sfoOffset < 0) throw new Error('PARAM.SFO не найден в первых 4 МБ')
    const sfo = Buffer.alloc(SFO_BYTES)
    const { bytesRead: sfoBytes } = await handle.read(sfo, 0, sfo.length, sfoOffset)
    const values = parseSfo(sfo.subarray(0, sfoBytes))
    const category = values.get('CATEGORY') || ''
    const contentId = values.get('CONTENT_ID') || ''
    if (!category || !contentId) throw new Error('В PARAM.SFO отсутствуют CATEGORY или CONTENT_ID')
    const title = values.get('TITLE') || basename(fileName, extname(fileName)).replace(/[._-]/g, ' ')
    const titleId = values.get('TITLE_ID') || contentId.match(/CUSA\d{5}/i)?.[0]?.toUpperCase() || contentId
    const isDlc = category === 'ac'
    const isBackport = !isDlc && /backport/i.test(`${fileName} ${title}`)
    const type: LocalPackage['type'] = isDlc ? 'DLC' : isBackport ? 'Бэкпорт' : category.startsWith('gp') ? 'Патч' : 'Игра'
    const icon = extractIconEntry(data)
    return { title, titleId, appVersion: values.get('APP_VER') || '', installOrder: isDlc ? 2 : type === 'Игра' ? 0 : 1, contentId, contentType: `PS4${category.toUpperCase()}`, packageDigest: data.subarray(0xfe0, 0x1000).toString('hex').toUpperCase(), icon, iconSize: icon.size, type }
  } finally { await handle.close() }
}

async function writeCover(source: string, icon: PackageIcon, destination: string) {
  if (!icon.size) return undefined
  const sourceHandle = await open(source, 'r')
  const destinationHandle = await open(destination, 'w')
  try {
    const chunk = Buffer.alloc(Math.min(COVER_CHUNK, icon.size))
    let offset = 0
    while (offset < icon.size) {
      const count = Math.min(chunk.length, icon.size - offset)
      const { bytesRead } = await sourceHandle.read(chunk, 0, count, icon.offset + offset)
      if (!bytesRead) throw new Error('Не удалось прочитать обложку')
      if (offset === 0 && !chunk.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) throw new Error('Неверный формат обложки')
      await destinationHandle.write(chunk, 0, bytesRead)
      offset += bytesRead
    }
    return destination
  } finally { await sourceHandle.close(); await destinationHandle.close() }
}

async function walk(directory: string, root: string, cache: FolderCache, found: StoredPackage[], oldItems: Map<string, StoredPackage>, limit: number): Promise<void> {
  if (found.length >= limit) return
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (found.length >= limit) return
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) { if (entry.name !== '.packageflow') await walk(path, root, cache, found, oldItems, limit); continue }
    if (!entry.isFile() || !/\.(pkg|fpkg)$/i.test(entry.name)) continue
    const info = await stat(path).catch(() => undefined)
    if (!info) continue
    const key = relative(root, path)
    const cached = cache.packages[key]
    if (cached?.size === info.size && cached.modifiedAt === info.mtimeMs && existsSync(cached.item.path) && (!cached.item.coverPath || existsSync(cached.item.coverPath))) {
      cached.item.libraryRoot = root
      found.push(cached.item)
      continue
    }
    const metadata = await readPackageMetadata(path, entry.name).catch(() => undefined)
    if (!metadata) continue
    const id = hash(path)
    const coverPath = metadata.icon.size ? join(coversDirectory(root), `${id}.png`) : undefined
    if (coverPath) { mkdirSync(dirname(coverPath), { recursive: true }); await writeCover(path, metadata.icon, coverPath).catch(() => undefined) }
    const item: StoredPackage = { id, path, fileName: entry.name, size: info.size, libraryRoot: root, sourceModifiedAt: info.mtimeMs, installedAt: oldItems.get(id)?.installedAt, coverPath, ...metadata }
    cache.packages[key] = { size: info.size, modifiedAt: info.mtimeMs, item }
    found.push(item)
    if (found.length % 12 === 0) await new Promise<void>((done) => setImmediate(done))
  }
}

export async function scanPackageFolder(directory: string, onlyTitleId?: string) {
  if (!directory?.trim()) throw createError({ statusCode: 400, message: 'Укажите путь к папке с пакетами' })
  const root = resolve(directory.trim())
  const rootInfo = await stat(root).catch(() => undefined)
  if (!rootInfo?.isDirectory()) throw createError({ statusCode: 404, message: 'Папка не найдена или недоступна' })
  const cache = readJson<FolderCache>(cachePath(root), { version: 1, packages: {} })
  const siteLibrary = readLibrary()
  const oldItems = new Map(siteLibrary.packages.map((item) => [item.id, item]))
  const found: StoredPackage[] = []
  await walk(root, root, cache, found, oldItems, 500)
  writeJson(cachePath(root), cache)
  const scannedPaths = new Set(found.map((item) => item.path))
  siteLibrary.packages = [...siteLibrary.packages.filter((item) => !scannedPaths.has(item.path)), ...found]
  writeLibrary(siteLibrary)
  return { directory: root, packages: found.filter((item) => !onlyTitleId || item.titleId === onlyTitleId).map(publicItem) }
}

export function getLibraryPackages() { return readLibrary().packages.filter((item) => existsSync(item.path)).map(publicItem) }
export function getPackage(id: string) { const item = readLibrary().packages.find((entry) => entry.id === id); if (!item || !existsSync(item.path)) throw createError({ statusCode: 404, message: 'Пакет не найден. Просканируйте папку повторно.' }); return item }
export function getPackageStream(id: string, options?: { start?: number; end?: number }) { const item = getPackage(id); return { item, stream: createReadStream(item.path, options) } }
export function getPackageIconStream(id: string) { const item = getPackage(id); if (!item.coverPath || !existsSync(item.coverPath)) throw createError({ statusCode: 404, message: 'Кэш обложки не найден. Пересканируйте папку.' }); return createReadStream(item.coverPath) }
export async function readPackageIcon(id: string) { const item = getPackage(id); if (!item.coverPath || !existsSync(item.coverPath)) return undefined; return readFile(item.coverPath) }

// Packages whose installation was cancelled: the console may keep retrying the
// BGFT job, so their data is refused until the package is dispatched again.
const blockedDeliveries = new Set<string>()
const activeTransfers = new Map<string, Set<() => void>>()

/** Registers a running HTTP transfer so a cancel can cut it; returns an unregister function. */
export function registerActiveTransfer(id: string, abort: () => void) {
  const transfers = activeTransfers.get(id) || new Set<() => void>()
  transfers.add(abort)
  activeTransfers.set(id, transfers)
  touchDelivery(id)
  return () => { transfers.delete(abort); if (!transfers.size) activeTransfers.delete(id); touchDelivery(id) }
}

export function isDeliveryBlocked(id: string) { return blockedDeliveries.has(id) }

/** Refuses further PS4 requests for the package and drops transfers in progress. */
export function blockPackageDelivery(id: string) {
  blockedDeliveries.add(id)
  for (const abort of [...(activeTransfers.get(id) || [])]) { try { abort() } catch { /* already closed */ } }
  activeTransfers.delete(id)
}

/** Starts a fresh, independently observable HTTP delivery for a new PS4 job. */
export function resetPackageDelivery(id: string) {
  blockedDeliveries.delete(id)
  const library = readLibrary()
  if (!library.packages.some((item) => item.id === id)) throw createError({ statusCode: 404, message: 'Пакет не найден' })
  delete library.deliveries[id]
  writeLibrary(library)
}

export function markPackageInstalled(id: string, installed: boolean) { const library = readLibrary(); const item = library.packages.find((entry) => entry.id === id); if (!item) throw createError({ statusCode: 404, message: 'Пакет не найден' }); item.installedAt = installed ? Date.now() : undefined; writeLibrary(library); return publicItem(item) }

export function clearConsoleInstallation(titleId: string, kind: string, componentId: string) {
  const library = readLibrary(); const affected: string[] = []
  for (const item of library.packages) {
    if (item.titleId !== titleId) continue
    if (kind === 'game' || (kind === 'patch' && item.contentType === 'PS4GP') ||
      (['dlc', 'dlcs'].includes(kind) && item.type === 'DLC' && (kind === 'dlcs' || item.contentId.slice(20) === componentId))) { item.installedAt = undefined; affected.push(item.id) }
  }
  writeLibrary(library); return affected
}

export function removePackageFromLibrary(id: string) {
  const library = readLibrary()
  const before = library.packages.length
  library.packages = library.packages.filter((item) => item.id !== id)
  if (library.packages.length === before) throw createError({ statusCode: 404, message: 'Пакет не найден' })
  delete library.deliveries[id]
  writeLibrary(library)
}

export function removePackageBranch(titleId: string) {
  const library = readLibrary()
  const removed = library.packages.filter((item) => item.titleId === titleId)
  if (!removed.length) throw createError({ statusCode: 404, message: 'Ветка игры не найдена' })
  library.packages = library.packages.filter((item) => item.titleId !== titleId)
  removed.forEach((item) => delete library.deliveries[item.id])
  writeLibrary(library)
  return { removed: removed.length }
}

/** Any request from the console (manifest or data) proves it accepted the job. */
export function recordPackageRequest(id: string) {
  const delivery = deliveries()[id] ||= { requests: 0, bytesSent: 0, ranges: [] }
  delivery.requests += 1
  delivery.startedAt ||= Date.now()
  delivery.lastActivityAt = Date.now()
  scheduleDeliveryFlush()
}

function touchDelivery(id: string) { const delivery = deliveries()[id]; if (delivery) delivery.lastActivityAt = Date.now() }

// BGFT skips the first 64 KiB (fetched separately as a bootstrap chunk) and
// stops at the end of the package content (the PFS image); the bytes after it
// are never requested. Completion is therefore measured against that region.
const BOOTSTRAP_BYTES = 64 * 1024
const IDLE_COMPLETE_MS = 30_000
const requiredEndCache = new Map<string, number>()

/** End (exclusive) of the region the console actually downloads: content_offset + content_size from the PKG header. */
function requiredEnd(item: StoredPackage) {
  const cached = requiredEndCache.get(item.id)
  if (cached) return cached
  let end = item.size
  try {
    const header = Buffer.alloc(0x40)
    const handle = openSync(item.path, 'r')
    try { readSync(handle, header, 0, header.length, 0) } finally { closeSync(handle) }
    const contentEnd = Number(header.readBigUInt64BE(0x30) + header.readBigUInt64BE(0x38))
    if (contentEnd > BOOTSTRAP_BYTES && contentEnd <= item.size) end = contentEnd
  } catch { /* fall back to the whole file */ }
  requiredEndCache.set(item.id, end)
  return end
}

function covers(ranges: DeliveryStatus['ranges'], from: number, to: number) {
  return ranges.some((range) => range.start <= from && range.end >= to)
}

/** Marks the delivery complete once the downloadable region is covered, or the console went quiet after receiving data. */
function settleDelivery(item: StoredPackage, delivery: DeliveryStatus) {
  if (delivery.completedAt) return false
  const end = requiredEnd(item)
  if (covers(delivery.ranges, Math.min(BOOTSTRAP_BYTES, end - 1), end - 1) || delivery.bytesSent >= item.size) {
    delivery.completedAt = Date.now()
    return true
  }
  const quiet = delivery.lastActivityAt && Date.now() - delivery.lastActivityAt >= IDLE_COMPLETE_MS
  if (delivery.bytesSent > 0 && quiet && !activeTransfers.has(item.id)) {
    delivery.completedAt = Date.now()
    delivery.partial = true
    return true
  }
  return false
}

/** Called repeatedly while a range streams, so large ranges show progress before they finish. */
export function recordPackageDelivery(id: string, start: number, end: number, completed: boolean) {
  if (end < start) return
  const item = readLibraryFile().packages.find((entry) => entry.id === id)
  if (!item) return
  const delivery = deliveries()[id] ||= { requests: 0, bytesSent: 0, ranges: [] }
  delivery.startedAt ||= Date.now()
  delivery.lastActivityAt = Date.now()
  const ranges = [...delivery.ranges, { start, end }].sort((a, b) => a.start - b.start)
  delivery.ranges = ranges.reduce<Array<{ start: number; end: number }>>((merged, range) => { const previous = merged.at(-1); if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end); else merged.push({ ...range }); return merged }, [])
  delivery.bytesSent = delivery.ranges.reduce((total, range) => total + range.end - range.start + 1, 0)
  if (completed) delivery.completedAt ||= Date.now()
  else settleDelivery(item, delivery)
  scheduleDeliveryFlush()
}

export function getPackageDelivery(id: string) {
  const item = getPackage(id)
  const delivery = deliveries()[id] || { requests: 0, bytesSent: 0, ranges: [] }
  if (settleDelivery(item, delivery)) { deliveries()[id] = delivery; scheduleDeliveryFlush() }
  return { ...delivery, size: item.size, requiredSize: requiredEnd(item) }
}
