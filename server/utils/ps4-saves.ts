import { createError } from 'h3'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { resolve } from 'node:path'
import { getConsoleCatalog } from './ps4-console-apps'
import { authenticatedServiceRequest, consoleFileRead, consoleFileRequest, consoleFileWrite } from './ps4-service-installer'
import { consoleRuntime } from './console-control'
import { getLibraryPackages } from './package-library'
import { readSaveBackup, saveBackupRoot } from './save-backup-store'

const userIdPattern = /^[0-9a-f]{8}$/i
const titleIdPattern = /^[A-Z0-9]{9}$/
const safeName = /^[^/\\\x00-\x1f\x7f]+$/

interface FileEntry { name: string; type: 'file' | 'directory' | 'link'; size: number; mtime: number }
interface FilePage { entries: FileEntry[]; nextOffset: number; hasMore: boolean }

export interface SaveTitle { titleId: string; title: string; installed: boolean | null }
export interface SaveUser { userId: string; games: SaveTitle[] }
export interface SaveSlot { name: string; containerBytes: number; modifiedAt: number }

function validUser(value: unknown): string {
  if (typeof value !== 'string' || !userIdPattern.test(value))
    throw createError({ statusCode: 400, message: 'Неверный профиль PS4' })
  return value.toLowerCase()
}
function validTitle(value: unknown): string {
  if (typeof value !== 'string' || !titleIdPattern.test(value))
    throw createError({ statusCode: 400, message: 'Неверный код игры' })
  return value
}
function invalidResponse(): never {
  throw createError({ statusCode: 502, message: 'PS4 вернула неполный список сохранений' })
}
async function directory(ip: string, path: string, limit: number): Promise<FileEntry[]> {
  const all: FileEntry[] = []
  let offset = 0
  let pages = 0
  for (;;) {
    if (++pages > Math.ceil(limit / 32) + 2) invalidResponse()
    const page = await consoleFileRequest(ip, 'list', { path, offset }) as FilePage
    if (!page || !Array.isArray(page.entries) || typeof page.hasMore !== 'boolean' ||
      !Number.isSafeInteger(page.nextOffset) || page.nextOffset < offset || page.entries.length > 32) invalidResponse()
    for (const entry of page.entries) {
      if (!entry || typeof entry.name !== 'string' || !safeName.test(entry.name) || !['file', 'directory', 'link'].includes(entry.type) ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 || !Number.isSafeInteger(entry.mtime) || entry.mtime < 0) invalidResponse()
      all.push(entry)
    }
    if (all.length > limit) throw createError({ statusCode: 409, message: 'Слишком много сохранений для одного списка' })
    if (!page.hasMore) return all
    if (page.nextOffset <= offset) invalidResponse()
    offset = page.nextOffset
  }
}
function missing(error: unknown): boolean { return (error as { statusCode?: number })?.statusCode === 404 }

