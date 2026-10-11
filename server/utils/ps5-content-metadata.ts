import { open, readdir, stat, lstat, realpath, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { inflateSync } from 'node:zlib'
import type { ContentFormat } from '../../shared/types/consoles'

const LIMIT = 2 * 1024 * 1024
interface Reader { size: number; read(offset: number, length: number): Promise<Buffer> }
interface Entry { name: string; directory: boolean; read(): Promise<Buffer>; entries(): Promise<Entry[]> }
const u64 = (data: Buffer, offset: number) => {
  const value = Number(data.readBigUInt64LE(offset))
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid image offset')
  return value
}
const power = (value: number, max = 1024 * 1024) => value >= 512 && value <= max && (value & (value - 1)) === 0
const safeName = (name: string) => !!name && name.length <= 255 && !/[\\/\x00-\x1f]/.test(name) && !['.', '..'].includes(name)

/** Read metadata only. No mounting, extraction, game execution or source writes. */
async function fileReader(path: string) {
  const handle = await open(path, 'r'), info = await handle.stat()
  let budget = 32 * 1024 * 1024, operations = 0
  const reader: Reader = { size: info.size, async read(offset, length) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > LIMIT || offset + length > info.size || (budget -= length) < 0 || ++operations > 8192) throw new Error('Metadata read limit exceeded')
    const data = Buffer.alloc(length)
    let read = 0
    while (read < length) { const part = await handle.read(data, read, length - read, offset + read); if (!part.bytesRead) throw new Error('Truncated image'); read += part.bytesRead }
    return data
  } }
  return { reader, close: () => handle.close() }
}

/** exFAT directory and allocation layout: Microsoft exFAT specification,
 * sections 3, 6 and 7. Only requested metadata files are read. */
async function exfatEntries(reader: Reader): Promise<Entry[]> {
  const boot = await reader.read(0, 512)
  if (boot.toString('ascii', 3, 11) !== 'EXFAT   ' || boot.readUInt16LE(510) !== 0xaa55) throw new Error('Invalid exFAT image')
  const sector = 2 ** boot[108]!, cluster = sector * 2 ** boot[109]!
  const fat = boot.readUInt32LE(80) * sector, heap = boot.readUInt32LE(88) * sector, count = boot.readUInt32LE(92)
  if (!power(sector, 4096) || !power(cluster) || !count || heap + count * cluster > reader.size) throw new Error('Invalid exFAT geometry')
  async function data(first: number, contiguous: boolean, length: number, directory = false) {
    if (length > LIMIT) throw new Error('Metadata file too large')
    const parts: Buffer[] = [], seen = new Set<number>(); let current = first, bytes = 0
    while (current >= 2 && current < count + 2 && (!length || bytes < length)) {
      if (seen.has(current) || bytes + cluster > LIMIT) throw new Error('Invalid exFAT chain')
      seen.add(current)
      const part = await reader.read(heap + (current - 2) * cluster, Math.min(cluster, length ? length - bytes : cluster))
      parts.push(part); bytes += part.length
      if (directory && [...Array(Math.floor(part.length / 32)).keys()].some(i => part[i * 32] === 0)) break
      if (contiguous) { if (!length) throw new Error('Invalid contiguous directory'); current++ }
      else { const link = await reader.read(fat + current * 4, 4); current = link.readUInt32LE(); if (current >= 0xfffffff8) break }
    }
    if (length && bytes < length && !directory) throw new Error('Incomplete exFAT file')
    return Buffer.concat(parts)
  }
  async function directory(first: number, contiguous = false, length = 0): Promise<Entry[]> {
    const raw = await data(first, contiguous, length, true), result: Entry[] = []
    for (let offset = 0; offset + 32 <= raw.length && raw[offset]; offset += 32) {
      if (raw[offset] !== 0x85) continue
      const n = raw[offset + 1]!, end = offset + (n + 1) * 32, stream = offset + 32
      if (n < 2 || end > raw.length || raw[stream] !== 0xc0) throw new Error('Invalid exFAT entry')
      const names: Buffer[] = []
      for (let i = stream + 32; i < end; i += 32) { if (raw[i] !== 0xc1) throw new Error('Invalid exFAT name'); names.push(raw.subarray(i + 2, i + 32)) }
      const name = Buffer.concat(names).toString('utf16le').slice(0, raw[stream + 3])
      const isDirectory = !!(raw.readUInt16LE(offset + 4) & 0x10), firstCluster = raw.readUInt32LE(stream + 20), size = u64(raw, stream + 24), noFat = !!(raw[stream + 1]! & 2)
      if (safeName(name)) result.push({ name, directory: isDirectory, read: () => data(firstCluster, noFat, size), entries: () => directory(firstCluster, noFat, size) })
      offset = end - 32
    }
    return result
  }
  return directory(boot.readUInt32LE(96))
}

