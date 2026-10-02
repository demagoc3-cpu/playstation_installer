import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

function makePackage() {
  const values = { CATEGORY: 'gd', CONTENT_ID: 'EP0101-CUSA18740_00-PES2021000000000', TITLE_ID: 'CUSA18740', TITLE: 'Read-only library', APP_VER: '01.00' }
  const keys = Buffer.concat(Object.keys(values).map(key => Buffer.from(`${key}\0`)))
  const data = Object.values(values).map(value => Buffer.from(`${value}\0`))
  const sfo = Buffer.alloc(20 + 16 * data.length + keys.length + data.reduce((total, value) => total + value.length, 0))
  Buffer.from('00505346', 'hex').copy(sfo)
  sfo.writeUInt32LE(20 + 16 * data.length, 8)
  sfo.writeUInt32LE(20 + 16 * data.length + keys.length, 12)
  sfo.writeUInt32LE(data.length, 16)
  let keyOffset = 0, dataOffset = 0
  Object.keys(values).forEach((key, index) => {
    const offset = 20 + 16 * index
    sfo.writeUInt16LE(keyOffset, offset)
    sfo.writeUInt16LE(0x204, offset + 2)
    sfo.writeUInt32LE(data[index].length, offset + 4)
    sfo.writeUInt32LE(dataOffset, offset + 12)
    keyOffset += Buffer.byteLength(key) + 1
    dataOffset += data[index].length
  })
  keys.copy(sfo, 20 + 16 * data.length)
  Buffer.concat(data).copy(sfo, 20 + 16 * data.length + keys.length)
  const icon = Buffer.from('89504e470d0a1a0a', 'hex')
  const pkg = Buffer.alloc(0x4000)
  Buffer.from('7f434e54', 'hex').copy(pkg)
  pkg.writeUInt32BE(2, 0x10)
  pkg.writeUInt32BE(0x1000, 0x18)
  pkg.writeUInt32BE(0x1a, 0x74)
  pkg.writeUInt32BE(0x1000, 0x1000)
  pkg.writeUInt32BE(0x2000, 0x1010)
  pkg.writeUInt32BE(sfo.length, 0x1014)
  pkg.writeUInt32BE(0x1200, 0x1020)
  pkg.writeUInt32BE(0x3000, 0x1030)
  pkg.writeUInt32BE(icon.length, 0x1034)
  sfo.copy(pkg, 0x2000)
  icon.copy(pkg, 0x3000)
  return { pkg, icon }
}

test('read-only PKG folder can be scanned and cached with covers in application data', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('Requires Unix file permissions and a non-root user')
  const project = fileURLToPath(new URL('../../', import.meta.url))
  const work = mkdtempSync(join(tmpdir(), 'packageflow-readonly-'))
  const source = join(work, 'games')
  const originalCwd = process.cwd()
  mkdirSync(source)
  const { pkg, icon } = makePackage()
  writeFileSync(join(source, 'game.pkg'), pkg, { mode: 0o444 })
  chmodSync(source, 0o555)
  const bundle = join(work, 'package-library.mjs')
  try {
    assert.throws(() => writeFileSync(join(source, 'probe'), ''), error => error.code === 'EACCES')
    await build({ entryPoints: [resolve(project, 'server/utils/package-library.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    process.chdir(work)
    const library = await import(pathToFileURL(bundle).href)
    const result = await library.scanPackageFolder(source)
    assert.equal(result.packages.length, 1)
    assert.equal(result.packages[0].title, 'Read-only library')
    assert.equal(result.packages[0].iconSize, icon.length)
    assert.deepEqual(await library.readPackageIcon(result.packages[0].id), icon)
    assert.deepEqual(readdirSync(source), ['game.pkg'])
    assert.ok(existsSync(join(work, '.data/package-library.json')))
    const cache = readdirSync(join(work, '.data/package-cache'))
    assert.equal(cache.length, 1)
    assert.ok(existsSync(join(work, '.data/package-cache', cache[0], 'index.json')))
    const again = await library.scanPackageFolder(source)
    assert.equal(again.packages[0].id, result.packages[0].id)
    assert.deepEqual(await library.readPackageIcon(again.packages[0].id), icon)
  } finally {
    process.chdir(originalCwd)
    chmodSync(source, 0o755)
    rmSync(work, { recursive: true, force: true })
  }
})
