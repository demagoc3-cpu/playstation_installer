import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import archiver from 'archiver'
import { createError } from 'h3'
import { ps4ServiceIp } from './ps4-service'
import { createSaveBackup, listSaveSlots, listSaveUsers } from './ps4-saves'
import { readSaveBackup, saveBackupRoot, type SaveBackupManifest } from './save-backup-store'
import { writeDurableJson } from './durable-json'

const root = resolve(process.cwd(), '.data/save-sets')
const archiveRoot = resolve(process.cwd(), '.data/save-set-archives')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const validName = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,59}$/u
const active = new Set<string>()
const activeIps = new Set<string>()

export interface SaveSetGame { userId: string; titleId: string; title: string; discovered: boolean; error?: string }
export interface SaveSetSlot { userId: string; titleId: string; title: string; slot: string; status: 'pending' | 'complete' | 'error'; bytes?: number; files?: number; error?: string }
export interface SaveSet {
  format: 'pfs-save-set-v1'
  id: string
  name: string
  sourceIp: string
  createdAt: string
  updatedAt: string
  status: 'queued' | 'running' | 'completed' | 'partial' | 'interrupted'
  lastError?: string
  inventoryComplete: boolean
  games: SaveSetGame[]
  slots: SaveSetSlot[]
}

function cleanName(value: unknown) {
  if (typeof value !== 'string') throw createError({ statusCode: 400, message: 'Введите название папки с сохранениями' })
  const name = value.trim().normalize('NFC').replace(/\s+/g, ' ')
  if (!validName.test(name) || name.endsWith('.') || name.endsWith(' '))
    throw createError({ statusCode: 400, message: 'Название: до 60 букв, цифр, пробелов, точек и дефисов' })
  return name
}

function setPath(set: SaveSet) {
  const path = resolve(root, set.name, set.id)
  if (!path.startsWith(root + sep)) throw new Error('Invalid save set path')
  return path
}

function readAll(): { path: string; set: SaveSet }[] {
  if (!existsSync(root)) return []
  const results: { path: string; set: SaveSet }[] = []
  for (const group of readdirSync(root)) {
    const groupPath = resolve(root, group)
    if (!lstatSync(groupPath).isDirectory()) continue
    for (const id of readdirSync(groupPath)) {
      if (!uuid.test(id)) continue
      const path = resolve(groupPath, id)
      try {
        if (!lstatSync(path).isDirectory()) continue
        const set = JSON.parse(readFileSync(resolve(path, 'metadata.json'), 'utf8')) as SaveSet
        if (set.format === 'pfs-save-set-v1' && set.id === id && set.name === group &&
            Array.isArray(set.games) && Array.isArray(set.slots)) results.push({ path, set })
      } catch { /* An incomplete folder is not a published backup. */ }
    }
  }
  return results
}

function displayState(set: SaveSet): SaveSet {
  return set.status === 'running' && !active.has(set.id) ? { ...set, status: 'interrupted' } : set
}

