import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'

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
interface DeliveryStatus { requests: number; bytesSent: number; ranges: Array<{ start: number; end: number }>; startedAt?: number; completedAt?: number }
interface FolderCacheEntry { size: number; modifiedAt: number; item: StoredPackage }
interface FolderCache { version: 1; packages: Record<string, FolderCacheEntry> }
interface SiteLibrary { version: 2; packages: StoredPackage[]; deliveries: Record<string, DeliveryStatus> }

const blankLibrary = (): SiteLibrary => ({ version: 2, packages: [], deliveries: {} })
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32)
const cacheDirectory = (root: string) => join(root, '.packageflow')
const cachePath = (root: string) => join(cacheDirectory(root), 'index.json')
const coversDirectory = (root: string) => join(cacheDirectory(root), 'covers')

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return fallback }
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value))
  renameSync(temporary, path)
}

function readLibrary() {
  const library = readJson(siteLibraryPath, blankLibrary())
  return library.version === 2 ? library : blankLibrary()
}

function writeLibrary(library: SiteLibrary) { writeJson(siteLibraryPath, library) }
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

async function readPackageMetadata(path: string, fileName: string) {
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
    return { title, titleId, installOrder: isDlc ? 2 : type === 'Игра' ? 0 : 1, contentId, contentType: `PS4${category.toUpperCase()}`, packageDigest: data.subarray(0xfe0, 0x1000).toString('hex').toUpperCase(), icon, iconSize: icon.size, type }
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
  if (!directory?.trim()) throw createError({ statusCode: 400, statusMessage: 'Укажите путь к папке с пакетами' })
  const root = resolve(directory.trim())
  const rootInfo = await stat(root).catch(() => undefined)
  if (!rootInfo?.isDirectory()) throw createError({ statusCode: 404, statusMessage: 'Папка не найдена или недоступна' })
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
export function getPackage(id: string) { const item = readLibrary().packages.find((entry) => entry.id === id); if (!item || !existsSync(item.path)) throw createError({ statusCode: 404, statusMessage: 'Пакет не найден. Просканируйте папку повторно.' }); return item }
export function getPackageStream(id: string, options?: { start?: number; end?: number }) { const item = getPackage(id); return { item, stream: createReadStream(item.path, options) } }
export function getPackageIconStream(id: string) { const item = getPackage(id); if (!item.coverPath || !existsSync(item.coverPath)) throw createError({ statusCode: 404, statusMessage: 'Кэш обложки не найден. Пересканируйте папку.' }); return createReadStream(item.coverPath) }
export async function readPackageIcon(id: string) { const item = getPackage(id); if (!item.coverPath || !existsSync(item.coverPath)) return undefined; return readFile(item.coverPath) }

/** Starts a fresh, independently observable HTTP delivery for a new PS4 job. */
export function resetPackageDelivery(id: string) {
  const library = readLibrary()
  if (!library.packages.some((item) => item.id === id)) throw createError({ statusCode: 404, statusMessage: 'Пакет не найден' })
  delete library.deliveries[id]
  writeLibrary(library)
}

export function markPackageInstalled(id: string, installed: boolean) { const library = readLibrary(); const item = library.packages.find((entry) => entry.id === id); if (!item) throw createError({ statusCode: 404, statusMessage: 'Пакет не найден' }); item.installedAt = installed ? Date.now() : undefined; writeLibrary(library); return publicItem(item) }

export function removePackageFromLibrary(id: string) {
  const library = readLibrary()
  const before = library.packages.length
  library.packages = library.packages.filter((item) => item.id !== id)
  if (library.packages.length === before) throw createError({ statusCode: 404, statusMessage: 'Пакет не найден' })
  delete library.deliveries[id]
  writeLibrary(library)
}

export function removePackageBranch(titleId: string) {
  const library = readLibrary()
  const removed = library.packages.filter((item) => item.titleId === titleId)
  if (!removed.length) throw createError({ statusCode: 404, statusMessage: 'Ветка игры не найдена' })
  library.packages = library.packages.filter((item) => item.titleId !== titleId)
  removed.forEach((item) => delete library.deliveries[item.id])
  writeLibrary(library)
  return { removed: removed.length }
}

export function recordPackageDelivery(id: string, start: number, end: number, completed: boolean) {
  const library = readLibrary()
  const item = library.packages.find((entry) => entry.id === id)
  if (!item) return
  const delivery = library.deliveries[id] ||= { requests: 0, bytesSent: 0, ranges: [] }
  delivery.requests += 1
  delivery.startedAt ||= Date.now()
  const ranges = [...delivery.ranges, { start, end }].sort((a, b) => a.start - b.start)
  delivery.ranges = ranges.reduce<Array<{ start: number; end: number }>>((merged, range) => { const previous = merged.at(-1); if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end); else merged.push({ ...range }); return merged }, [])
  delivery.bytesSent = delivery.ranges.reduce((total, range) => total + range.end - range.start + 1, 0)
  // GoldHEN/BGFT can request the package from byte 65536 onward: its bootstrap
  // chunk is obtained separately, so range coverage never starts at zero.
  if (completed || end >= item.size - 1 || delivery.bytesSent >= item.size) delivery.completedAt ||= Date.now()
  writeLibrary(library)
}

export function getPackageDelivery(id: string) {
  const item = getPackage(id)
  const library = readLibrary()
  const delivery = library.deliveries[id] || { requests: 0, bytesSent: 0, ranges: [] }
  // Upgrade deliveries recorded before the terminal-range rule was introduced.
  if (!delivery.completedAt && delivery.ranges.some((range) => range.end >= item.size - 1)) { delivery.completedAt = Date.now(); library.deliveries[id] = delivery; writeLibrary(library) }
  return { ...delivery, size: item.size }
}
