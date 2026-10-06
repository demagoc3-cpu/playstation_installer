import { dataPath } from './data-path'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { createError } from 'h3'
import { getConsoleCatalog } from './ps4-console-apps'
import { ps4ServiceIp } from './ps4-service'
import { createSaveBackup, listSaveSlots, listSaveUsers } from './ps4-saves'
import { readSaveBackup, saveBackupRoot, type SaveBackupManifest } from './save-backup-store'
import { pendingSaveRestores, readSaveRestore } from './save-restore-store'
import { readSaveSet, readSetSlot, type SaveSet, type SaveSetSlot } from './save-set-store'
import { startSaveRestore } from './save-restore-actions'
import { writeDurableJson } from './durable-json'

const root = dataPath('save-set-restores')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const active = new Set<string>()

export interface SaveSetMatch {
  key: string
  sourceUserId: string
  titleId: string
  title: string
  slots: string[]
  status: 'ready' | 'different-console' | 'game-not-installed' | 'create-save-first' | 'incomplete-backup' | 'pending-restore'
  message: string
}

export interface SaveSetRestoreTask {
  key: string
  sourceUserId: string
  titleId: string
  slot: string
  status: 'pending' | 'restored' | 'needs-review' | 'error'
  rollbackId?: string
  adaptedBackupId?: string
  error?: string
}

export interface SaveSetRestoreRun {
  format: 'pfs-save-set-restore-v1'
  id: string
  setId: string
  ip: string
  targetUserId: string
  createdAt: string
  updatedAt: string
  status: 'queued' | 'running' | 'completed' | 'partial' | 'interrupted'
  tasks: SaveSetRestoreTask[]
}

function gameKey(userId: string, titleId: string) { return `${userId}:${titleId}` }
function gameFiles(files: SaveBackupManifest['files']) { return files.filter(file => !file.path.startsWith('sce_sys/')).sort((a, b) => a.path.localeCompare(b.path)) }
function errorText(error: unknown) {
  const issue = error as { statusMessage?: string; message?: string }
  return (issue?.statusMessage || issue?.message || 'Не удалось восстановить сохранение').slice(0, 240)
}

export async function previewSaveSet(id: unknown, ipValue: unknown, targetUserId: unknown) {
  const { set } = readSaveSet(id)
  const ip = ps4ServiceIp(ipValue)
  if (!ip) throw createError({ statusCode: 400, message: 'Укажите адрес PS4' })
  if (typeof targetUserId !== 'string' || !/^[0-9a-f]{8}$/i.test(targetUserId))
    throw createError({ statusCode: 400, message: 'Выберите профиль для восстановления' })
  const users = await listSaveUsers(ip)
  if (!users.some(user => user.userId === targetUserId.toLowerCase()))
    throw createError({ statusCode: 409, message: 'Выбранный профиль больше не найден на PS4' })
  const catalog = await getConsoleCatalog(ip)
  if (!catalog.complete) throw createError({ statusCode: 503, message: 'PS4 вернула неполный список игр. Обновите список позже' })
  const installed = new Set(catalog.apps.map(app => app.titleId))
  const matches: SaveSetMatch[] = []
  const games = set.games
  for (let i = 0; i < games.length; i += 4) {
    const batch = await Promise.all(games.slice(i, i + 4).map(async game => {
      const slots = set.slots.filter(slot => slot.userId === game.userId && slot.titleId === game.titleId)
      const base = { key: gameKey(game.userId, game.titleId), sourceUserId: game.userId,
        titleId: game.titleId, title: game.title, slots: slots.map(slot => slot.slot) }
      function result(status: SaveSetMatch['status'], message: string): SaveSetMatch { return { ...base, status, message } }
      if (!game.discovered || !slots.length || slots.some(slot => slot.status !== 'complete'))
        return result('incomplete-backup', 'Копия игры неполная или в ней нет слотов. Повторите копирование.')
      if (set.sourceIp !== ip) return result('different-console', 'Набор создан на другой PS4. Перенос между консолями пока не проверен.')
      if (!installed.has(game.titleId)) return result('game-not-installed', 'Игра сейчас не установлена на PS4.')
      if (pendingSaveRestores(ip, targetUserId.toLowerCase(), game.titleId).length)
        return result('pending-restore', 'Сначала подтвердите или отмените прежнее восстановление этой игры.')
      try {
        const target = new Set((await listSaveSlots(ip, targetUserId, game.titleId)).map(slot => slot.name))
        const missing = slots.filter(slot => !target.has(slot.slot)).map(slot => slot.slot)
        if (missing.length) return result('create-save-first', `Нет ${missing.length} слотов на целевом профиле. Запустите игру и создайте сохранение.`)
      } catch { return result('create-save-first', 'Нет подходящего сохранения на целевом профиле. Создайте его в игре.') }
      return result('ready', 'Установлена, слоты найдены. Ключ каждого сейва проверится перед записью.')
    }))
    matches.push(...batch)
  }
  return { setId: set.id, name: set.name, sourceIp: set.sourceIp, targetIp: ip, targetUserId: targetUserId.toLowerCase(), matches }
}

