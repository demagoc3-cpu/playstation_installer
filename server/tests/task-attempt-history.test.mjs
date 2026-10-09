import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createError } from 'h3'

test('task API shows the latest file attempt; explicit history preserves retries and patch variants', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-task-history-')), previous = process.env.PACKAGEFLOW_DATA_DIR
  process.env.PACKAGEFLOW_DATA_DIR = join(work, 'data'); mkdirSync(process.env.PACKAGEFLOW_DATA_DIR)
  globalThis.createError = createError
  try {
    const ip = '10.1.10.32', folder = join(process.env.PACKAGEFLOW_DATA_DIR, 'consoles', ip); mkdirSync(folder, { recursive: true })
    const item = id => ({ packageId: id, title: 'Broforce', titleId: 'CUSA03887', fileName: `${id}.pkg`, type: id === 'base' ? 'Игра' : 'Патч', size: 100, state: 'installed', detail: '', bytesSent: 100 })
    const old = { version: 1, id: 'old', psIp: ip, status: 'completed', createdAt: 100, items: [item('base'), item('patch'), item('variant')] }
    const current = { ...old, id: 'new', createdAt: 200, items: [item('base'), item('patch'), { ...item('variant'), state: 'cancelled' }] }
    writeFileSync(join(folder, 'installation-queue.json'), JSON.stringify(current))
    writeFileSync(join(folder, 'installation-history.json'), JSON.stringify([old]))
    writeFileSync(join(process.env.PACKAGEFLOW_DATA_DIR, 'package-library.json'), JSON.stringify({ version: 2, packages: [], deliveries: {} }))
    const bundle = join(work, 'tasks.mjs')
    await build({ stdin: { contents: `export {getInstallationTasks} from './server/utils/installation-tasks'; export {latestInstallationAttempts} from './shared/latest-installation-attempts'`, resolveDir: resolve('.') }, outfile: bundle, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
    const api = await import(pathToFileURL(bundle).href)
    const latest = api.getInstallationTasks({ ip, view: 'tree' })
    assert.equal(latest.items.length, 3); assert.equal(latest.counts.completed, 3)
    assert.ok(latest.items.every(t => t.queueId === 'new'))
    assert.equal(latest.items.find(t => t.packageId === 'variant').state, 'cancelled', 'latest cancellation is not replaced by older success')
    assert.equal(api.getInstallationTasks({ ip, view: 'tree', history: 'true' }).items.length, 6)
    const mixed = [...latest.items, { ...latest.items[0], id: 'ps5', psIp: '192.168.0.127', platform: 'ps5' }]
    assert.equal(api.latestInstallationAttempts(mixed).length, 4, 'one device cannot hide another device attempt')
    assert.equal(JSON.parse(requireFile(join(folder, 'installation-history.json')))[0].items.length, 3, 'view does not erase history')
  } finally {
    if (previous === undefined) delete process.env.PACKAGEFLOW_DATA_DIR; else process.env.PACKAGEFLOW_DATA_DIR = previous
    rmSync(work, { recursive: true, force: true })
  }
})

import { readFileSync } from 'node:fs'
function requireFile(path) { return readFileSync(path, 'utf8') }
