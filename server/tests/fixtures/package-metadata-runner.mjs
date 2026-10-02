import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const directory = mkdtempSync(resolve(tmpdir(), 'packageflow-metadata-'))
process.chdir(directory)
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) }
  catch (error) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) return next(`${specifier}.ts`, context)
    throw error
  }
} })

function sfo(values) {
  const keys = Buffer.concat(Object.keys(values).map((key) => Buffer.from(`${key}\0`)))
  const encoded = Object.values(values).map((value) => typeof value === 'number' ? Buffer.from(Uint8Array.of(value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255)) : Buffer.from(`${value}\0`))
  const data = Buffer.concat(encoded)
  const count = Object.keys(values).length
  const result = Buffer.alloc(20 + 16 * count + keys.length + data.length)
  Buffer.from('00505346', 'hex').copy(result)
  result.writeUInt32LE(20 + 16 * count, 8)
  result.writeUInt32LE(20 + 16 * count + keys.length, 12)
  result.writeUInt32LE(count, 16)
  let keyOffset = 0, valueOffset = 0
  for (const [index, [key, value]] of Object.entries(values).entries()) {
    const position = 20 + index * 16
    result.writeUInt16LE(keyOffset, position)
    result.writeUInt16LE(typeof value === 'number' ? 0x404 : 0x204, position + 2)
    result.writeUInt32LE(encoded[index].length, position + 4)
    result.writeUInt32LE(valueOffset, position + 12)
    keyOffset += Buffer.byteLength(key) + 1
    valueOffset += encoded[index].length
  }
  keys.copy(result, 20 + 16 * count)
  data.copy(result, 20 + 16 * count + keys.length)
  return result
}

function packageFile(name, category, flags, appVersion, firmware = {}, headerType = 0x1a) {
  const contentId = 'EP0101-CUSA18740_00-PES2021000000000'
  const metadata = sfo({ CATEGORY: category, CONTENT_ID: contentId, TITLE_ID: 'CUSA18740', TITLE: 'eFootball PES 2026', VERSION: '01.00', APP_VER: appVersion, ...firmware })
  const file = Buffer.alloc(0x4000)
  Buffer.from('7f434e54', 'hex').copy(file)
  file.writeUInt32BE(1, 0x10)
  file.writeUInt32BE(0x1000, 0x18)
  file.writeUInt32BE(headerType, 0x74)
  file.writeUInt32BE(flags, 0x78)
  Buffer.from('00505346', 'hex').copy(file, 0x1800) // decoy before the real table entry
  file.writeUInt32BE(0x1000, 0x1000)
  file.writeUInt32BE(0x2000, 0x1010)
  file.writeUInt32BE(metadata.length, 0x1014)
  metadata.copy(file, 0x2000)
  writeFileSync(name, file)
  return resolve(name)
}

try {
  const { readPackageMetadata } = await import(pathToFileURL(resolve(root, 'server/utils/package-library.ts')).href)
  const base = await readPackageMetadata(packageFile('base.pkg', 'gd', 0x0a000000, '01.00', { SYSTEM_VER: 0x05050000, PUBTOOLINFO: 'c_date=20200101,sdk_ver=05050001' }), 'base.pkg')
  const patch = await readPackageMetadata(packageFile('patch.pkg', 'gp', 0x62300000, '01.08', { SYSTEM_VER: 0x07000000, PUBTOOLINFO: 'sdk_ver=05050001' }), 'patch.pkg')
  const addonWithData = await readPackageMetadata(packageFile('addon-data.pkg', 'ac', 0x0a000000, '01.00', {}, 0x1b), 'addon-data.pkg')
  const licenseOnly = await readPackageMetadata(packageFile('addon-license.pkg', 'ac', 0x08000000, '01.00', {}, 0x1c), 'addon-license.pkg')
  const remaster = await readPackageMetadata(packageFile('remaster.pkg', 'gd', 0x6a700000, '01.04'), 'remaster.pkg')
  assert.equal(remaster.type, 'Игра')
  assert.equal(remaster.contentType, 'PS4GD')
  assert.equal(remaster.packageVolume, 'application')
  assert.equal(base.contentId, patch.contentId)
  assert.equal(base.type, 'Игра')
  assert.equal(base.packageVolume, 'application')
  assert.equal(base.appVersion, '01.00')
  assert.equal(patch.type, 'Патч')
  assert.equal(patch.packageVolume, 'patch')
  assert.equal(patch.appVersion, '01.08')
  assert.equal(patch.masterVersion, '01.00')
  assert.equal(base.requiredFirmware, '5.05')
  assert.equal(base.sdkFirmware, '5.05')
  assert.equal(patch.requiredFirmware, '7.00')
  assert.equal(patch.sdkFirmware, '5.05')
  assert.equal(addonWithData.type, 'DLC')
  assert.equal(addonWithData.contentType, 'PS4AC')
  assert.equal(licenseOnly.type, 'DLC')
  assert.equal(licenseOnly.contentType, 'PS4AL')
} finally { rmSync(directory, { recursive: true, force: true }) }
