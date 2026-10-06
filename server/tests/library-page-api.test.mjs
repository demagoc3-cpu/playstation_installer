import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createError } from 'h3'

test('WEB API returns only a page; bulk installation resolves off-page DLC and excludes installed/queued packages on the server', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-library-pages-'))
  const previousData = process.env.PACKAGEFLOW_DATA_DIR, previousHost = process.env.PACKAGEFLOW_HOST_IP
  const globals = Object.fromEntries(['defineEventHandler', 'getQuery', 'getHeader', 'createError'].map(name => [name, globalThis[name]]))
  try {
    process.env.PACKAGEFLOW_DATA_DIR = join(work, 'data')
    process.env.PACKAGEFLOW_HOST_IP = '10.1.10.31'
    mkdirSync(process.env.PACKAGEFLOW_DATA_DIR)
    const path = join(work, 'source.pkg'); writeFileSync(path, 'source remains available')
    const packages = Array.from({ length: 2800 }, (_, index) => ({
      id: `pkg-${index}`, path, sourceModifiedAt: 1, libraryRoot: work, fileName: `release-${index}.pkg`,
      title: `Game ${index}`, titleId: `CUSA${String(index).padStart(5, '0')}`, contentId: `CONTENT-${index}`, contentType: index === 2799 ? 'PS4AC' : 'PS4GD',
      type: index === 2799 ? 'DLC' : 'Игра', installOrder: index === 2799 ? 2 : 0, size: 1024,
      packageDigest: createHash('sha256').update(String(index)).digest('hex'), iconSize: 0, icon: { offset: 0, size: 0 }, installedAt: index === 2798 ? 123 : undefined,
    }))
    writeFileSync(join(process.env.PACKAGEFLOW_DATA_DIR, 'package-library.json'), JSON.stringify({ version: 2, packages, deliveries: {} }))
    writeFileSync(join(process.env.PACKAGEFLOW_DATA_DIR, 'installation-queue.json'), JSON.stringify({ version: 1, status: 'completed', transport: 'payload', psIp: '10.1.10.32', items: [{ packageId: 'pkg-2797', state: 'failed' }] }))
    globalThis.defineEventHandler = handler => handler
    globalThis.getQuery = event => event.query
    globalThis.getHeader = (_event, name) => name === 'host' ? '10.1.10.31:3100' : undefined
    globalThis.createError = createError
    const pageBundle = join(work, 'pages.mjs'), installBundle = join(work, 'install.mjs')
    await build({ entryPoints: [resolve('server/api/packages/index.get.ts')], outfile: pageBundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    await build({ entryPoints: [resolve('server/utils/library-installation.ts')], outfile: installBundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const handler = (await import(pathToFileURL(pageBundle).href)).default
    const first = await handler({ query: {} })
    assert.equal(first.packages.length, 25)
    assert.equal(first.summary.packages, 2800)
    assert.ok(first.packages.every(item => item.url.startsWith('http://10.1.10.31:3100/json/')))
    assert.ok(first.packages.every(item => !('path' in item) && !('icon' in item)), 'private source metadata is not exposed')
    const found = await handler({ query: { q: 'release-2799' } })
    assert.deepEqual(found.packages.map(item => item.id), ['pkg-2799'])
    assert.equal(found.total, 1)
    const { libraryInstallationInput } = await import(pathToFileURL(installBundle).href)
    const dlc = await libraryInstallationInput({ scope: 'dlc' }, '10.1.10.32', '10.1.10.31:3100')
    assert.deepEqual(dlc.packageIds, ['pkg-2799'])
    const all = await libraryInstallationInput({ scope: 'all' }, '10.1.10.32', '10.1.10.31:3100')
    assert.equal(all.packageIds.length, 2798)
    assert.ok(!all.packageIds.includes('pkg-2798') && !all.packageIds.includes('pkg-2797'))
    const branch = await libraryInstallationInput({ scope: 'dlc', titleId: 'CUSA02799' }, '10.1.10.32', '10.1.10.31:3100')
    assert.deepEqual(branch.packageIds, dlc.packageIds)
    await assert.rejects(libraryInstallationInput({ scope: 'invalid' }, '10.1.10.32', 'localhost:3000'), error => error.statusCode === 400)
  } finally {
    if (previousData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR; else process.env.PACKAGEFLOW_DATA_DIR = previousData
    if (previousHost === undefined) delete process.env.PACKAGEFLOW_HOST_IP; else process.env.PACKAGEFLOW_HOST_IP = previousHost
    for (const [name, value] of Object.entries(globals)) if (value === undefined) delete globalThis[name]; else globalThis[name] = value
    rmSync(work, { recursive: true, force: true })
  }
})