async function ufsEntries(reader: Reader): Promise<Entry[]> {
  const sb = await reader.read(65536, 1536)
  if (sb.readUInt32LE(0x55c) !== 0x19540119) throw new Error('Invalid UFS2 image')
  const block = sb.readUInt32LE(48), fragment = sb.readUInt32LE(52), table = sb.readUInt32LE(16), perGroup = sb.readUInt32LE(184), groupFragments = sb.readUInt32LE(188), groups = sb.readUInt32LE(44)
  if (!power(block) || !power(fragment) || fragment > block || !perGroup || !groups || !groupFragments) throw new Error('Invalid UFS2 geometry')
  async function inode(id: number) {
    if (id >= perGroup * groups) throw new Error('Invalid UFS2 inode')
    const raw = await reader.read((Math.floor(id / perGroup) * groupFragments + table) * fragment + id % perGroup * 256, 256)
    return { raw, size: u64(raw, 16), directory: (raw.readUInt16LE() & 0xf000) === 0x4000 }
  }
  async function data(id: number) {
    const item = await inode(id)
    if (item.size > LIMIT) throw new Error('Metadata file too large')
    const parts: Buffer[] = []
    let indirect: Buffer | undefined
    for (let index = 0, bytes = 0; bytes < item.size; index++) {
      if (index >= 12 && !indirect) indirect = await reader.read(u64(item.raw, 208) * fragment, block)
      const pointer = index < 12 ? u64(item.raw, 112 + index * 8) : u64(indirect!, (index - 12) * 8)
      if (!pointer) throw new Error('Sparse metadata is unsupported')
      const length = Math.min(block, item.size - bytes); parts.push(await reader.read(pointer * fragment, length)); bytes += length
    }
    return Buffer.concat(parts)
  }
  async function directory(id: number): Promise<Entry[]> {
    const raw = await data(id), result: Entry[] = []
    for (let at = 0; at + 8 <= raw.length;) {
      const child = raw.readUInt32LE(at), length = raw.readUInt16LE(at + 4), nameLength = raw[at + 7]!
      if (length < 8 || at + length > raw.length || nameLength > length - 8) throw new Error('Invalid UFS2 directory')
      const name = raw.toString('utf8', at + 8, at + 8 + nameLength)
      if (child && safeName(name)) result.push({ name, directory: raw[at + 6] === 4, read: () => data(child), entries: () => directory(child) })
      at += length
    }
    return result
  }
  return directory(2)
}

/** Unsigned PS5 PFS and its zlib PFSC allocation. Signed/encrypted images are
 * rejected; the metadata scanner never decrypts protected retail packages. */
