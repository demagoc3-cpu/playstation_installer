import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createError } from 'h3'

function fixture(category, version, buildName, size = 0x4000, content = 'EP0000-CUSA00001_00-TESTPACKAGE000000', digest = true) {
  const pairs = Object.entries({ CATEGORY: category, CONTENT_ID: content, TITLE_ID: 'CUSA00001', TITLE: 'Index test', APP_VER: version })
  const keys = Buffer.from(pairs.map(([key]) => key + '\0').join('')), values = Buffer.from(pairs.map(([, value]) => value + '\0').join(''))
  const keyStart = 20 + pairs.length * 16, valueStart = keyStart + keys.length, sfo = Buffer.alloc(valueStart + values.length)
  sfo.writeUInt32LE(0x46535000); sfo.writeUInt32LE(keyStart, 8); sfo.writeUInt32LE(valueStart, 12); sfo.writeUInt32LE(pairs.length, 16)
  let k = 0, v = 0
  pairs.forEach(([key, value], i) => { const at = 20 + i * 16; sfo.writeUInt16LE(k, at); sfo.writeUInt16LE(0x204, at + 2); sfo.writeUInt32LE(value.length + 1, at + 4); sfo.writeUInt32LE(v, at + 12); k += key.length + 1; v += value.length + 1 })
  keys.copy(sfo, keyStart); values.copy(sfo, valueStart)
  const pkg = Buffer.alloc(size); Buffer.from('7f434e54', 'hex').copy(pkg)
  pkg.writeUInt32BE(1, 0x10); pkg.writeUInt32BE(0x1000, 0x18); pkg.writeUInt32BE(0x1a, 0x74)
  pkg.writeUInt32BE(0x1000, 0x1000); pkg.writeUInt32BE(0x2000, 0x1010); pkg.writeUInt32BE(sfo.length, 0x1014); sfo.copy(pkg, 0x2000)
  if (digest) createHash('sha256').update(buildName).digest().copy(pkg, 0xfe0)
  return pkg
}