export function listSaveSets() {
  return readAll().map(({ set }) => displayState(set)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function readSaveSet(id: unknown): { path: string; set: SaveSet } {
  if (typeof id !== 'string' || !uuid.test(id)) throw createError({ statusCode: 400, message: 'Неверный номер набора сохранений' })
  const found = readAll().find(item => item.set.id === id)
  if (!found) throw createError({ statusCode: 404, message: 'Набор сохранений не найден' })
  return { ...found, set: displayState(found.set) }
}

function save(path: string, set: SaveSet) {
  set.updatedAt = new Date().toISOString()
  writeDurableJson(resolve(path, 'metadata.json'), set)
}

function errorText(error: unknown) {
  const issue = error as { statusMessage?: string; message?: string }
  return (issue?.statusMessage || issue?.message || 'Не удалось прочитать сохранение').slice(0, 240)
}

export function slotPath(set: SaveSet, task: SaveSetSlot) {
  if (!/^[0-9a-f]{8}$/i.test(task.userId) || !/^[A-Z0-9]{9}$/.test(task.titleId) || !/^[A-Za-z0-9_-]{1,31}$/.test(task.slot))
    throw createError({ statusCode: 422, message: 'Неверный путь слота в наборе' })
  return resolve(setPath(set), 'profiles', task.userId, task.titleId, task.slot)
}

export function readSetSlot(set: SaveSet, task: SaveSetSlot, verify = false): { path: string; manifest: SaveBackupManifest } {
  if (task.status !== 'complete') throw createError({ statusCode: 409, message: 'Копия этого слота ещё не готова' })
  const path = slotPath(set, task)
  let manifest: SaveBackupManifest
  try { manifest = JSON.parse(readFileSync(resolve(path, 'metadata.json'), 'utf8')) }
  catch { throw createError({ statusCode: 422, message: 'Описание слота отсутствует в наборе' }) }
  if (manifest.format !== 'pfs-decrypted-save-backup-v1' || manifest.userId !== task.userId ||
      manifest.titleId !== task.titleId || manifest.slot !== task.slot || !Array.isArray(manifest.files) || !manifest.files.length)
    throw createError({ statusCode: 422, message: 'Описание слота повреждено' })
  if (verify) for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || file.path.split('/').some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f\x7f]/.test(part)) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[0-9a-f]{64}$/i.test(file.sha256))
      throw createError({ statusCode: 422, message: 'Файлы слота повреждены' })
    try {
      let current = resolve(path, 'files')
      for (const part of file.path.split('/')) {
        current = resolve(current, part)
        if (!current.startsWith(resolve(path, 'files') + sep) || lstatSync(current).isSymbolicLink())
          throw new Error('Unsafe save file')
      }
      if (!lstatSync(current).isFile() || statSync(current).size !== file.bytes ||
          createHash('sha256').update(readFileSync(current)).digest('hex') !== file.sha256)
        throw new Error('Save file checksum mismatch')
    } catch { throw createError({ statusCode: 422, message: 'Файл набора отсутствует или повреждён' }) }
  }
  return { path, manifest }
}

function copyIntoSet(set: SaveSet, task: SaveSetSlot, backupId: string) {
  const source = readSaveBackup(backupId, true)
  if (source.manifest.userId !== task.userId || source.manifest.titleId !== task.titleId || source.manifest.slot !== task.slot)
    throw new Error('Unexpected backup identity')
  const target = slotPath(set, task)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(resolve(target, 'files'), { recursive: true, mode: 0o700 })
  try {
    for (const file of source.manifest.files) {
      const destination = resolve(target, 'files', file.path)
      mkdirSync(resolve(destination, '..'), { recursive: true, mode: 0o700 })
      copyFileSync(resolve(source.root, 'files', file.path), destination)
    }
    writeDurableJson(resolve(target, 'metadata.json'), source.manifest)
    readSetSlot(set, { ...task, status: 'complete' }, true)
  } catch (error) { rmSync(target, { recursive: true, force: true }); throw error }
}

async function run(id: string) {
  const { path, set } = readSaveSet(id)
  try {
    set.status = 'running'; delete set.lastError; save(path, set)
    if (!set.inventoryComplete) {
      const users = await listSaveUsers(set.sourceIp)
      set.games = users.flatMap(user => user.games.map(game => ({ userId: user.userId, titleId: game.titleId, title: game.title, discovered: false })))
      set.inventoryComplete = true; save(path, set)
    }
    for (const game of set.games) {
      if (game.discovered) continue
      try {
        const slots = await listSaveSlots(set.sourceIp, game.userId, game.titleId)
        if (!slots.length) throw new Error('На PS4 пока не найдено слотов этой игры')
        for (const slot of slots) if (!set.slots.some(item => item.userId === game.userId && item.titleId === game.titleId && item.slot === slot.name))
          set.slots.push({ userId: game.userId, titleId: game.titleId, title: game.title, slot: slot.name, status: 'pending' })
        game.discovered = true; delete game.error
      } catch (error) { game.error = errorText(error) }
      save(path, set)
    }
    for (const task of set.slots) {
      if (task.status === 'complete') continue
      task.status = 'pending'; delete task.error; save(path, set)
      let temporaryBackupId = ''
      try {
        const result = await createSaveBackup(set.sourceIp, task.userId, task.titleId, task.slot, true)
        temporaryBackupId = result.id
        copyIntoSet(set, task, result.id)
        task.status = 'complete'; task.bytes = result.bytes; task.files = result.files
      } catch (error) { task.status = 'error'; task.error = errorText(error) }
      finally { if (temporaryBackupId) rmSync(resolve(saveBackupRoot, temporaryBackupId), { recursive: true, force: true }) }
      save(path, set)
    }
    set.status = set.games.every(game => game.discovered) && set.slots.every(slot => slot.status === 'complete') ? 'completed' : 'partial'
    save(path, set)
  } catch (error) { set.status = 'interrupted'; set.lastError = errorText(error); save(path, set) }
  finally { active.delete(id); activeIps.delete(set.sourceIp) }
}