export async function listSaveUsers(ip: string): Promise<SaveUser[]> {
  const profiles = (await directory(ip, '/user/home', 32))
    .filter(entry => entry.type === 'directory' && userIdPattern.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  const titles = new Map<string, string>()
  for (const pkg of getLibraryPackages()) if (pkg.contentType === 'PS4GD' && pkg.title && titleIdPattern.test(pkg.titleId))
    titles.set(pkg.titleId, pkg.title)
  const installed = new Set<string>()
  let catalogComplete = false
  try {
    const catalog = await getConsoleCatalog(ip)
    catalogComplete = catalog.complete
    for (const game of catalog.apps) { titles.set(game.titleId, game.title); installed.add(game.titleId) }
  } catch { /* Saves remain visible if the installed-app catalog is unavailable. */ }
  const users: SaveUser[] = []
  for (const profile of profiles) {
    let entries: FileEntry[]
    try { entries = await directory(ip, `/user/home/${profile.name}/savedata`, 1024) }
    catch (error) { if (!missing(error)) throw error; entries = [] }
    const games = entries.filter(entry => entry.type === 'directory' && titleIdPattern.test(entry.name))
      .map(entry => ({ titleId: entry.name, title: titles.get(entry.name) || entry.name, installed: installed.has(entry.name) ? true : catalogComplete ? false : null }))
      .sort((a, b) => a.title.localeCompare(b.title, 'ru'))
    users.push({ userId: profile.name.toLowerCase(), games })
  }
  return users
}

export async function listSaveSlots(ip: string, rawUserId: unknown, rawTitleId: unknown): Promise<SaveSlot[]> {
  const userId = validUser(rawUserId), titleId = validTitle(rawTitleId)
  const entries = await directory(ip, `/user/home/${userId}/savedata/${titleId}`, 1024)
  const keys = new Set(entries.filter(entry => entry.type === 'file' && entry.name.endsWith('.bin')).map(entry => entry.name))
  return entries.filter(entry => entry.type === 'file' && entry.name.startsWith('sdimg_') &&
      entry.name.length > 6 && !entry.name.startsWith('sdimg_sce_bu_') && keys.has(`${entry.name.slice(6)}.bin`))
    .map(entry => ({ name: entry.name.slice(6), containerBytes: entry.size, modifiedAt: entry.mtime }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

interface StagedExport { path: string; files: number; bytes: number }
interface BackupFile { path: string; bytes: number; sha256: string }

/** Copy an already mounted and unmounted read-only export from PS4 /data to WEB.
 * The local directory is only published by metadata.json after all hashes match. */
export async function createSaveBackup(ip: string, rawUserId: unknown, rawTitleId: unknown, rawSlot: unknown, internal = false) {
  const userId = validUser(rawUserId), titleId = validTitle(rawTitleId)
  if (typeof rawSlot !== 'string' || !/^[A-Za-z0-9_-]{1,31}$/.test(rawSlot))
    throw createError({ statusCode: 400, message: 'Неверное имя сохранения' })
  const slots = await listSaveSlots(ip, userId, titleId)
  if (!slots.some(slot => slot.name === rawSlot)) throw createError({ statusCode: 404, message: 'Сохранение больше не найдено на PS4' })
  const catalog = await getConsoleCatalog(ip)
  if (catalog.apps.some(app => app.titleId === titleId)) {
    const runtime = await consoleRuntime(ip, titleId)
    if (runtime.running) throw createError({ statusCode: 409, message: 'Закройте игру перед созданием резервной копии сохранения' })
  }
  const id = randomUUID()
  const staged = await authenticatedServiceRequest(ip, '/saves/export', 'POST', { id, userId, titleId, slot: rawSlot }) as StagedExport
  const remoteRoot = `/data/PackegeFlowService/save-exports/${id}/files`
  if (!staged || staged.path !== remoteRoot || !Number.isSafeInteger(staged.files) || staged.files < 1 || staged.files > 512 ||
      !Number.isSafeInteger(staged.bytes) || staged.bytes < 1 || staged.bytes > 64 * 1024 * 1024)
    throw createError({ statusCode: 502, message: 'PS4 вернула неожиданный результат экспорта сохранения' })
  mkdirSync(saveBackupRoot, { recursive: true, mode: 0o700 })
  const localRoot = resolve(saveBackupRoot, id)
  mkdirSync(localRoot, { mode: 0o700 })
  const localFiles = resolve(localRoot, 'files')
  mkdirSync(localFiles, { mode: 0o700 })
  const files: BackupFile[] = []
  let count = 0, transferred = 0
  async function copy(remote: string, local: string, relative: string, depth: number) {
    if (depth > 8) throw createError({ statusCode: 502, message: 'Слишком глубокая структура сохранения' })
    for (const entry of await directory(ip, remote, 512)) {
      if (entry.name === '.' || entry.name === '..' || ++count > 512 || entry.type === 'link')
        throw createError({ statusCode: 502, message: 'Сохранение содержит неподдерживаемый файл' })
      const source = `${remote}/${entry.name}`, target = resolve(local, entry.name)
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.type === 'directory') { mkdirSync(target, { mode: 0o700 }); await copy(source, target, name, depth + 1); continue }
      if (entry.type !== 'file' || entry.size > 64 * 1024 * 1024 - transferred)
        throw createError({ statusCode: 502, message: 'Сохранение превышает допустимый размер' })
      const fd = openSync(target, 'wx', 0o600), hash = createHash('sha256')
      try {
        for (let offset = 0; offset < entry.size;) {
          const expected = Math.min(256 * 1024, entry.size - offset)
          const chunk = await consoleFileRead(ip, source, offset, expected)
          if (chunk.length !== expected) throw createError({ statusCode: 502, message: 'Файл сохранения изменился во время передачи' })
          for (let written = 0; written < chunk.length;) {
            const amount = writeSync(fd, chunk, written, chunk.length - written)
            if (amount < 1) throw createError({ statusCode: 507, message: 'Не удалось сохранить резервную копию на компьютере' })
            written += amount
          }
          hash.update(chunk); offset += chunk.length
        }
        fsyncSync(fd)
      } finally { closeSync(fd) }
      transferred += entry.size
      files.push({ path: name, bytes: entry.size, sha256: hash.digest('hex') })
    }
  }
  try {
    await copy(remoteRoot, localFiles, '', 0)
    if (count !== staged.files || transferred !== staged.bytes || !files.length)
      throw createError({ statusCode: 502, message: 'Состав сохранения не совпал с экспортом PS4' })
    const manifest = { format: 'pfs-decrypted-save-backup-v1', id, userId, titleId, slot: rawSlot, createdAt: new Date().toISOString(),
      visibility: internal ? 'internal' : 'manual', files }
    writeFileSync(resolve(localRoot, 'metadata.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 })
    let cleanupPending = false
    try { await authenticatedServiceRequest(ip, '/saves/cleanup', 'POST', { id }) }
    catch { cleanupPending = true }
    return { id, userId, titleId, slot: rawSlot, files: files.length, bytes: transferred, cleanupPending }
  } catch (error) {
    rmSync(localRoot, { recursive: true, force: true })
    await authenticatedServiceRequest(ip, '/saves/cleanup', 'POST', { id }).catch(() => {})
    throw error
  }
}

function gameFiles(files: { path: string; bytes: number; sha256: string }[]) {
  return files.filter(file => !file.path.startsWith('sce_sys/')).sort((a, b) => a.path.localeCompare(b.path))
}

/** Existing-save restore on the same PS4 and profile. The current slot is saved first. */
export async function restoreSaveBackup(ip: string, rawId: unknown) {
  const source = readSaveBackup(rawId, true)
  const { userId, titleId, slot } = source.manifest
  const catalog = await getConsoleCatalog(ip)
  if (!catalog.complete || !catalog.apps.some(app => app.titleId === titleId))
    throw createError({ statusCode: 409, message: 'Для проверки восстановления игра должна быть установлена на PS4' })
  if ((await consoleRuntime(ip, titleId)).running)
    throw createError({ statusCode: 409, message: 'Закройте игру перед восстановлением сохранения' })
  if (!(await listSaveSlots(ip, userId, titleId)).some(item => item.name === slot))
    throw createError({ statusCode: 409, message: 'Исходный слот больше не найден на PS4' })
  const safety = await createSaveBackup(ip, userId, titleId, slot, true)
  const current = readSaveBackup(safety.id, true)
  const sourceKey = source.manifest.files.find(file => file.path === 'sce_sys/keystone')?.sha256
  const currentKey = current.manifest.files.find(file => file.path === 'sce_sys/keystone')?.sha256
  if (!sourceKey || sourceKey !== currentKey)
    throw createError({ statusCode: 409, message: 'Копия относится к другому контейнеру сохранения. Запись остановлена' })
  const desired = gameFiles(source.manifest.files), existing = gameFiles(current.manifest.files)
  if (!desired.length || desired.length !== existing.length || desired.some((file, i) => file.path !== existing[i]?.path))
    throw createError({ statusCode: 409, message: 'Состав файлов сохранения изменился. Запись остановлена' })
  const stageId = randomUUID()
  const request = { id: stageId, userId, titleId, slot }
  const stage = await authenticatedServiceRequest(ip, '/saves/restore/prepare', 'POST', request) as { path?: string; ready?: boolean }
  const expectedRoot = `/data/PackegeFlowService/save-exports/${stageId}/files`
  if (stage?.path !== expectedRoot || stage.ready !== true)
    throw createError({ statusCode: 502, message: 'PS4 вернула неверный путь подготовки сохранения' })
  try {
    for (const file of desired) {
      const destination = `${expectedRoot}/${file.path}`
      const data = readFileSync(resolve(source.root, 'files', file.path))
      const uploadId = randomUUID()
      const session = await consoleFileRequest(ip, 'upload/start', { path: destination, id: uploadId, size: data.length }) as { offset?: number }
      if (session?.offset !== 0) throw createError({ statusCode: 502, message: 'PS4 вернула неверное смещение записи сохранения' })
      for (let offset = 0; offset < data.length;) {
        const chunk = data.subarray(offset, Math.min(offset + 256 * 1024, data.length))
        await consoleFileWrite(ip, uploadId, offset, chunk)
        offset += chunk.length
      }
      await consoleFileRequest(ip, 'upload/finish', { id: uploadId })
      const hash = createHash('sha256')
      for (let offset = 0; offset < data.length;) {
        const chunk = await consoleFileRead(ip, destination, offset, Math.min(256 * 1024, data.length - offset))
        if (!chunk.length) throw createError({ statusCode: 502, message: 'PS4 не подтвердила записанный файл' })
        hash.update(chunk); offset += chunk.length
      }
      if (hash.digest('hex') !== file.sha256)
        throw createError({ statusCode: 502, message: 'Файл для восстановления на PS4 не совпал с копией' })
    }
  } catch (error) {
    await authenticatedServiceRequest(ip, '/saves/cleanup', 'POST', { id: stageId }).catch(() => {})
    throw error
  }
  const committed = await authenticatedServiceRequest(ip, '/saves/restore/commit', 'POST', request) as { restored?: boolean; files?: number; rollbackAvailable?: boolean }
  if (committed?.restored !== true || committed.rollbackAvailable !== true || committed.files !== desired.length)
    throw createError({ statusCode: 502, message: 'PS4 не подтвердила восстановление сохранения' })
  try {
    const verified = await createSaveBackup(ip, userId, titleId, slot, true)
    const actual = gameFiles(readSaveBackup(verified.id, true).manifest.files)
    if (actual.length !== desired.length || desired.some((file, i) => file.path !== actual[i]?.path || file.sha256 !== actual[i]?.sha256))
      throw createError({ statusCode: 502, message: 'Проверка восстановленного сохранения не прошла' })
    return { restored: true, sourceBackupId: source.manifest.id, safetyBackupId: safety.id, verifiedBackupId: verified.id,
      rollbackId: stageId, titleId, userId, slot, files: desired.length }
  } catch (error) {
    try { await authenticatedServiceRequest(ip, '/saves/restore/rollback', 'POST', request) }
    catch { throw createError({ statusCode: 503, message: `Проверка не прошла, и автоматический откат не подтверждён. Код отката: ${stageId}` }) }
    throw error
  }
}