function readRun(id: unknown): SaveSetRestoreRun {
  if (typeof id !== 'string' || !uuid.test(id)) throw createError({ statusCode: 400, message: 'Неверный номер восстановления набора' })
  try {
    const run = JSON.parse(readFileSync(resolve(root, `${id}.json`), 'utf8')) as SaveSetRestoreRun
    if (run.format !== 'pfs-save-set-restore-v1' || run.id !== id || !Array.isArray(run.tasks)) throw new Error('Invalid run')
    return run
  } catch { throw createError({ statusCode: 404, message: 'Восстановление набора не найдено' }) }
}

function save(run: SaveSetRestoreRun) {
  run.updatedAt = new Date().toISOString()
  writeDurableJson(resolve(root, `${run.id}.json`), run)
}

export function getSaveSetRestoreRun(id: unknown) {
  const run = readRun(id)
  return { ...run, status: run.status === 'running' && !active.has(run.id) ? 'interrupted' : run.status,
    tasks: run.tasks.map(task => {
      if (!task.rollbackId) return task
      try { return { ...task, restoreState: readSaveRestore(task.rollbackId).state } }
      catch { return { ...task, restoreState: 'unknown' } }
    }) }
}

export function listSaveSetRestoreRuns(setId: unknown) {
  if (typeof setId !== 'string' || !uuid.test(setId)) return []
  if (!existsSync(root)) return []
  return readdirSync(root).filter(file => file.endsWith('.json') && uuid.test(file.slice(0, -5))).flatMap(file => {
    try { const run = getSaveSetRestoreRun(file.slice(0, -5)); return run.setId === setId ? [run] : [] }
    catch { return [] }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

async function prepareAdaptedBackup(set: SaveSet, sourceTask: SaveSetSlot, ip: string, targetUserId: string) {
  const source = readSetSlot(set, sourceTask, true)
  const currentResult = await createSaveBackup(ip, targetUserId, sourceTask.titleId, sourceTask.slot, true)
  const current = readSaveBackup(currentResult.id, true)
  try {
  const sourceKey = source.manifest.files.find(file => file.path === 'sce_sys/keystone')?.sha256
  const targetKey = current.manifest.files.find(file => file.path === 'sce_sys/keystone')?.sha256
  if (!sourceKey || sourceKey !== targetKey)
    throw createError({ statusCode: 409, message: `Ключ ${sourceTask.slot} не совпал. Запись остановлена; этот сейв нельзя восстановить в выбранный слот.` })
  const gameSource = gameFiles(source.manifest.files), gameTarget = gameFiles(current.manifest.files)
  if (!gameSource.length || gameSource.length !== gameTarget.length || gameSource.some((file, index) => file.path !== gameTarget[index]?.path))
    throw createError({ statusCode: 409, message: `У ${sourceTask.slot} другой состав файлов. Запись остановлена.` })
  const id = randomUUID(), target = resolve(saveBackupRoot, id)
  mkdirSync(resolve(target, 'files'), { recursive: true, mode: 0o700 })
  try {
    const files = current.manifest.files.map(file => {
      const fromSource = !file.path.startsWith('sce_sys/')
      const original = fromSource ? gameSource.find(item => item.path === file.path)! : file
      const sourceFile = fromSource ? resolve(source.path, 'files', file.path) : resolve(current.root, 'files', file.path)
      const destination = resolve(target, 'files', file.path)
      mkdirSync(resolve(destination, '..'), { recursive: true, mode: 0o700 })
      copyFileSync(sourceFile, destination)
      if (createHash('sha256').update(readFileSync(destination)).digest('hex') !== original.sha256)
        throw new Error(`Adapted backup checksum mismatch: ${file.path}`)
      return { path: file.path, bytes: original.bytes, sha256: original.sha256 }
    })
    const manifest: SaveBackupManifest = { format: 'pfs-decrypted-save-backup-v1', id, userId: targetUserId,
      titleId: sourceTask.titleId, slot: sourceTask.slot, createdAt: new Date().toISOString(), visibility: 'internal', files }
    writeDurableJson(resolve(target, 'metadata.json'), manifest)
    readSaveBackup(id, true)
    return id
  } catch (error) { rmSync(target, { recursive: true, force: true }); throw error }
  } finally { rmSync(current.root, { recursive: true, force: true }) }
}

async function runRestore(id: string) {
  const run = readRun(id)
  try {
    run.status = 'running'; save(run)
    const { set } = readSaveSet(run.setId)
    for (const task of run.tasks) {
      if (task.status === 'restored' || task.status === 'needs-review') continue
      const pending = pendingSaveRestores(run.ip, run.targetUserId, task.titleId).find(item => item.slot === task.slot)
      if (pending) {
        task.status = 'needs-review'; task.rollbackId = pending.rollbackId
        task.error = 'Запись уже отправлена. Проверьте результат в игре и подтвердите или отмените её.'
        save(run); continue
      }
      task.status = 'pending'; delete task.error; save(run)
      try {
        const sourceTask = set.slots.find(item => item.userId === task.sourceUserId && item.titleId === task.titleId && item.slot === task.slot)
        if (!sourceTask || sourceTask.status !== 'complete') throw new Error('Слот отсутствует в наборе')
        const adaptedBackupId = await prepareAdaptedBackup(set, sourceTask, run.ip, run.targetUserId)
        task.adaptedBackupId = adaptedBackupId; save(run)
        const result = await startSaveRestore(run.ip, adaptedBackupId)
        task.status = 'restored'; task.rollbackId = result.rollbackId
      } catch (error) { task.status = 'error'; task.error = errorText(error) }
      save(run)
    }
    run.status = run.tasks.every(task => task.status === 'restored') ? 'completed' : 'partial'
    save(run)
  } catch { run.status = 'interrupted'; save(run) }
  finally { active.delete(id) }
}

function dispatch(id: string) {
  if (active.has(id)) throw createError({ statusCode: 409, message: 'Восстановление набора уже выполняется' })
  active.add(id)
  void Promise.resolve().then(() => runRestore(id))
}

export async function startSaveSetRestore(setId: unknown, ipValue: unknown, targetUserId: unknown, selected: unknown) {
  if (!Array.isArray(selected) || !selected.length || selected.length > 256 || selected.some(key => typeof key !== 'string'))
    throw createError({ statusCode: 400, message: 'Выберите игры для восстановления' })
  const preview = await previewSaveSet(setId, ipValue, targetUserId)
  const keys = new Set(selected as string[])
  if (keys.size !== selected.length || preview.matches.filter(match => keys.has(match.key) && match.status === 'ready').length !== keys.size)
    throw createError({ statusCode: 409, message: 'Некоторые выбранные игры больше не подходят для восстановления. Обновите проверку.' })
  const { set } = readSaveSet(setId)
  const now = new Date().toISOString(), id = randomUUID()
  const tasks: SaveSetRestoreTask[] = set.slots.filter(slot => keys.has(gameKey(slot.userId, slot.titleId)))
    .map(slot => ({ key: gameKey(slot.userId, slot.titleId), sourceUserId: slot.userId,
      titleId: slot.titleId, slot: slot.slot, status: 'pending' }))
  if (!tasks.length) throw createError({ statusCode: 409, message: 'В выбранных играх нет сохранений' })
  const run: SaveSetRestoreRun = { format: 'pfs-save-set-restore-v1', id, setId: set.id,
    ip: preview.targetIp, targetUserId: preview.targetUserId, createdAt: now, updatedAt: now, status: 'queued', tasks }
  save(run); dispatch(id)
  return run
}

export function resumeSaveSetRestore(id: unknown) {
  const run = readRun(id)
  if (run.status === 'completed') return getSaveSetRestoreRun(run.id)
  dispatch(run.id)
  return getSaveSetRestoreRun(run.id)
}
