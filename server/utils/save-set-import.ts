import { dataPath } from './data-path'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { crc32, inflateRawSync } from 'node:zlib'
import { createError, getHeader, type H3Event } from 'h3'
import { ps4ServiceIp } from './ps4-service'
import { type SaveSet, type SaveSetSlot } from './save-set-store'
import { type SaveBackupManifest } from './save-backup-store'
import { writeDurableJson } from './durable-json'

const root = dataPath('save-sets')
const uploadRoot = dataPath('save-set-uploads')
const maxArchive = 1024 * 1024 * 1024
const maxTotal = 2 * 1024 * 1024 * 1024
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const namePattern = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,59}$/u
const userPattern = /^[0-9a-f]{8}$/i
const titlePattern = /^[A-Z0-9]{9}$/
const slotPattern = /^[A-Za-z0-9_-]{1,31}$/
const shaPattern = /^[0-9a-f]{64}$/i

interface ZipEntry { name: string; method: number; compressed: number; size: number; crc: number; localOffset: number }
function invalid(message = 'Архив сохранений повреждён или не поддерживается'): never {
  throw createError({ statusCode: 422, message })
}
function readExactly(fd: number, position: number, length: number) {
  const buffer = Buffer.alloc(length)
  for (let done = 0; done < length;) {
    const read = readSync(fd, buffer, done, length - done, position + done)
    if (!read) invalid()
    done += read
  }
  return buffer
}
function safeZipPath(name: string) {
  return name.length <= 768 && !name.startsWith('/') && !/[\\\x00-\x1f\x7f]/.test(name) &&
    name.split('/').every(part => part && part !== '.' && part !== '..')
}
function openZip(path: string) {
  const fd = openSync(path, 'r')
  try {
    const length = statSync(path).size
    if (length < 22 || length > maxArchive) invalid('Архив слишком велик или пуст')
    const tailLength = Math.min(length, 65557), tail = readExactly(fd, length - tailLength, tailLength)
    let end = -1
    for (let index = tail.length - 22; index >= 0; index--) {
      if (tail.readUInt32LE(index) === 0x06054b50 && index + 22 + tail.readUInt16LE(index + 20) === tail.length) { end = index; break }
    }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) ||
        tail.readUInt16LE(end + 8) !== tail.readUInt16LE(end + 10)) invalid()
    const count = tail.readUInt16LE(end + 10)
    const centralSize = tail.readUInt32LE(end + 12), centralOffset = tail.readUInt32LE(end + 16)
    if (!count || count > 10000 || centralOffset + centralSize > length - tailLength + end) invalid()
    const entries = new Map<string, ZipEntry>()
    let position = centralOffset, total = 0
    const decoder = new TextDecoder('utf-8', { fatal: true })
    for (let index = 0; index < count; index++) {
      const header = readExactly(fd, position, 46)
      if (header.readUInt32LE(0) !== 0x02014b50) invalid()
      const flags = header.readUInt16LE(8), method = header.readUInt16LE(10)
      const compressed = header.readUInt32LE(20), size = header.readUInt32LE(24)
      const nameLength = header.readUInt16LE(28), extraLength = header.readUInt16LE(30), commentLength = header.readUInt16LE(32)
      const localOffset = header.readUInt32LE(42)
      if (flags & 1 || ![0, 8].includes(method) || size > 64 * 1024 * 1024 || compressed > 65 * 1024 * 1024 ||
          size === 0xffffffff || compressed === 0xffffffff || localOffset === 0xffffffff ||
          ((header.readUInt32LE(38) >>> 16) & 0xf000) === 0xa000) invalid()
      const nameBytes = readExactly(fd, position + 46, nameLength)
      let name: string
      try { name = decoder.decode(nameBytes) } catch { invalid(); throw new Error('Invalid name') }
      if (!safeZipPath(name) || entries.has(name)) invalid('Архив содержит неверные или повторяющиеся пути')
      entries.set(name, { name, method, compressed, size, crc: header.readUInt32LE(16), localOffset })
      total += size
      if (total > maxTotal) invalid('Содержимое архива превышает допустимый размер')
      position += 46 + nameLength + extraLength + commentLength
      if (position > centralOffset + centralSize) invalid()
    }
    if (position !== centralOffset + centralSize) invalid()
    function read(name: string) {
      const entry = entries.get(name)
      if (!entry) invalid(`В архиве отсутствует файл ${name}`)
      const local = readExactly(fd, entry.localOffset, 30)
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(8) !== entry.method) invalid()
      const localNameLength = local.readUInt16LE(26), localExtraLength = local.readUInt16LE(28)
      const localName = readExactly(fd, entry.localOffset + 30, localNameLength)
      if (!localName.equals(Buffer.from(entry.name))) invalid()
      const start = entry.localOffset + 30 + localNameLength + localExtraLength
      if (start + entry.compressed > centralOffset) invalid()
      const packed = readExactly(fd, start, entry.compressed)
      let data: Buffer
      try { data = entry.method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: entry.size + 1 }) }
      catch { invalid('Не удалось распаковать файл сохранения') }
      if (data.length !== entry.size || crc32(data) !== entry.crc) invalid('Контрольная сумма ZIP не совпала')
      return data
    }
    return { entries, read, close: () => closeSync(fd) }
  } catch (error) { closeSync(fd); throw error }
}
function jsonEntry(zip: ReturnType<typeof openZip>, name: string, limit: number): unknown {
  const entry = zip.entries.get(name)
  if (!entry || entry.size > limit) invalid('Описание набора отсутствует или слишком велико')
  try { return JSON.parse(zip.read(name).toString('utf8')) }
  catch { invalid('Описание набора не является корректным JSON') }
}

