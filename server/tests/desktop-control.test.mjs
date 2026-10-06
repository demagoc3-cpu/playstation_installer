import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { build } from 'esbuild'

test('installed data location, launcher authorization and stop guards', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'pf-desktop-'))
  const previous = { data: process.env.PACKAGEFLOW_DATA_DIR, key: process.env.PACKAGEFLOW_LAUNCHER_KEY, ip: process.env.PACKAGEFLOW_HOST_IP }
  const bundle = resolve('node_modules/.cache/desktop-control-test.mjs')
  await build({ stdin: { contents: `export * from './server/utils/data-path'; export * from './server/utils/desktop-control'; export * from './server/utils/desktop-lifecycle'; export { getLocalIp } from './server/utils/ps4-installer'`, resolveDir: process.cwd(), loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  try {
    process.env.PACKAGEFLOW_DATA_DIR = directory
    process.env.PACKAGEFLOW_LAUNCHER_KEY = 'private-test-launcher-key'
    const api = await import(bundle)
    assert.equal(api.dataPath('search-providers.json'), resolve(directory, 'search-providers.json'))
    const event = key => ({ node: { req: { headers: { 'x-packageflow-launcher-key': key } } } })
    assert.throws(() => api.assertDesktopControl(event('wrong')), { statusCode: 404 })
    api.assertDesktopControl(event('private-test-launcher-key'))
    assert.equal(api.desktopActivity().busy, false)
    writeFileSync(resolve(directory, 'installation-queue.json'), JSON.stringify({ status: 'running' }))
    assert.ok(api.desktopActivity().reasons.includes('installation'))
    writeFileSync(resolve(directory, 'installation-queue.json'), JSON.stringify({ status: 'completed' }))
    writeFileSync(resolve(directory, 'console-file-installations.json'), JSON.stringify({ jobs: [{ pending: true }] }))
    assert.ok(api.desktopActivity().reasons.includes('local-installation'))
    writeFileSync(resolve(directory, 'console-file-installations.json'), JSON.stringify({ jobs: [{ pending: false, job: { state: 'installed' } }] }))
    const done = api.trackDesktopRequest()
    assert.ok(api.desktopActivity().reasons.includes('request')); done(); done()
    assert.equal(api.desktopRequests(), 0)
    api.beginDesktopStop(); assert.throws(api.assertDesktopWritable, { statusCode: 503 })
    api.cancelDesktopStop(); api.assertDesktopWritable()
    assert.equal(api.desktopActivity().busy, false)
    writeFileSync(resolve(directory, 'console-maintenance.json'), 'broken')
    assert.throws(api.desktopActivity, { statusCode: 503 })
    process.env.PACKAGEFLOW_HOST_IP = '10.1.10.47'
    assert.equal(await api.getLocalIp('10.1.10.32'), '10.1.10.47')
    process.env.PACKAGEFLOW_HOST_IP = '999.1.1.1'
    await assert.rejects(api.getLocalIp('10.1.10.32'), { statusCode: 503 })
  } finally {
    for (const [key, value] of [['PACKAGEFLOW_DATA_DIR', previous.data], ['PACKAGEFLOW_LAUNCHER_KEY', previous.key], ['PACKAGEFLOW_HOST_IP', previous.ip]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    rmSync(directory, { recursive: true, force: true })
  }
})