function dispatch(id: string) {
  const { set } = readSaveSet(id)
  if (active.has(id) || activeIps.has(set.sourceIp)) throw createError({ statusCode: 409, message: 'Для этой PS4 уже создаётся набор сохранений' })
  active.add(id); activeIps.add(set.sourceIp)
  void Promise.resolve().then(() => run(id))
}

export function createSaveSet(value: unknown, ipValue: unknown) {
  const name = cleanName(value), sourceIp = ps4ServiceIp(ipValue)
  if (!sourceIp) throw createError({ statusCode: 400, message: 'Укажите адрес PS4' })
  if (activeIps.has(sourceIp)) throw createError({ statusCode: 409, message: 'Для этой PS4 уже создаётся набор сохранений' })
  const now = new Date().toISOString(), id = randomUUID()
  const set: SaveSet = { format: 'pfs-save-set-v1', id, name, sourceIp, createdAt: now, updatedAt: now,
    status: 'queued', inventoryComplete: false, games: [], slots: [] }
  const path = setPath(set)
  mkdirSync(path, { recursive: true, mode: 0o700 })
  save(path, set)
  dispatch(id)
  return set
}

export function resumeSaveSet(id: unknown) {
  const { set } = readSaveSet(id)
  if (set.status === 'completed') return set
  dispatch(set.id)
  return set
}

export async function ensureSaveSetArchive(id: unknown) {
  const { path, set } = readSaveSet(id)
  if (!set.slots.some(task => task.status === 'complete')) throw createError({ statusCode: 409, message: 'В наборе ещё нет готовых копий' })
  if (active.has(set.id)) throw createError({ statusCode: 409, message: 'Дождитесь завершения копирования' })
  const verified = set.slots.filter(task => task.status === 'complete').map(task => ({ task, ...readSetSlot(set, task, true) }))
  mkdirSync(archiveRoot, { recursive: true, mode: 0o700 })
  const outputPath = resolve(archiveRoot, `${set.id}.zip`)
  const temporary = resolve(archiveRoot, `${set.id}.${randomUUID()}.tmp`)
  const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 })
  const archive = archiver('zip', { zlib: { level: 0 } })
  const finished = new Promise<void>((resolveDone, reject) => { output.on('close', resolveDone); output.on('error', reject); archive.on('error', reject) })
  try {
    archive.pipe(output)
    const prefix = `${set.name}/${set.id}`
    archive.file(resolve(path, 'metadata.json'), { name: `${prefix}/metadata.json` })
    for (const { task, path: slotRoot, manifest } of verified) {
      const slotPrefix = `${prefix}/profiles/${task.userId}/${task.titleId}/${task.slot}`
      archive.file(resolve(slotRoot, 'metadata.json'), { name: `${slotPrefix}/metadata.json` })
      for (const file of manifest.files) archive.file(resolve(slotRoot, 'files', file.path), { name: `${slotPrefix}/files/${file.path}` })
    }
    await Promise.all([archive.finalize(), finished])
    renameSync(temporary, outputPath)
    return { path: outputPath, size: statSync(outputPath).size, set }
  } catch (error) { archive.abort(); output.destroy(); rmSync(temporary, { force: true }); throw error }
}