function validateSet(raw: unknown): SaveSet {
  const set = raw as SaveSet
  if (!set || set.format !== 'pfs-save-set-v1' || !uuid.test(set.id) || typeof set.name !== 'string' ||
      !namePattern.test(set.name) || set.name.endsWith('.') || set.name.endsWith(' ') ||
      !ps4ServiceIp(set.sourceIp) || !Array.isArray(set.games) || set.games.length > 1024 ||
      !Array.isArray(set.slots) || set.slots.length > 4096 || !Number.isFinite(Date.parse(set.createdAt))) invalid('Неверное описание набора')
  const games = new Set<string>(), slots = new Set<string>()
  for (const game of set.games) {
    if (!game || !userPattern.test(game.userId) || !titlePattern.test(game.titleId) || typeof game.title !== 'string' ||
        game.title.length > 200 || typeof game.discovered !== 'boolean') invalid('Неверный список игр')
    const key = `${game.userId}/${game.titleId}`
    if (games.has(key)) invalid('Повтор игры в архиве')
    games.add(key)
  }
  for (const slot of set.slots) {
    if (!slot || !userPattern.test(slot.userId) || !titlePattern.test(slot.titleId) || !slotPattern.test(slot.slot) ||
        !games.has(`${slot.userId}/${slot.titleId}`) || !['complete', 'pending', 'error'].includes(slot.status)) invalid('Неверный список слотов')
    const key = `${slot.userId}/${slot.titleId}/${slot.slot}`
    if (slots.has(key)) invalid('Повтор слота в архиве')
    slots.add(key)
  }
  return set
}
function validateManifest(raw: unknown, slot: SaveSetSlot): SaveBackupManifest {
  const manifest = raw as SaveBackupManifest
  if (!manifest || manifest.format !== 'pfs-decrypted-save-backup-v1' || !uuid.test(manifest.id) ||
      manifest.userId !== slot.userId || manifest.titleId !== slot.titleId || manifest.slot !== slot.slot ||
      !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 512) invalid('Неверное описание сохранения')
  const names = new Set<string>()
  let total = 0
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || file.path.length > 512 || !safeZipPath(file.path) || names.has(file.path) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !shaPattern.test(file.sha256)) invalid('Неверный файл сохранения')
    total += file.bytes
    if (total > 64 * 1024 * 1024) invalid('Сохранение превышает допустимый размер')
    names.add(file.path)
  }
  return manifest
}

