import { readPs5ImageMetadata, readPs5FolderMetadata } from './ps5-content-metadata'
import { inConsoleScope, currentConsoleIp, legacyConsoleIp, consoleDeliveryKey } from './console-scope'
import { contentPlatform, contentFormat } from '../../shared/content-platform'
import type { ContentPlatform, ContentFormat, PackageSignature } from '../../shared/types/consoles'
import { dataPath } from './data-path'
import { logEvent } from './event-log'
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs'
import { open, readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, isAbsolute } from 'node:path'
import { readJsonFile as readJson, writeJsonFile as writeJson } from './json-store'
import { packageIdentity } from '../../shared/package-identity'

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
const siteLibraryPath = dataPath('package-library.json')

export interface LocalPackage {
  id: string
  platform?: ContentPlatform
  format?: ContentFormat
  signature?: PackageSignature
  sourceIds?: string[]
  title: string
  fileName: string
  size: number
  type: 'Игра' | 'Патч' | 'Бэкпорт' | 'DLC'
  titleId: string
  appVersion?: string
  masterVersion?: string
  requiredFirmware?: string
  sdkFirmware?: string
  packageVolume?: 'application' | 'patch' | 'add-on' | 'unknown'
  installOrder: number
  contentId: string
  contentType: string
  packageDigest: string
  iconSize: number
  libraryRoot: string
  installedAt?: number
}

interface PackageIcon { offset: number; size: number }
interface StoredPackage extends LocalPackage { path: string; sourceModifiedAt: number; coverPath?: string; icon: PackageIcon; sourceRoots?: string[]; aliasIds?: string[] }
interface DeliveryStatus { requests: number; bytesSent: number; ranges: Array<{ start: number; end: number }>; startedAt?: number; completedAt?: number; lastActivityAt?: number; partial?: boolean }
interface FolderCacheEntry { size: number; modifiedAt: number; item: StoredPackage }
interface FolderCache { version: 4; packages: Record<string, FolderCacheEntry> }
interface SiteLibrary { version: 2; packages: StoredPackage[]; deliveries: Record<string, DeliveryStatus>; installations?: Record<string, Record<string, number>> }

const blankLibrary = (): SiteLibrary => ({ version: 2, packages: [], deliveries: {} })
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32)
// PKG sources can be read-only (Docker bind mounts or NAS shares). Keep all
// generated files in the writable application data volume, separately per root.
const cacheDirectory = (root: string) => dataPath('package-cache', hash(root))
const cachePath = (root: string) => join(cacheDirectory(root), 'index.json')
const coversDirectory = (root: string) => join(cacheDirectory(root), 'covers')

// Delivery progress lives in memory: the PS4 fires many Range requests per
// package and persisting each one made Windows fail on locked files.
let deliveryCache: Record<string, DeliveryStatus> | undefined
let deliveryFlushTimer: ReturnType<typeof setTimeout> | undefined
let libraryFileCache: { stamp: string; library: SiteLibrary } | undefined

