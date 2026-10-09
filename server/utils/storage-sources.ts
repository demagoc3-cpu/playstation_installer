import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, relative, isAbsolute } from 'node:path'
import { createError } from 'h3'
import type { StorageInput, StorageKind, StorageSource } from '../../shared/types/storage'
import { dataPath } from './data-path'
import { writeDurableJson } from './durable-json'
import { createStorageConnector, mountedStoragePath, normalizeStoragePath, type StorageConnector } from './storage-connector'
import { readStoragePassword, storageHasPassword, writeStoragePassword } from './storage-secrets'
import { activePackageTransfers, detachLibrarySource, librarySourceRoots, librarySourceSummary, scanPackageFolder } from './package-library'

interface StoredSource extends Omit<StorageSource, 'hasPassword'> { lastIndexAttemptAt?: number }
interface Registry { version: 1; sources: StoredSource[] }
const registryPath = () => dataPath('storage-sources.json')
const fail = (message: string, statusCode = 400) => createError({ statusCode, message })
const canonical = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
const terminal = ['installed', 'failed', 'skipped', 'cancelled', 'delivered']
const text = (input: unknown, length: number) => typeof input === 'string' && input.length <= length && !/[\x00-\x1f\x7f]/.test(input)

function readRegistry(): Registry {
  if (!existsSync(registryPath())) {
    const roots = librarySourceRoots()
    // Adopt known roots without rescanning or changing existing package IDs.
    const qbit = dataPath('qbittorrent.json')
    if (existsSync(qbit)) { try { const path = JSON.parse(readFileSync(qbit, 'utf8')).downloadPath; if (typeof path === 'string' && path && !roots.includes(path)) roots.push(path) } catch {} }
    const registry: Registry = { version: 1, sources: roots.map(path => blankSource('local', path, basename(path) || path)) }
    writeDurableJson(registryPath(), registry); return registry
  }
  try {
    const value = JSON.parse(readFileSync(registryPath(), 'utf8')) as Registry
    if (value.version !== 1 || !Array.isArray(value.sources) || !value.sources.every(item => /^[a-f0-9-]{36}$/.test(item.id) && ['local', 'smb', 'nfs', 'webdav'].includes(item.kind) && typeof item.path === 'string' && typeof item.localPath === 'string')) throw new Error()
    return value
  } catch { throw fail('Не удалось прочитать список хранилищ. Сохранённые данные не изменены', 503) }
}
function blankSource(kind: StorageKind, path: string, name: string): StoredSource {
  const id = randomUUID(), localPath = mountedStoragePath(id, kind, path)
  const summary = librarySourceSummary(path)
  return { id, kind, path, localPath, name, username: '', domain: '', enabled: true, autoIndex: false, indexIntervalMinutes: 60, state: 'unknown', message: '', packageCount: summary.packageCount, indexedBytes: summary.indexedBytes }
}
function put(source: StoredSource) { const r = readRegistry(), index = r.sources.findIndex(item => item.id === source.id); if (index < 0) r.sources.push(source); else r.sources[index] = source; writeDurableJson(registryPath(), r) }
function sourceById(id: string) { const item = readRegistry().sources.find(source => source.id === id); if (!item) throw fail('Хранилище не найдено', 404); return item }
function publicSource(source: StoredSource): StorageSource { const { lastIndexAttemptAt: _, ...publicValue } = source; return { ...publicValue, hasPassword: storageHasPassword(source.id) } }
function safeMessage(error: any) { return error?.statusCode && typeof error.message === 'string' ? error.message : 'Хранилище недоступно. Проверьте подключение и права доступа' }
function assertUnused(source: StoredSource) {
  if (activePackageTransfers()) throw fail('Дождитесь завершения передачи файлов перед отключением хранилища', 409)
  const ids = new Set(librarySourceSummary(source.localPath).packageIds)
  const files = [dataPath('installation-queue.json')]
  const dir = dataPath('consoles')
  if (existsSync(dir)) for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) for (const file of readdirSync(join(dir, entry.name))) if (file.endsWith('installation-queue.json')) files.push(join(dir, entry.name, file))
  for (const file of files) {
    if (!existsSync(file)) continue
    let queue: any
    try { queue = JSON.parse(readFileSync(file, 'utf8')) } catch { throw fail('Не удалось проверить задания. Отключение хранилища отложено', 409) }
    if (!Array.isArray(queue.items)) throw fail('Не удалось проверить задания. Отключение хранилища отложено', 409)
    if (queue.items.some((item: any) => ids.has(item.packageId) && !terminal.includes(item.state))) throw fail('Это хранилище используется незавершённой установкой', 409)
  }
}