async function pfsEntries(reader: Reader): Promise<{ entries: Entry[]; compressed: boolean }> {
  const header = await reader.read(0, 1024), mode = header.readUInt16LE(28), block = header.readUInt32LE(32)
  if (u64(header, 0) !== 2 || u64(header, 8) !== 20130315 || mode & 7 || !power(block)) throw new Error('Unsupported PFS image')
  const inodeCount = u64(header, 48), tableBlocks = u64(header, 64), perBlock = Math.floor(block / 168)
  if (!inodeCount || inodeCount > 1000000 || !tableBlocks || inodeCount > tableBlocks * perBlock) throw new Error('Invalid PFS inode table')
  let compressed = false
  const inode = async (id: number) => {
    if (id >= inodeCount) throw new Error('Invalid PFS inode')
    return reader.read(block + Math.floor(id / perBlock) * block + id % perBlock * 168, 168)
  }
  async function view(id: number): Promise<Reader> {
    const raw = await inode(id), packedSize = u64(raw, 8), logicalSize = u64(raw, 16), base = raw.readUInt32LE(100) * block, packed = !!(raw.readUInt32LE(4) & 1), size = packed ? logicalSize : packedSize, stored = packed ? packedSize : logicalSize
    const contiguous = Array.from({ length: 11 }, (_, index) => raw.readInt32LE(104 + index * 4)).every(value => value === -1) &&
      // Builders use either zero or UINT32_MAX for unused indirect slots.
      Array.from({ length: 5 }, (_, index) => raw.readUInt32LE(148 + index * 4)).every(value => value === 0 || value === 0xffffffff) &&
      raw.readUInt32LE(96) >= Math.ceil((packed ? stored : size) / block)
    const allocated: Reader = { size: packed ? stored : size, async read(offset, length) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > LIMIT || offset + length > this.size) throw new Error('Invalid PFS file range')
      const parts: Buffer[] = []
      for (let at = offset; at < offset + length;) {
        const index = Math.floor(at / block), within = at % block
        let pointer: number
        if (contiguous) pointer = base / block + index
        else if (index < 12) pointer = raw.readUInt32LE(100 + index * 4)
        else { const indirect = raw.readUInt32LE(148); if (!indirect || index - 12 >= block / 4) throw new Error('Unsupported PFS allocation'); pointer = (await reader.read(indirect * block + (index - 12) * 4, 4)).readUInt32LE() }
        if (!pointer || pointer === 0xffffffff || pointer * block >= reader.size) throw new Error('Invalid PFS allocation')
        const take = Math.min(block - within, offset + length - at); parts.push(await reader.read(pointer * block + within, take)); at += take
      }
      return Buffer.concat(parts)
    } }
    if (!packed) return allocated
    compressed = true
    const head = await allocated.read(0, 48), unit = head.readUInt32LE(12), table = u64(head, 24), logical = u64(head, 40)
    if (head.toString('ascii', 0, 4) !== 'PFSC' || head.readUInt32LE(8) !== 6 || unit !== 65536 || u64(head, 16) !== unit || logical < size || !stored || table < 48) throw new Error('Invalid PFSC header')
    const cache = new Map<number, Buffer>()
    return { size, async read(offset, length) {
      if (offset < 0 || length > LIMIT || offset + length > size) throw new Error('Invalid PFSC range')
      const parts: Buffer[] = []
      for (let at = offset; at < offset + length;) {
        const index = Math.floor(at / unit), within = at % unit
        let decoded = cache.get(index)
        if (!decoded) {
          const pair = await allocated.read(table + index * 8, 16), from = u64(pair, 0), to = u64(pair, 8)
          if (from < table || to <= from || to > stored || to - from > unit) throw new Error('Invalid PFSC block')
          const input = await allocated.read(from, to - from)
          const expected = Math.min(unit, size - index * unit)
          decoded = input.length === unit || input.length === expected ? input : inflateSync(input, { maxOutputLength: unit })
          if (decoded.length < expected || decoded.length > unit) throw new Error('Invalid PFSC decoded size')
          if (cache.size >= 16) cache.delete(cache.keys().next().value!); cache.set(index, decoded)
        }
        const take = Math.min(unit - within, offset + length - at); parts.push(decoded.subarray(within, within + take)); at += take
      }
      return Buffer.concat(parts)
    } }
  }
  function dirents(raw: Buffer) {
    const result: Array<{ id: number; name: string; directory: boolean }> = []
    for (let at = 0; at + 16 <= raw.length;) {
      const id = raw.readUInt32LE(at), kind = raw.readUInt32LE(at + 4), nameLength = raw.readUInt32LE(at + 8), length = raw.readUInt32LE(at + 12)
      if (!length && !id) break
      if (length < 24 || length % 8 || at + length > raw.length || nameLength > length - 16) throw new Error('Invalid PFS directory')
      const name = raw.toString('utf8', at + 16, at + 16 + nameLength)
      if (safeName(name)) result.push({ id, name, directory: kind === 3 }); at += length
    }
    return result
  }
  async function directory(id: number): Promise<Entry[]> {
    const file = await view(id)
    if (file.size > LIMIT) throw new Error('PFS directory too large')
    return dirents(await file.read(0, file.size)).map(item => ({ name: item.name, directory: item.directory, read: async () => { const file = await view(item.id); if (file.size > LIMIT) throw new Error('Metadata file too large'); return file.read(0, file.size) }, entries: () => directory(item.id) }))
  }
  const superroot = dirents(await reader.read((1 + tableBlocks) * block, block)), root = superroot.find(item => item.name === 'uroot')
  if (!root) throw new Error('PFS root missing')
  let entries = await directory(root.id)
  if (entries.length === 1 && !entries[0]!.directory) {
    const rawRoot = await view(root.id), rootEntry = dirents(await rawRoot.read(0, rawRoot.size))[0]!
    const inner = await view(rootEntry.id)
    if ((await inner.read(0, Math.min(512, inner.size))).toString('ascii', 3, 11) === 'EXFAT   ') entries = await exfatEntries(inner)
  }
  return { entries, compressed }
}

