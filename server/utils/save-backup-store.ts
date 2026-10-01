import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { createError } from 'h3'
import archiver from 'archiver'

export const saveBackupRoot = resolve(process.cwd(), '.data/save-backups')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
interface BackupFile { path: string; bytes: number; sha256: string }
export interface SaveBackupManifest {
  format: 'pfs-decrypted-save-backup-v1'
  id: string
  userId: string
  titleId: string
  slot: string
  createdAt: string
  visibility?: 'manual' | 'internal'
  files: BackupFile[]
}

export function readSaveBackup(id: unknown, verifyFiles = false): { root: string; manifest: SaveBackupManifest; bytes: number } {
  if (typeof id !== 'string' || !uuid.test(id)) throw createError({ statusCode: 400, message: 'Неверный номер резервной копии' })
  const root = resolve(saveBackupRoot, id)
  let manifest: SaveBackupManifest
  try { manifest = JSON.parse(readFileSync(resolve(root, 'metadata.json'), 'utf8')) }
  catch { throw createError({ statusCode: 404, message: 'Резервная копия не найдена' }) }
  if (manifest?.format !== 'pfs-decrypted-save-backup-v1' || manifest.id !== id ||
      !/^[0-9a-f]{8}$/i.test(manifest.userId) || !/^[A-Z0-9]{9}$/.test(manifest.titleId) ||
      !/^[A-Za-z0-9_-]{1,31}$/.test(manifest.slot) || !Number.isFinite(Date.parse(manifest.createdAt)) ||
      !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 512)
    throw createError({ statusCode: 422, message: 'Описание резервной копии повреждено' })
  const seen = new Set<string>()
  let bytes = 0
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || file.path.length > 512 ||
        file.path.split('/').some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f\x7f]/.test(part)) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[0-9a-f]{64}$/i.test(file.sha256) || seen.has(file.path))
      throw createError({ statusCode: 422, message: 'Состав резервной копии повреждён' })
    seen.add(file.path)
    bytes += file.bytes
    if (bytes > 64 * 1024 * 1024) throw createError({ statusCode: 422, message: 'Резервная копия превышает допустимый размер' })
    if (!verifyFiles) continue
    let current = resolve(root, 'files')
    for (const segment of file.path.split('/')) {
      current = resolve(current, segment)
      if (!current.startsWith(resolve(root, 'files') + sep)) throw createError({ statusCode: 422, message: 'Неверный путь в резервной копии' })
      if (lstatSync(current).isSymbolicLink()) throw createError({ statusCode: 422, message: 'Ссылка в резервной копии недопустима' })
    }
    if (!lstatSync(current).isFile()) throw createError({ statusCode: 422, message: 'Файл резервной копии отсутствует' })
    const data = readFileSync(current)
    if (data.length !== file.bytes || createHash('sha256').update(data).digest('hex') !== file.sha256)
      throw createError({ statusCode: 422, message: 'Контрольная сумма резервной копии не совпала' })
  }
  return { root, manifest, bytes }
}

export function listSaveBackups(userId: string, titleId: string) {
  if (!existsSync(saveBackupRoot)) return []
  return readdirSync(saveBackupRoot).filter(id => uuid.test(id)).flatMap(id => {
    try {
      const { manifest, bytes } = readSaveBackup(id)
      return manifest.visibility !== 'internal' && manifest.userId === userId && manifest.titleId === titleId
        ? [{ id, slot: manifest.slot, createdAt: manifest.createdAt, files: manifest.files.length, bytes }] : []
    } catch { return [] }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function ensureSaveArchive(id: string) {
  const { root, manifest } = readSaveBackup(id, true)
  const archivePath = resolve(root, 'backup.zip')
  if (existsSync(archivePath)) return { archivePath, manifest, size: statSync(archivePath).size }
  const temporary = resolve(root, `backup-${randomUUID()}.tmp`)
  const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 })
  const archive = archiver('zip', { zlib: { level: 6 } })
  const complete = new Promise<void>((resolveDone, reject) => {
    output.on('close', resolveDone)
    output.on('error', reject)
    archive.on('error', reject)
  })
  try {
    archive.pipe(output)
    archive.file(resolve(root, 'metadata.json'), { name: 'metadata.json' })
    for (const file of manifest.files)
      archive.file(resolve(root, 'files', file.path), { name: `files/${file.path}` })
    await Promise.all([archive.finalize(), complete])
    renameSync(temporary, archivePath)
    return { archivePath, manifest, size: statSync(archivePath).size }
  } catch (error) {
    archive.abort(); output.destroy(); rmSync(temporary, { force: true })
    throw error
  }
}
