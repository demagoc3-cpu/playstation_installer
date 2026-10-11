import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { dataPath } from './data-path'
import { readPs5ImageMetadata } from './ps5-content-metadata'

export interface SetupElf { fileName: string; size: number; sha256: string; version: string; buildId: string; firmware: string }
export interface SetupApp { fileName: string; size: number; sha256: string; titleId: string; contentId: string; version: string; format: 'ufs2' | 'exfat' | 'pfs' | 'ffpfsc'; name: 'PackageFlow' }
export interface SetupBundle { schemaVersion: 1; elf: SetupElf; app: SetupApp }
const safeName = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v) && !v.includes('..')
export function validateSetupManifest(v: any): SetupBundle {
  if (v?.schemaVersion !== 1 || !v.elf || !v.app) throw new Error('Нет полного комплекта PS5 для этой сборки Windows')
  for (const [role, a] of Object.entries(v) as [string, any][]) if (role === 'elf' || role === 'app') {
    if (!safeName(a.fileName) || !/^[a-f0-9]{64}$/.test(a.sha256) || !Number.isSafeInteger(a.size) || a.size < 4096 || a.size > (role === 'elf' ? 4 : 256) * 1024 ** 2) throw new Error('Неверный манифест комплекта PS5')
  }
  if (v.elf.firmware !== '13.60' || !/^\d+\.\d+\.\d+(?:-dev)?$/.test(v.elf.version) || !/^[a-z0-9-]{1,64}$/.test(v.elf.buildId) || !/\.elf$/.test(v.elf.fileName)) throw new Error('ELF ещё не проверен для этой прошивки')
  if (v.app.name !== 'PackageFlow' || !/^PPSA\d{5}$/.test(v.app.titleId) || typeof v.app.contentId !== 'string' || !/^[A-Z0-9_-]{1,63}$/.test(v.app.contentId) || !v.app.contentId.includes(`${v.app.titleId}_`)
    || !/^\d{2}\.\d{3}\.\d{3}$/.test(v.app.version) || !['ufs2','exfat','pfs','ffpfsc'].includes(v.app.format) || v.app.fileName === v.elf.fileName) throw new Error('Неверное приложение PackageFlow в комплекте PS5')
  return v
}
export async function setupArtifactFile(a: SetupElf | SetupApp) {
  const path = dataPath('console-setup', a.fileName), info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile() || info.size !== a.size) throw new Error('Файл комплекта PS5 изменился')
  const bytes = await readFile(path)
  if (createHash('sha256').update(bytes).digest('hex') !== a.sha256) throw new Error('Контрольная сумма комплекта PS5 не совпала')
  return { path, bytes }
}
type VerifiedBundle = { manifest: SetupBundle; elf: Buffer; appPath: string }
let verified: { fingerprint: string; bundle: VerifiedBundle } | undefined
async function fingerprint(paths: string[]) {
  const parts = await Promise.all(paths.map(async path => {
    const s = await lstat(path, { bigint: true })
    if (!s.isFile() || s.isSymbolicLink()) throw new Error('Неверный путь файла комплекта PS5')
    return `${path}:${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
  }))
  return parts.join('|')
}
// Status polling may reuse a verified, unchanged bundle. Mutating operations
// always hash the files again, regardless of the cached status result.
export async function consoleSetupBundle({ verifyFiles = true } = {}) {
  const manifest = dataPath('console-setup','manifest.json')
  if ((await lstat(manifest)).isSymbolicLink()) throw new Error('Неверный путь манифеста PS5')
  const m = validateSetupManifest(JSON.parse(await readFile(manifest,'utf8')))
  const paths = [manifest, dataPath('console-setup',m.elf.fileName), dataPath('console-setup',m.app.fileName)]
  const before = await fingerprint(paths)
  if (!verifyFiles && verified?.fingerprint === before) return { ...verified.bundle, manifest: structuredClone(verified.bundle.manifest), elf: Buffer.from(verified.bundle.elf) }
  const elf = await setupArtifactFile(m.elf)
  if (!elf.bytes.subarray(0,6).equals(Buffer.from('7f454c460201','hex')) || elf.bytes.readUInt16LE(18) !== 62) throw new Error('Файл полезной нагрузки не является ELF x64')
  const app = await setupArtifactFile(m.app), meta = await readPs5ImageMetadata(app.path, false)
  if (meta.title !== m.app.name || meta.titleId !== m.app.titleId || meta.contentId !== m.app.contentId || meta.appVersion !== m.app.version || meta.format !== m.app.format || meta.platform !== 'ps5' || meta.installOrder !== 0) throw new Error('PARAM приложения не соответствует манифесту PS5')
  if (before !== await fingerprint(paths)) throw new Error('Комплект PS5 изменился при проверке')
  const bundle = { manifest: m, elf: elf.bytes, appPath: resolve(app.path) }
  verified = { fingerprint: before, bundle }
  return { ...bundle, manifest: structuredClone(m), elf: Buffer.from(elf.bytes) }
}