test('PKG index merges mount aliases and copies while retaining variants, stable IDs, fallback paths and installation marks', async () => {
  const cwd = process.cwd(), work = mkdtempSync(join(tmpdir(), 'pf-index-')), root = join(work, 'games'), copies = join(work, 'mount')
  mkdirSync(root); mkdirSync(copies)
  const original = join(root, 'game.pkg'), duplicate = join(copies, 'renamed.pkg')
  writeFileSync(original, fixture('gd', '01.00', 'base')); copyFileSync(original, duplicate)
  writeFileSync(join(root, 'patch.pkg'), fixture('gp', '01.01', 'patch'))
  copyFileSync(join(root, 'patch.pkg'), join(copies, 'patch-copy.pkg'))
  writeFileSync(join(copies, 'patch-russian.pkg'), fixture('gp', '01.01', 'russian'))
  writeFileSync(join(copies, 'patch-new.pkg'), fixture('gp', '01.02', 'new-version'))
  writeFileSync(join(copies, 'different-size.pkg'), fixture('gd', '01.00', 'base', 0x5000))
  writeFileSync(join(copies, 'unknown1.pkg'), fixture('al', '01.00', '', 0x4000, 'EP0000-CUSA00001_00-DLC0000000000000', false))
  copyFileSync(join(copies, 'unknown1.pkg'), join(copies, 'unknown2.pkg'))
  const bundle = join(work, 'library.mjs')
  await build({ entryPoints: [resolve(cwd, 'server/utils/package-library.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  globalThis.createError = createError
  process.chdir(work)
  try {
    const api = await import(pathToFileURL(bundle).href)
    const first = await api.scanPackageFolder(root), base = first.packages.find(p => p.type === 'Игра'), patch = first.packages.find(p => p.type === 'Патч')
    const second = await api.scanPackageFolder(copies)
    assert.equal(second.packages.find(p => p.fileName === 'game.pkg').id, base.id)
    assert.equal(api.getLibraryPackages().length, 7)
    const raw = () => JSON.parse(readFileSync(join(work, '.data/package-library.json'))).packages
    const alias = raw().find(p => p.path === duplicate).id
    assert.equal(api.getPackage(alias).path, duplicate, 'previously accepted URLs remain usable')
    assert.ok(api.getLibraryPackages().find(p => p.id === base.id).sourceIds.includes(alias), 'old torrent IDs resolve to the canonical package')
    api.markPackageInstalled(alias, true)
    const installedAt = api.getLibraryPackages().find(p => p.id === base.id).installedAt
    assert.ok(installedAt)
    await api.scanPackageFolder(root); await api.scanPackageFolder(copies); await api.scanPackageFolder(root)
    assert.equal(api.getLibraryPackages().length, 7)
    assert.equal(api.getLibraryPackages().find(p => p.id === base.id).installedAt, installedAt, 'cache does not undo current installation marks')
    api.markPackageInstalled(alias, false); await api.scanPackageFolder(copies)
    assert.equal(api.getLibraryPackages().find(p => p.id === base.id).installedAt, undefined)
    api.markPackageInstalled(patch.id, true); await api.scanPackageFolder(root)
    assert.ok(api.getLibraryPackages().find(p => p.id === patch.id).installedAt)
    const branch = await api.scanPackageFolder(root, 'CUSA00001')
    assert.equal(branch.packages.length, 7, 'reindex retains variants from other sources')
    unlinkSync(original)
    assert.equal(api.getPackage(base.id).path, duplicate)
    assert.equal(api.getLibraryPackages().find(p => p.id === base.id).id, base.id)
    api.removePackageFromLibrary(base.id)
    assert.equal(api.getLibraryPackages().length, 6)
    assert.throws(() => api.getPackage(alias))
    assert.ok(readFileSync(duplicate).length, 'removing an indexed package never deletes its sources')
  } finally { process.chdir(cwd); rmSync(work, { recursive: true, force: true }) }
})

test('PKG scan indexes more than 500 packages across folders on fresh and cached scans', async () => {
  const cwd = process.cwd(), work = mkdtempSync(join(tmpdir(), 'pf-large-index-'))
  const root = join(work, 'games'), nested = join(root, 'updates', 'nested'), excluded = join(root, '.packageflow')
  mkdirSync(nested, { recursive: true }); mkdirSync(excluded)
  const names = []
  for (let index = 0; index < 800; index++) {
    const name = `game-${String(index).padStart(4, '0')}.${index < 600 ? 'pkg' : 'FPKG'}`
    names.push(name)
    writeFileSync(join(index < 600 ? root : nested, name), fixture('gd', '01.00', `large-${index}`))
  }
  writeFileSync(join(excluded, 'ignored.pkg'), fixture('gd', '01.00', 'ignored'))
  writeFileSync(join(root, 'invalid.pkg'), 'Not a PKG')
  const bundle = join(work, 'library.mjs')
  await build({ entryPoints: [resolve(cwd, 'server/utils/package-library.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  globalThis.createError = createError
  process.chdir(work)
  try {
    const api = await import(pathToFileURL(bundle).href)
    const first = await api.scanPackageFolder(root)
    assert.deepEqual(first.packages.map(item => item.fileName).sort(), names.slice().sort())
    assert.equal(api.getLibraryPackages().length, 800)
    const sentinel = first.packages.find(item => item.fileName === names.at(-1))
    api.markPackageInstalled(sentinel.id, true)
    const installedAt = api.getPackage(sentinel.id).installedAt
    writeFileSync(join(nested, 'new.pkg'), fixture('gd', '01.00', 'new-after-cache'))
    const again = await api.scanPackageFolder(root)
    assert.deepEqual(again.packages.map(item => item.fileName).sort(), [...names, 'new.pkg'].sort())
    assert.equal(api.getLibraryPackages().length, 801)
    const ids = new Map(again.packages.map(item => [item.fileName, item.id]))
    for (const item of first.packages) assert.equal(ids.get(item.fileName), item.id)
    assert.equal(api.getPackage(sentinel.id).installedAt, installedAt)
  } finally { process.chdir(cwd); rmSync(work, { recursive: true, force: true }) }
})