export function createStorageManager(connector: StorageConnector = createStorageConnector()) {
  const jobs = new Map<string, Promise<void>>()
  const editing = new Set<string>()
  let ticking = false
  let firstTick = true
  async function work(id: string, indexing: boolean, force = false) {
    let source = sourceById(id)
    if (!source.enabled) return
    source.state = 'connecting'; source.message = ''; source.lastCheckedAt = Date.now(); if (indexing) source.lastIndexAttemptAt = Date.now(); put(source)
    try {
      await connector.connect(source, readStoragePassword(id))
      source = sourceById(id)
      if (indexing) {
        source.state = 'indexing'; source.lastIndexAttemptAt = Date.now(); put(source)
        const result = await scanPackageFolder(source.localPath, undefined, { strict: true, replaceRoot: true, force })
        source.lastIndexedAt = Date.now()
        const summary = librarySourceSummary(source.localPath)
        source.packageCount = summary.packageCount; source.indexedBytes = summary.indexedBytes
        source.message = `Индексация завершена: ${result.packages.length}`
      }
      else { const summary = librarySourceSummary(source.localPath); source.packageCount = summary.packageCount; source.indexedBytes = summary.indexedBytes }
      source.state = 'online'; source.lastCheckedAt = Date.now(); put(source)
    } catch (error) { source.state = 'offline'; source.message = safeMessage(error); source.lastCheckedAt = Date.now(); put(source) }
  }
  function start(id: string, indexing: boolean, force = false) {
    const source = sourceById(id)
    if (!source.enabled) throw fail('Сначала включите хранилище', 409)
    if (jobs.has(id) || editing.has(id)) throw fail('Подключение или индексация этого хранилища уже выполняется', 409)
    if (indexing) assertUnused(source)
    const promise = work(id, indexing, force).finally(() => jobs.delete(id))
    jobs.set(id, promise)
    return publicSource(sourceById(id))
  }
  return {
    list() { return { sources: readRegistry().sources.map(publicSource), platform: process.platform, docker: process.env.PACKAGEFLOW_DOCKER === '1' } },
    adoptLocal(path: string) {
      const normalized = normalizeStoragePath('local', path)
      const registry = readRegistry()
      const existing = registry.sources.find(item => {
        const tail = relative(item.localPath, normalized)
        return tail === '' || (!tail.startsWith('..') && !isAbsolute(tail))
      })
      if (existing) return publicSource(existing)
      const source = blankSource('local', normalized, basename(normalized) || normalized)
      source.state = 'unknown'; put(source)
      return publicSource(source)
    },
    async save(input: StorageInput) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || !['local', 'smb', 'nfs', 'webdav'].includes(input.kind || '')) throw fail('Выберите тип хранилища')
      if (['name', 'path', 'username', 'domain', 'password', 'id'].some(field => (input as any)[field] !== undefined && typeof (input as any)[field] !== 'string') || ['enabled', 'autoIndex', 'clearPassword'].some(field => (input as any)[field] !== undefined && typeof (input as any)[field] !== 'boolean')) throw fail('Проверьте параметры хранилища')
      const kind = input.kind!, path = normalizeStoragePath(kind, input.path || '')
      const name = (input.name || '').trim() || basename(path.replace(/\/$/, '')) || path
      if (!text(name, 100) || !text(input.username || '', 256) || !text(input.domain || '', 128) || !text(input.password || '', 4096)) throw fail('Проверьте название и данные доступа хранилища')
      const interval = input.indexIntervalMinutes ?? 60
      if (!Number.isInteger(interval) || interval < 5 || interval > 10080) throw fail('Интервал индексации: от 5 минут до 7 дней')
      const previous = input.id ? sourceById(input.id) : undefined
      if (previous && (jobs.has(previous.id) || editing.has(previous.id))) throw fail('Дождитесь завершения операции хранилища', 409)
      if (previous && (kind !== previous.kind || canonical(path) !== canonical(previous.path))) throw fail('Для другого пути добавьте отдельное хранилище')
      if (readRegistry().sources.some(item => item.id !== previous?.id && item.kind === kind && canonical(item.path) === canonical(path))) throw fail('Это хранилище уже добавлено', 409)
      const source = previous || blankSource(kind, path, name)
      const disconnect = previous && (input.enabled === false || input.password || input.clearPassword || source.username !== (input.username || '') || source.domain !== (input.domain || ''))
      if (disconnect) assertUnused(previous)
      editing.add(source.id)
      try {
      if (disconnect) await connector.disconnect(previous)
      source.name = name; source.username = kind === 'smb' || kind === 'webdav' ? (input.username || '') : ''; source.domain = kind === 'smb' ? (input.domain || '') : ''
      source.enabled = input.enabled !== false; source.autoIndex = input.autoIndex === true; source.indexIntervalMinutes = interval
      if (input.clearPassword) writeStoragePassword(source.id, null)
      else if (input.password) writeStoragePassword(source.id, input.password)
      source.state = source.enabled ? 'unknown' : 'disabled'; source.message = ''; put(source)
      editing.delete(source.id)
      if (source.enabled) start(source.id, !previous)
      return publicSource(sourceById(source.id))
      } finally { editing.delete(source.id) }
    },
    action(id: string, action: string) {
      if (!['connect', 'index', 'rebuild'].includes(action)) throw fail('Неизвестное действие хранилища')
      return start(id, action !== 'connect', action === 'rebuild')
    },
    async remove(id: string) {
      const source = sourceById(id)
      if (jobs.has(id) || editing.has(id)) throw fail('Дождитесь завершения операции хранилища', 409)
      assertUnused(source); editing.add(id)
      try {
      await connector.disconnect(source)
      detachLibrarySource(source.localPath)
      writeStoragePassword(id, null)
      const registry = readRegistry(); registry.sources = registry.sources.filter(item => item.id !== id); writeDurableJson(registryPath(), registry)
      return { removed: true }
      } finally { editing.delete(id) }
    },
    async settle(id?: string) { if (id) await jobs.get(id); else await Promise.all([...jobs.values()]) },
    async tick() {
      if (ticking) return
      ticking = true
      try {
        const initial = firstTick; firstTick = false
        const sources = readRegistry().sources.filter(item => item.enabled && !jobs.has(item.id) && !editing.has(item.id))
        // No list/pagination request probes sources. Background work is bounded
        // even if the registry contains thousands of NAS/local folders.
        for (let at = 0; at < sources.length; at += 2) await Promise.all(sources.slice(at, at + 2).map(async source => {
          if (!initial && Date.now() - (source.lastCheckedAt || 0) < 60000) return
          const due = source.autoIndex && Date.now() - Math.max(source.lastIndexedAt || 0, source.lastIndexAttemptAt || 0) >= source.indexIntervalMinutes * 60000
          try { start(source.id, due); await jobs.get(source.id) } catch {}
        }))
      } finally { ticking = false }
    },
    close() { connector.close() },
  }
}
export const storageManager = createStorageManager()