export function ps5ParamMetadata(raw: Buffer) {
  if (raw.length > 128 * 1024) throw new Error('param.json too large')
  const value = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''))
  if (!/^PPSA\d{5}$/.test(value.titleId || '') || typeof value.contentId !== 'string' || !value.contentId.includes(`${value.titleId}_`)) throw new Error('Invalid PS5 metadata')
  const localized = value.localizedParameters || {}, name = localized['ru-RU']?.titleName || localized[localized.defaultLanguage]?.titleName || localized['en-US']?.titleName
  if (typeof name !== 'string' || !name.trim() || name.length > 512 || /[\x00-\x1f]/.test(name)) throw new Error('Invalid PS5 title')
  const firmware = (field: unknown, allowZero = false) => { const match = typeof field === 'string' && /^0x([0-9a-f]{8})([0-9a-f]{8})$/i.exec(field); const version = match && (match[1] === '00000000' ? match[2] : match[1]); return version && /^\d{4}/.test(version) && (allowZero || !/^0000/.test(version)) ? `${Number(version.slice(0, 2))}.${version.slice(2, 4)}` : undefined }
  // Unknown PS5 category values must not be treated as a base game.
  const category = value.applicationCategoryType
  if (category !== 0) throw new Error('Unsupported PS5 category')
  return { platform: 'ps5' as const, signature: 'unknown' as const, title: name.trim(), titleId: value.titleId as string, contentId: value.contentId as string, appVersion: String(value.contentVersion || ''), masterVersion: String(value.masterVersion || ''), requiredFirmware: firmware(value.requiredSystemSoftwareVersion, true), sdkFirmware: firmware(value.sdkVersion), type: 'Игра' as const, contentType: 'PS5GD', packageVolume: 'application' as const, installOrder: 0, packageDigest: '' }
}

async function metadata(entries: Entry[], depth = 0, includeCover = true): Promise<{ param: Buffer; cover?: Buffer }> {
  const sys = entries.find(item => item.directory && item.name.toLowerCase() === 'sce_sys')
  if (sys) { const files = await sys.entries(), param = files.find(item => !item.directory && item.name.toLowerCase() === 'param.json'); if (param) return { param: await param.read(), cover: includeCover ? await files.find(item => !item.directory && item.name.toLowerCase() === 'icon0.png')?.read().catch(() => undefined) : undefined } }
  if (depth === 0) for (const folder of entries.filter(item => item.directory && /^PPSA\d{5}$/i.test(item.name))) { try { return await metadata(await folder.entries(), depth + 1, includeCover) } catch {} }
  throw new Error('PS5 param.json missing')
}