export async function importSaveSet(event: H3Event) {
  if (!/^application\/zip(?:\s*;|$)/i.test(getHeader(event, 'content-type') || ''))
    throw createError({ statusCode: 415, message: 'Выберите ZIP архив набора сохранений' })
  const declared = Number(getHeader(event, 'content-length'))
  if (Number.isFinite(declared) && declared > maxArchive)
    throw createError({ statusCode: 413, message: 'Архив больше 1 ГБ' })
  mkdirSync(uploadRoot, { recursive: true, mode: 0o700 })
  const upload = resolve(uploadRoot, `${randomUUID()}.zip`)
  const fd = openSync(upload, 'wx', 0o600)
  let received = 0, uploaded = false
  try {
    for await (const part of event.node.req) {
      const data = Buffer.isBuffer(part) ? part : Buffer.from(part)
      received += data.length
      if (received > maxArchive) throw createError({ statusCode: 413, message: 'Архив больше 1 ГБ' })
      for (let offset = 0; offset < data.length;) {
        const written = writeSync(fd, data, offset, data.length - offset)
        if (written < 1) throw createError({ statusCode: 507, message: 'Не удалось сохранить ZIP на компьютере' })
        offset += written
      }
    }
    fsyncSync(fd)
    uploaded = true
  } finally { closeSync(fd); if (!uploaded) rmSync(upload, { force: true }) }
  try {
    const zip = openZip(upload)
    try {
      const metadataNames = [...zip.entries.keys()].filter(name => name.endsWith('/metadata.json') && name.split('/').length === 3)
      if (metadataNames.length !== 1) invalid('В ZIP должен быть один набор сохранений')
      const metadataPath = metadataNames[0]!
      const original = validateSet(jsonEntry(zip, metadataPath, 2 * 1024 * 1024))
      const prefix = `${original.name}/${original.id}`
      if (metadataPath !== `${prefix}/metadata.json`) invalid('Название папки ZIP не совпало с набором')
      const id = randomUUID(), now = new Date().toISOString()
      const set: SaveSet = { ...original, id, createdAt: now, updatedAt: now,
        status: original.slots.every(slot => slot.status === 'complete') && original.games.every(game => game.discovered) ? 'completed' : 'partial' }
      const parent = resolve(root, set.name), temporary = resolve(parent, `.import-${id}`), final = resolve(parent, id)
      mkdirSync(parent, { recursive: true, mode: 0o700 })
      if (existsSync(final)) invalid('Набор с таким номером уже существует')
      mkdirSync(temporary, { mode: 0o700 })
      const expected = new Set([metadataPath])
      try {
        for (const slot of set.slots.filter(slot => slot.status === 'complete')) {
          const base = `${prefix}/profiles/${slot.userId}/${slot.titleId}/${slot.slot}`
          const manifestPath = `${base}/metadata.json`
          expected.add(manifestPath)
          const manifest = validateManifest(jsonEntry(zip, manifestPath, 1024 * 1024), slot)
          const destination = resolve(temporary, 'profiles', slot.userId, slot.titleId, slot.slot)
          mkdirSync(resolve(destination, 'files'), { recursive: true, mode: 0o700 })
          for (const file of manifest.files) {
            const path = `${base}/files/${file.path}`
            expected.add(path)
            const data = zip.read(path)
            if (data.length !== file.bytes || createHash('sha256').update(data).digest('hex') !== file.sha256)
              invalid(`Контрольная сумма сохранения ${slot.titleId}/${slot.slot} не совпала`)
            const target = resolve(destination, 'files', file.path)
            if (!target.startsWith(resolve(destination, 'files') + sep)) invalid()
            mkdirSync(resolve(target, '..'), { recursive: true, mode: 0o700 })
            writeFileSync(target, data, { flag: 'wx', mode: 0o600 })
          }
          writeDurableJson(resolve(destination, 'metadata.json'), manifest)
        }
        if (expected.size !== zip.entries.size || [...zip.entries.keys()].some(name => !expected.has(name)))
          invalid('В ZIP есть неожиданные файлы')
        writeDurableJson(resolve(temporary, 'metadata.json'), set)
        renameSync(temporary, final)
        return set
      } catch (error) { rmSync(temporary, { recursive: true, force: true }); throw error }
    } finally { zip.close() }
  } finally { rmSync(upload, { force: true }) }
}