function readLibraryFile() {
  // Cover requests share the same index. Parsing thousands of records again
  // for every cover blocks the event loop; the file stamp detects external edits.
  let stamp: string
  try {
    const info = statSync(siteLibraryPath)
    stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.ino}`
  } catch { libraryFileCache = undefined; return blankLibrary() }
  if (libraryFileCache?.stamp === stamp) return libraryFileCache.library
  const library = readJson(siteLibraryPath, blankLibrary())
  const value = library.version === 2 ? library : blankLibrary()
  libraryFileCache = { stamp, library: value }
  return value
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
  libraryFileCache = undefined
  writeJson(siteLibraryPath, { ...library, deliveries: deliveries() })
}

function scheduleDeliveryFlush() {
  if (deliveryFlushTimer) return
  deliveryFlushTimer = setTimeout(() => {
    deliveryFlushTimer = undefined
    try { writeLibrary(readLibraryFile()) } catch (error) { logEvent('warn', 'Не удалось сохранить прогресс передачи:', error) }
  }, 1000)
}
function publicItem({ path: _, sourceModifiedAt: __, coverPath: ___, icon: ____, sourceRoots: _____, aliasIds: ______, ...item }: StoredPackage): LocalPackage {
  const ip = currentConsoleIp(), library = readLibraryFile()
  const installedAt = ip ? library.installations === undefined && ip === legacyConsoleIp() ? item.installedAt : library.installations?.[ip]?.[packageKey({ ...item, path: _, sourceModifiedAt: __ } as StoredPackage)] : item.installedAt
  return { ...item, platform: contentPlatform(item), format: contentFormat(item), signature: item.signature || 'unknown', installedAt }
}

const packageKey = (item: StoredPackage) => contentPlatform(item) === 'ps5' ? JSON.stringify(['ps5', resolve(item.path), contentFormat(item), item.contentId, item.appVersion, item.size, item.sourceModifiedAt]) : packageIdentity(item) || `path:${resolve(item.path)}`
function packageGroups(items: StoredPackage[]) {
  const groups = new Map<string, StoredPackage[]>()
  for (const item of items) {
    const key = packageKey(item)
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }
  return groups
}
/** Keep the first indexed ID stable; other paths remain usable as fallbacks
 * and old URLs, torrent indexes and accepted installation jobs stay valid. */
function availablePackage(group: StoredPackage[], id = group[0]!.id) {
  const source = group.find(item => item.id === id && existsSync(item.path)) || group.find(item => existsSync(item.path))
  if (!source) return undefined
  const installedAt = Math.max(0, ...group.map(item => item.installedAt || 0)) || undefined
  const cover = [source, ...group].find(item => item.coverPath && existsSync(item.coverPath))
  return { ...source, id, installedAt, coverPath: cover?.coverPath, sourceIds: [...new Set(group.flatMap(storedIds))] }
}

interface PackageReader {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  stat(): Promise<{ size: number }>
}
async function findSfoOffset(handle: PackageReader, header: Buffer) {
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

async function packageEntries(handle: PackageReader, header: Buffer, fileSize: number) {
  const count = header.readUInt32BE(0x10)
  const tableOffset = header.readUInt32BE(0x18)
  if (!count || count > 4096 || tableOffset < 0x20 || tableOffset + count * 0x20 > fileSize) return []
  const table = Buffer.alloc(count * 0x20)
  const { bytesRead } = await handle.read(table, 0, table.length, tableOffset)
  if (bytesRead !== table.length) return []
  const entries: Array<{ id: number; offset: number; size: number }> = []
  for (let index = 0; index < count; index++) {
    const position = index * 0x20
    const offset = table.readUInt32BE(position + 0x10)
    const size = table.readUInt32BE(position + 0x14)
    if (offset && size && offset + size <= fileSize) entries.push({ id: table.readUInt32BE(position), offset, size })
  }
  return entries
}

function volumeType(header: Buffer): LocalPackage['packageVolume'] {
  const contentType = header.readUInt32BE(0x74)
  const flags = header.readUInt32BE(0x78)
  if (contentType === 0x1b || contentType === 0x1c) return 'add-on'
  if (contentType !== 0x1a) return 'unknown'
  // Remaster contains the base game despite also carrying patch flags.
  if (flags & 0x00400000) return 'application'
  return flags & 0x60100000 ? 'patch' : 'application'
}

function packedFirmware(value: string, allowZero = false) {
  const match = /^(\d{2})(\d{2})[0-9a-fA-F]{4}$/.exec(value)
  if (!match) return undefined
  const major = Number(match[1]), minor = Number(match[2])
  return major || minor || allowZero ? `${major}.${match[2]}` : undefined
}

function parseSfo(data: Buffer) {
  if (!data.subarray(0, 4).equals(SFO_MAGIC) || data.length < 20) throw new Error('PARAM.SFO не найден')
  const keyTable = data.readUInt32LE(8)
  const dataTable = data.readUInt32LE(12)
  const count = data.readUInt32LE(16)
  const values = new Map<string, string>()
  let requiredFirmware: string | undefined
  for (let index = 0; index < count; index++) {
    const entry = 20 + index * 16
    if (entry + 16 > data.length) break
    const keyStart = keyTable + data.readUInt16LE(entry)
    const length = data.readUInt32LE(entry + 4)
    const valueStart = dataTable + data.readUInt32LE(entry + 12)
    if (keyStart >= data.length || valueStart + length > data.length) continue
    const keyEnd = data.indexOf(0, keyStart)
    const key = data.subarray(keyStart, keyEnd < 0 ? data.length : keyEnd).toString('utf8')
    const value = data.subarray(valueStart, valueStart + length)
    if (key === 'SYSTEM_VER') requiredFirmware = value.length === 4
      ? packedFirmware(value.readUInt32LE(0).toString(16).padStart(8, '0'), true)
      : packedFirmware(value.toString('utf8').replace(/\0/g, '').replace(/^0x/i, '').trim(), true)
    values.set(key, value.toString('utf8').replace(/\0/g, '').trim())
  }
  return { values, requiredFirmware }
}

function extractIconEntry(entries: ReturnType<typeof packageEntries>): PackageIcon {
  const icon = entries.find((entry) => entry.id === 0x1200)
  return icon && icon.size <= 2 * 1024 * 1024 ? { offset: icon.offset, size: icon.size } : { offset: 0, size: 0 }
}

export async function readPackageMetadata(path: string, fileName: string) {
  const handle = await open(path, 'r')
  try { return await readPackageMetadataFromReader(handle, fileName) }
  finally { await handle.close() }
}
/** Bounded reads allow the same parser to inspect a PKG on PS4 without downloading it. */
export async function readPackageMetadataFromReader(handle: PackageReader, fileName: string) {
    const header = Buffer.alloc(HEADER_BYTES)
    const { bytesRead: headerBytes } = await handle.read(header, 0, header.length, 0)
    const data = header.subarray(0, headerBytes)
    if (data.length < 0x1000 || !data.subarray(0, 4).equals(PKG_MAGIC)) throw new Error('Некорректный заголовок PKG')
    const entries = await packageEntries(handle, data, (await handle.stat()).size)
    const sfoEntry = entries.find((entry) => entry.id === 0x1000 && entry.size <= SFO_BYTES)
    const sfoOffset = sfoEntry?.offset ?? await findSfoOffset(handle, data)
    if (sfoOffset < 0) throw new Error('PARAM.SFO не найден в PKG')
    const sfo = Buffer.alloc(sfoEntry?.size || SFO_BYTES)
    const { bytesRead: sfoBytes } = await handle.read(sfo, 0, sfo.length, sfoOffset)
    const { values, requiredFirmware } = parseSfo(sfo.subarray(0, sfoBytes))
    const category = values.get('CATEGORY') || ''
    const contentId = values.get('CONTENT_ID') || ''
    if (!category || !contentId) throw new Error('В PARAM.SFO отсутствуют CATEGORY или CONTENT_ID')
    const title = values.get('TITLE') || basename(fileName, extname(fileName)).replace(/[._-]/g, ' ')
    const titleId = values.get('TITLE_ID') || contentId.match(/CUSA\d{5}/i)?.[0]?.toUpperCase() || contentId
    const headerContentType = data.readUInt32BE(0x74)
    const isDlc = category === 'ac' || category === 'al' || headerContentType === 0x1b || headerContentType === 0x1c
    const isBackport = !isDlc && /backport/i.test(`${fileName} ${title}`)
    const type: LocalPackage['type'] = isDlc ? 'DLC' : isBackport ? 'Бэкпорт' : category.startsWith('gp') ? 'Патч' : 'Игра'
    const icon = extractIconEntry(entries)
    const sdkFirmware = packedFirmware(values.get('PUBTOOLINFO')?.match(/(?:^|[,\s])sdk_ver=([0-9a-fA-F]{8})(?:[,\s]|$)/i)?.[1] || '')
    const contentType = headerContentType === 0x1c ? 'PS4AL' : headerContentType === 0x1b ? 'PS4AC' : `PS4${category.toUpperCase()}`
    return { platform: 'ps4' as const, format: 'pkg' as const, signature: 'unknown' as const, title, titleId, appVersion: values.get('APP_VER') || '', masterVersion: values.get('VERSION') || '', requiredFirmware, sdkFirmware, packageVolume: volumeType(data), installOrder: isDlc ? 2 : type === 'Игра' ? 0 : 1, contentId, contentType, packageDigest: data.subarray(0xfe0, 0x1000).toString('hex').toUpperCase(), icon, iconSize: icon.size, type }
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

async function cachePs5Cover(root: string, id: string, cover?: Buffer) {
  if (!cover || cover.length > 2 * 1024 * 1024 || !cover.subarray(0, 8).equals(PNG_MAGIC)) return undefined
  const path = join(coversDirectory(root), `${id}.png`); mkdirSync(dirname(path), { recursive: true }); await writeFile(path, cover); return path
}

function scanReadError(error: any, strict: boolean) {
  if (strict && ['EACCES', 'EPERM', 'EIO', 'ESTALE', 'ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOENT', 'ENOTDIR', 'EBADF', 'ENODEV', 'ENXIO', 'EREMOTEIO'].includes(error?.code)) throw createError({ statusCode: 503, message: `Ошибка чтения хранилища (${error.code}). Предыдущий индекс сохранён` })
  return undefined
}
const storedIds = (item: StoredPackage) => [...new Set([item.id, ...(item.aliasIds || [])])]
const matchesId = (item: StoredPackage, id: string) => storedIds(item).includes(id)
/** Carry accepted IDs to an identical remaining source after a successful prune. */
function retainSourceIds(previous: StoredPackage[], remaining: StoredPackage[]) {
  const before = packageGroups(previous), after = packageGroups(remaining)
  for (const [key, group] of after) {
    const old = before.get(key)
    if (!old) continue
    const first = group[0]!, id = old[0]!.id
    first.aliasIds = [...new Set([...storedIds(first), ...old.flatMap(storedIds)])].filter(value => value !== id)
    first.id = id
    first.installedAt = Math.max(0, ...old.map(item=>item.installedAt || 0), ...group.map(item=>item.installedAt || 0)) || undefined
  }
  return remaining
}

async function walk(directory: string, root: string, cache: FolderCache, found: StoredPackage[], oldItems: Map<string, StoredPackage>, strict = false): Promise<void> {
  const probe = async (file: string) => Boolean(await stat(file).catch(error => { if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') scanReadError(error, strict); return undefined }))
  if (await probe(join(directory, 'sce_sys', 'param.json')) && await probe(join(directory, 'eboot.bin'))) {
    try {
      const metadata = await readPs5FolderMetadata(directory), id = hash(directory), coverPath = await cachePs5Cover(root, id, metadata.cover)
      const { cover: _, modifiedAt, ...properties } = metadata
      found.push({ ...properties, id, path: directory, fileName: basename(directory), libraryRoot: root, sourceModifiedAt: modifiedAt, icon: { offset: 0, size: coverPath ? metadata.cover!.length : 0 }, iconSize: coverPath ? metadata.cover!.length : 0, coverPath })
    } catch (error) { scanReadError(error, strict); logEvent('warn', `Пропущена папка PS5 ${directory}`, error) }
    return
  }
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch (error) {
    if (strict) throw createError({ statusCode: 503, message: 'Не удалось прочитать всё хранилище. Предыдущий индекс сохранён' })
    if (directory === root) throw createError({ statusCode: 403, message: `Нет доступа к содержимому папки ${root}. Проверьте права чтения и подключение папки к контейнеру.` })
    logEvent('warn', `Пропущена недоступная папка ${directory}`, error)
    return
  }
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) { if (entry.name !== '.packageflow') await walk(path, root, cache, found, oldItems, strict); continue }
    if (!entry.isFile() || !/\.(pkg|fpkg|ffpkg|ufs2|exfat|pfs|ffpfs|ffpfsc)$/i.test(entry.name)) continue
    const info = await stat(path).catch(() => undefined)
    if (!info) { if (strict) throw createError({ statusCode: 503, message: 'Файл хранилища недоступен. Предыдущий индекс сохранён' }); continue }
    const key = relative(root, path)
    const cached = cache.packages[key]
    if (cached?.size === info.size && cached.modifiedAt === info.mtimeMs && (!cached.item.coverPath || existsSync(cached.item.coverPath))) {
      found.push({ ...cached.item, libraryRoot: root, installedAt: oldItems.get(cached.item.id)?.installedAt })
      continue
    }
    const id = hash(path)
    let metadata: (Omit<LocalPackage, 'id' | 'fileName' | 'size' | 'libraryRoot'> & { icon: PackageIcon }) | undefined = await readPackageMetadata(path, entry.name).catch(error => scanReadError(error, strict))
    let ps5Cover: string | undefined
    if (!metadata) {
      const value = await readPs5ImageMetadata(path).catch(error => scanReadError(error, strict))
      if (value) { const { cover, ...properties } = value; ps5Cover = await cachePs5Cover(root, id, cover); metadata = { ...properties, icon: { offset: 0, size: ps5Cover ? cover!.length : 0 }, iconSize: ps5Cover ? cover!.length : 0 } }
    }
    if (!metadata) continue
    const coverPath = ps5Cover || (metadata.icon.size ? join(coversDirectory(root), `${id}.png`) : undefined)
    if (coverPath && !ps5Cover) { mkdirSync(dirname(coverPath), { recursive: true }); await writeCover(path, metadata.icon, coverPath).catch(() => undefined) }
    const item: StoredPackage = { id, path, fileName: entry.name, size: info.size, libraryRoot: root, sourceModifiedAt: info.mtimeMs, coverPath, ...metadata }
    const previous = oldItems.get(id)
    if (previous && packageKey(previous) === packageKey(item)) item.installedAt = previous.installedAt
    cache.packages[key] = { size: info.size, modifiedAt: info.mtimeMs, item }
    found.push(item)
    if (found.length % 12 === 0) await new Promise<void>((done) => setImmediate(done))
  }
}

export async function scanPackageFolder(directory: string, onlyTitleId?: string, options: { force?: boolean; replaceRoot?: boolean; strict?: boolean } = {}) {
  if (!directory?.trim()) throw createError({ statusCode: 400, message: 'Укажите путь к папке с пакетами' })
  const root = resolve(directory.trim())
  const rootInfo = await stat(root).catch(() => undefined)
  if (!rootInfo?.isDirectory()) throw createError({ statusCode: 404, message: 'Папка не найдена или недоступна' })
  const previousCache = readJson<FolderCache>(cachePath(root), { version: 4, packages: {} })
  const cache: FolderCache = !options.force && previousCache.version === 4 ? previousCache : { version: 4, packages: {} }
  const siteLibrary = readLibrary()
  const oldItems = new Map(siteLibrary.packages.map((item) => [item.id, item]))
  const found: StoredPackage[] = []
  await walk(root, root, cache, found, oldItems, options.strict)
  writeJson(cachePath(root), cache)
  // Re-read after asynchronous scanning so concurrent install confirmations
  // are preserved. Replacing entries in place keeps canonical IDs stable.
  const latest = readLibrary()
  const replacements = new Map(found.map(item => [item.path, item]))
  const seen = new Set<string>()
  const merged: StoredPackage[] = []
  for (const previous of latest.packages) {
    if (seen.has(previous.path)) continue
    seen.add(previous.path)
    const item = replacements.get(previous.path)
    const roots = previous.sourceRoots || [previous.libraryRoot]
    if (!item && options.replaceRoot && roots.some(path=>rootInside(root, path))) {
      const remaining = roots.filter(value => !rootInside(root, value))
      if (remaining.length) merged.push({ ...previous, sourceRoots: remaining, libraryRoot: remaining[0]! })
      continue
    }
    merged.push(item ? { ...item, id: previous.id, aliasIds: previous.aliasIds, sourceRoots: [...new Set([...roots, root])], installedAt: packageKey(previous) === packageKey(item) ? previous.installedAt : undefined } : previous)
  }
  for (const item of found) if (!seen.has(item.path)) { merged.push({ ...item, sourceRoots: [root] }); seen.add(item.path) }
  latest.packages = retainSourceIds(latest.packages, merged)
  writeLibrary(latest)
  const keys = new Set(found.map(packageKey))
  const packages = [...packageGroups(merged)].filter(([key, group]) => onlyTitleId ? group[0]!.titleId === onlyTitleId : keys.has(key))
    .map(([, group]) => publicItem({ ...group[0]!, sourceIds: [...new Set(group.flatMap(storedIds))], installedAt: Math.max(0, ...group.map(item=>item.installedAt || 0)) || undefined }))
  return { directory: root, packages }
}

/** Registry migration and source statistics use only the persisted index. */
export function librarySourceRoots() { return [...new Set(readLibraryFile().packages.flatMap(item => item.sourceRoots || [item.libraryRoot]).filter(Boolean))] }
function rootInside(root: string, path: string) { const tail = relative(root, path); return tail === '' || (!tail.startsWith('..') && !isAbsolute(tail)) }
export function librarySourceSummary(root: string) {
  const items = readLibraryFile().packages.filter(item => (item.sourceRoots || [item.libraryRoot]).some(path=>rootInside(root, path)))
  return { packageCount: items.length, indexedBytes: items.reduce((sum, item) => sum + item.size, 0), packageIds: items.flatMap(storedIds) }
}
export function detachLibrarySource(root: string) {
  const library = readLibrary(), previous = library.packages
  library.packages = library.packages.flatMap(item => {
    const roots = item.sourceRoots || [item.libraryRoot]
    const remaining = roots.filter(path=>!rootInside(root, path))
    if (remaining.length === roots.length) return [item]
    return remaining.length ? [{ ...item, sourceRoots: remaining, libraryRoot: remaining[0]! }] : []
  })
  library.packages = retainSourceIds(previous, library.packages)
  writeLibrary(library)
}

/** Register one internally verified package without scanning its staging directory. */
export async function registerPackageFile(file: string) {
  const path = resolve(file); const root = dirname(path); const name = basename(path)
  const info = await stat(path); const metadata = await readPackageMetadata(path, name)
  const id = hash(path)
  const coverPath = metadata.icon.size ? join(coversDirectory(root), `${id}.png`) : undefined
  if (coverPath) { mkdirSync(dirname(coverPath), { recursive: true }); await writeCover(path, metadata.icon, coverPath) }
  const item: StoredPackage = { id, path, fileName: name, size: info.size, libraryRoot: root, sourceModifiedAt: info.mtimeMs, coverPath, ...metadata }
  const library = readLibrary()
  const index = library.packages.findIndex(previous => previous.path === path)
  if (index >= 0) { const previous = library.packages[index]!; if (packageKey(previous) === packageKey(item)) item.installedAt = previous.installedAt; library.packages[index] = item }
  else library.packages.push(item)
  writeLibrary(library)
  return publicItem(item)
}

export function getLibraryPackages(ip?: string): LocalPackage[] {
  if (ip && ip !== currentConsoleIp()) return inConsoleScope(ip, () => getLibraryPackages())
  // Display/search/pagination use the last scan's index. Probing every source
  // (especially SMB paths) synchronously per page blocks all HTTP responses.
  // getPackage/open/stat still validate the selected source before delivery;
  // rescanning updates the index when files are added, removed or disconnected.
  return [...packageGroups(readLibrary().packages).values()].map(group => {
    const source = group[0]!, cover = group.find(item => item.coverPath && item.iconSize > 0)
    const installedAt = Math.max(0, ...group.map(item => item.installedAt || 0)) || undefined
    return publicItem({ ...source, installedAt, coverPath: cover?.coverPath,
      iconSize: cover?.iconSize || 0, sourceIds: [...new Set(group.flatMap(storedIds))] })
  })
}
/** Compact badges for an already loaded page; no source-file scan per device. */
export function installedPackageIdsForConsole(ip: string, packageIds: string[]) {
  const library=readLibraryFile(), visible=new Set(packageIds), legacy=legacyConsoleIp()
  return library.packages.filter(item=>storedIds(item).some(id=>visible.has(id)) && (library.installations === undefined && ip === legacy ? item.installedAt : library.installations?.[ip]?.[packageKey(item)])).flatMap(item=>storedIds(item).filter(id=>visible.has(id)))
}
export function getDeliveredPackageIds() {
  const ip = currentConsoleIp(), prefix = ip ? `${ip}:` : ''
  return new Set(Object.entries(deliveries()).filter(([id, status]) => status.completedAt && (prefix ? id.startsWith(prefix) : !id.includes(':'))).map(([id]) => prefix ? id.slice(prefix.length) : id))
}
export function getPackage(id: string) {
  const packages = readLibrary().packages, original = packages.find(item => matchesId(item, id))
  const item = original && availablePackage(packages.filter(item => packageKey(item) === packageKey(original)), id)
  if (!item) throw createError({ statusCode: 404, message: 'Пакет не найден. Просканируйте папку повторно.' })
  return item
}
export function getPackageStream(id: string, options?: { start?: number; end?: number }) { const item = getPackage(id); return { item, stream: createReadStream(item.path, options) } }
function indexedPackageCover(id: string) {
  const packages = readLibraryFile().packages, original = packages.find(item => matchesId(item, id))
  if (!original) return undefined
  // Cached artwork is independent of the large original package. A NAS source
  // being asleep must not stall the icon HTTP route or force a source rescan.
  return packages.find(item => packageKey(item) === packageKey(original) && item.coverPath && item.iconSize > 0)?.coverPath
}
export function getPackageIconStream(id: string) {
  const cover = indexedPackageCover(id)
  let size = 0
  try { if (cover) { const info = statSync(cover); if (info.isFile()) size = info.size } } catch { /* Missing cache uses a placeholder. */ }
  if (!cover || size < PNG_MAGIC.length || size > 2 * 1024 * 1024) throw createError({ statusCode: 404, message: 'Кэш обложки не найден. Пересканируйте папку.' })
  return createReadStream(cover)
}
export async function readPackageIcon(id: string) {
  const cover = indexedPackageCover(id)
  if (!cover) return undefined
  const data = await readFile(cover).catch(() => undefined)
  return data && data.length >= PNG_MAGIC.length && data.length <= 2 * 1024 * 1024 ? data : undefined
}

// Packages whose installation was cancelled: the console may keep retrying the
// BGFT job, so their data is refused until the package is dispatched again.
const blockedDeliveries = new Set<string>()
const activeTransfers = new Map<string, Set<() => void>>()
export function activePackageTransfers() { return [...activeTransfers.values()].some(transfers => transfers.size > 0) }

/** Registers a running HTTP transfer so a cancel can cut it; returns an unregister function. */
export function registerActiveTransfer(id: string, abort: () => void) {
  const key = consoleDeliveryKey(id)
  const transfers = activeTransfers.get(key) || new Set<() => void>()
  transfers.add(abort)
  activeTransfers.set(key, transfers)
  touchDelivery(id)
  return () => { transfers.delete(abort); if (!transfers.size) activeTransfers.delete(key); touchDelivery(id) }
}

export function isDeliveryBlocked(id: string) { return blockedDeliveries.has(consoleDeliveryKey(id)) }

/** Refuses further PS4 requests for the package and drops transfers in progress. */
export function blockPackageDelivery(id: string) {
  const key = consoleDeliveryKey(id)
  blockedDeliveries.add(key)
  for (const abort of [...(activeTransfers.get(key) || [])]) { try { abort() } catch { /* already closed */ } }
  activeTransfers.delete(key)
}

/** Starts a fresh, independently observable HTTP delivery for a new PS4 job. */
export function resetPackageDelivery(id: string) {
  blockedDeliveries.delete(consoleDeliveryKey(id))
  const library = readLibrary()
  if (!library.packages.some((item) => matchesId(item, id))) throw createError({ statusCode: 404, message: 'Пакет не найден' })
  delete library.deliveries[consoleDeliveryKey(id)]
  writeLibrary(library)
}

function ensureConsoleInstallations(library: SiteLibrary) {
  if (!library.installations) {
    library.installations = {}
    const owner = legacyConsoleIp()
    if (owner) library.installations[owner] = Object.fromEntries(library.packages.filter(item => item.installedAt).map(item => [packageKey(item), item.installedAt!]))
  }
  return library.installations
}

export function markPackageInstalled(id: string, installed: boolean, ip?: string): LocalPackage {
  if (ip && ip !== currentConsoleIp()) return inConsoleScope(ip, () => markPackageInstalled(id, installed))
  const library = readLibrary()
  const item = library.packages.find((entry) => matchesId(entry, id))
  if (!item) throw createError({ statusCode: 404, message: 'Пакет не найден' })
  const target = currentConsoleIp()
  if (target) {
    const states = ensureConsoleInstallations(library), state = states[target] ||= {}
    if (installed && (item.packageVolume === 'patch' || item.contentType === 'PS4GP')) for (const other of library.packages) if (other.titleId === item.titleId && contentPlatform(other) === contentPlatform(item) && (other.packageVolume === 'patch' || other.contentType === 'PS4GP')) delete state[packageKey(other)]
    if (installed) state[packageKey(item)] = Date.now(); else delete state[packageKey(item)]
    writeLibrary(library); return publicItem(item)
  }
  if (installed && item.contentType === 'PS4GP') {
    for (const other of library.packages) {
      if (other.id !== id && other.titleId === item.titleId && other.contentType === 'PS4GP') other.installedAt = undefined
    }
  }
  const key = packageKey(item), installedAt = installed ? Date.now() : undefined
  for (const other of library.packages) if (packageKey(other) === key) other.installedAt = installedAt
  writeLibrary(library)
  return publicItem(item)
}

export function clearConsoleInstallation(titleId: string, kind: string, componentId: string, ip?: string): string[] {
  if (ip && ip !== currentConsoleIp()) return inConsoleScope(ip, () => clearConsoleInstallation(titleId, kind, componentId))
  const library = readLibrary(); const affected: string[] = []
  for (const item of library.packages) {
    if (item.titleId !== titleId) continue
    if (kind === 'game' || (kind === 'patch' && item.contentType === 'PS4GP') ||
      (['dlc', 'dlcs'].includes(kind) && item.type === 'DLC' && (kind === 'dlcs' || item.contentId.slice(20) === componentId))) { if (currentConsoleIp()) delete (ensureConsoleInstallations(library)[currentConsoleIp()!] ||= {})[packageKey(item)]; else item.installedAt = undefined; affected.push(item.id) }
  }
  writeLibrary(library); return affected
}

export function removePackageFromLibrary(id: string) {
  const library = readLibrary()
  const original = library.packages.find(item => matchesId(item, id))
  if (!original) throw createError({ statusCode: 404, message: 'Пакет не найден' })
  const key = packageKey(original)
  const removed = library.packages.filter(item => packageKey(item) === key)
  library.packages = library.packages.filter(item => packageKey(item) !== key)
  for (const item of removed) delete library.deliveries[item.id]
  writeLibrary(library)
}

export function removePackageBranch(titleId: string, platform?: string) {
  const library = readLibrary()
  const removed = library.packages.filter(item => item.titleId === titleId && (!platform || contentPlatform(item) === platform))
  if (!removed.length) throw createError({ statusCode: 404, message: 'Ветка игры не найдена' })
  const ids = new Set(removed.map(item => item.id))
  library.packages = library.packages.filter(item => !ids.has(item.id))
  removed.forEach((item) => delete library.deliveries[item.id])
  writeLibrary(library)
  return { removed: removed.length }
}

/** Any request from the console (manifest or data) proves it accepted the job. */
export function recordPackageRequest(id: string) {
  const delivery = deliveries()[consoleDeliveryKey(id)] ||= { requests: 0, bytesSent: 0, ranges: [] }
  delivery.requests += 1
  delivery.startedAt ||= Date.now()
  delivery.lastActivityAt = Date.now()
  scheduleDeliveryFlush()
}

function touchDelivery(id: string) { const delivery = deliveries()[consoleDeliveryKey(id)]; if (delivery) delivery.lastActivityAt = Date.now() }

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
  if (contentPlatform(item) !== 'ps4' || contentFormat(item) !== 'pkg') return end
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
  if (contentFormat(item) === 'folder') return false
  if (delivery.completedAt) return false
  const end = requiredEnd(item)
  const ps4Pkg = contentPlatform(item) === 'ps4' && contentFormat(item) === 'pkg'
  if (covers(delivery.ranges, ps4Pkg ? Math.min(BOOTSTRAP_BYTES, end - 1) : 0, end - 1) || delivery.bytesSent >= item.size) {
    delivery.completedAt = Date.now()
    return true
  }
  const quiet = delivery.lastActivityAt && Date.now() - delivery.lastActivityAt >= IDLE_COMPLETE_MS
  if (ps4Pkg && delivery.bytesSent > 0 && quiet && !activeTransfers.has(consoleDeliveryKey(item.id))) {
    delivery.completedAt = Date.now()
    delivery.partial = true
    return true
  }
  return false
}

/** Called repeatedly while a range streams, so large ranges show progress before they finish. */
export function recordPackageDelivery(id: string, start: number, end: number, completed: boolean) {
  if (end < start) return
  const item = readLibraryFile().packages.find((entry) => matchesId(entry, id))
  if (!item) return
  const delivery = deliveries()[consoleDeliveryKey(id)] ||= { requests: 0, bytesSent: 0, ranges: [] }
  delivery.startedAt ||= Date.now()
  delivery.lastActivityAt = Date.now()
  const ranges = [...delivery.ranges, { start, end }].sort((a, b) => a.start - b.start)
  delivery.ranges = ranges.reduce<Array<{ start: number; end: number }>>((merged, range) => { const previous = merged.at(-1); if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end); else merged.push({ ...range }); return merged }, [])
  delivery.bytesSent = delivery.ranges.reduce((total, range) => total + range.end - range.start + 1, 0)
  if (completed && start === 0 && end >= item.size - 1) delivery.completedAt ||= Date.now()
  else settleDelivery(item, delivery)
  scheduleDeliveryFlush()
}

export function getPackageDelivery(id: string) {
  const item = getPackage(id)
  const delivery = deliveries()[consoleDeliveryKey(id)] || { requests: 0, bytesSent: 0, ranges: [] }
  if (settleDelivery(item, delivery)) { deliveries()[consoleDeliveryKey(id)] = delivery; scheduleDeliveryFlush() }
  return { ...delivery, size: item.size, requiredSize: requiredEnd(item) }
}