export async function readPs5ImageMetadata(path: string, includeCover = true) {
  const source = await fileReader(path)
  try {
    const head = await source.reader.read(0, Math.min(512, source.reader.size))
    // Finalized PS5 PKG: read the public CNT metadata table at the FIH offset.
    // Layout reference: ps5upload's FIH/CNT readers. Protected entries are refused.
    if (head.readUInt32BE(0) === 0x7f464948) {
      if (head.readUInt16LE(6) !== 3 || ![0, 0x80].includes(head[5]!)) throw new Error('Unsupported FIH image')
      const base = u64(head, 88), cnt = await source.reader.read(base, 256)
      if (cnt.readUInt32BE(0) !== 0x7f434e54) throw new Error('Invalid PS5 metadata container')
      const count = cnt.readUInt32BE(16), at = cnt.readUInt32BE(24)
      if (!count || count > 4096 || at < 32) throw new Error('Invalid PS5 metadata table')
      const table = await source.reader.read(base + at, count * 32)
      async function entry(id: number) {
        for (let i = 0; i < table.length; i += 32) if (table.readUInt32BE(i) === id) {
          if (table.readUInt32BE(i + 8) & 0x10000000 || table.readUInt32BE(i + 12) & 0xfffff000) throw new Error('Protected metadata')
          return source.reader.read(base + table.readUInt32BE(i + 16), table.readUInt32BE(i + 20))
        }
        throw new Error('PS5 metadata entry missing')
      }
      const param = ps5ParamMetadata(await entry(0x2000))
      return { ...param, format: 'pkg' as const, signature: head[5] === 0 ? 'fake' as const : 'retail' as const, cover: includeCover ? await entry(0x1200).catch(() => undefined) : undefined }
    }
    let format: ContentFormat, entries: Entry[]
    if (head.toString('ascii', 3, 11) === 'EXFAT   ') { format = 'exfat'; entries = await exfatEntries(source.reader) }
    else if (head.length >= 16 && u64(head, 0) === 2 && u64(head, 8) === 20130315) { const pfs = await pfsEntries(source.reader); format = pfs.compressed ? 'ffpfsc' : 'pfs'; entries = pfs.entries }
    else { format = 'ufs2'; entries = await ufsEntries(source.reader) }
    const result = await metadata(entries, 0, includeCover)
    return { ...ps5ParamMetadata(result.param), format, cover: result.cover }
  } finally { await source.close() }
}

export async function readPs5FolderParam(path: string) {
  const root = await realpath(path)
  const paramPath = join(root, 'sce_sys', 'param.json'), bootPath = join(root, 'eboot.bin')
  for (const file of [paramPath, bootPath]) { const info = await lstat(file); if (!info.isFile() || await realpath(file) !== file) throw new Error('Invalid PS5 folder') }
  if ((await stat(paramPath)).size > 128 * 1024) throw new Error('param.json too large')
  return ps5ParamMetadata(await readFile(paramPath))
}

export async function readPs5FolderMetadata(path: string) {
  const root = await realpath(path), param = await readPs5FolderParam(root)
  let files = 0, size = 0, modifiedAt = 0
  async function measure(directory: string, depth = 0) {
    if (depth > 32) throw new Error('Folder depth limit exceeded')
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Links in PS5 folders are unsupported')
      if (++files > 100000) throw new Error('Folder file limit exceeded')
      const file = resolve(directory, entry.name), info = await stat(file); modifiedAt = Math.max(modifiedAt, info.mtimeMs)
      if (entry.isDirectory()) await measure(file, depth + 1); else if (entry.isFile()) size += info.size
      else throw new Error('Invalid folder entry')
    }
  }
  await measure(root)
  let cover: Buffer | undefined
  const icon = join(root, 'sce_sys', 'icon0.png')
  if (await stat(icon).then(info => info.size <= LIMIT).catch(() => false)) cover = await readFile(icon)
  return { ...param, format: 'folder' as const, size, modifiedAt, cover }
}
