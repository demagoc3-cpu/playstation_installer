import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

test('save copies belong to their source console even when another profile is active', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-save-target-')), previous = process.env.PACKAGEFLOW_DATA_DIR
  process.env.PACKAGEFLOW_DATA_DIR = join(work, 'data')
  mkdirSync(process.env.PACKAGEFLOW_DATA_DIR)
  try {
    const bundle = join(work, 'api.cjs')
    await build({ stdin: { contents: `export * from './server/utils/save-backup-store'; export * from './server/utils/ps4-saves'; export * from './server/utils/console-management-target';`, resolveDir: resolve('.') }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
    const api = createRequire(import.meta.url)(bundle)
    const ps4a = '192.168.1.4', ps4b = '192.168.1.6', ps5 = '192.168.1.5'
    writeFileSync(join(process.env.PACKAGEFLOW_DATA_DIR, 'console-profiles.json'), JSON.stringify({ activeId: 'ps5', consoles: [{ id: 'a', ip: ps4a, platform: 'ps4' }, { id: 'b', ip: ps4b, platform: 'ps4' }, { id: 'ps5', ip: ps5, platform: 'ps5' }] }))
    function copy(sourceIp, visibility) {
      const id = randomUUID(), root = join(api.saveBackupRoot, id), data = Buffer.from('own fixture save')
      mkdirSync(join(root, 'files'), { recursive: true })
      writeFileSync(join(root, 'files', 'progress.dat'), data)
      writeFileSync(join(root, 'metadata.json'), JSON.stringify({ format: 'pfs-decrypted-save-backup-v1', id, userId: '1234abcd', titleId: 'CUSA95001', slot: 'slot1', createdAt: new Date().toISOString(), sourceIp, visibility, files: [{ path: 'progress.dat', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }] }))
      return id
    }
    const a = copy(ps4a), b = copy(ps4b), legacy = copy(undefined), internal = copy(ps4a, 'internal')
    assert.deepEqual(api.listSaveBackups('1234abcd', 'CUSA95001', ps4a).map(x => x.id), [a])
    assert.deepEqual(api.listSaveBackups('1234abcd', 'CUSA95001', ps4b).map(x => x.id), [b])
    assert.deepEqual(api.listSaveBackups('1234abcd', 'CUSA95001', null).map(x => x.id), [legacy], 'unassigned archives are separately downloadable')
    assert.equal(api.readSaveBackup(legacy, true).manifest.sourceIp, undefined, 'legacy archives remain readable without guessing their source')
    assert.equal(api.readSaveBackup(internal, true).manifest.sourceIp, ps4a)
    assert.equal(api.ps4ManagementIp(ps4a), ps4a, 'active PS5 must not redirect a request addressed to PS4')
    assert.throws(() => api.ps4ManagementIp(ps5), /PS5/)
    assert.throws(() => api.ps4ManagementIp(undefined), /IPv4/)
    const oldFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = async () => { requests++; throw new Error('must not contact a device') }
    try {
      await assert.rejects(api.restoreSaveBackup(ps4b, a), /не привязана/)
      await assert.rejects(api.restoreSaveBackup(ps4a, legacy), /не привязана/)
      await assert.rejects(api.createSaveBackup(ps5, '1234abcd', 'CUSA95001', 'slot1'), /PS5/)
      assert.equal(requests, 0, 'wrong target is rejected before any read, mount or write')
    } finally { globalThis.fetch = oldFetch }
    // Exercise the actual exporter, rather than only hand-made manifests.
    writeFileSync(join(process.env.PACKAGEFLOW_DATA_DIR, 'ps4-service-keys.json'), JSON.stringify({ [ps4a]: 'a'.repeat(32) }))
    const oldError = globalThis.createError
    globalThis.createError = error => Object.assign(new Error(error.message), error)
    const data = Buffer.from('exported progress')
    globalThis.fetch = async (url, options) => {
      const target = new URL(url)
      assert.equal(target.hostname, ps4a, 'export must ignore the active PS5 profile')
      const body = options.body ? JSON.parse(options.body) : {}
      const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
      if (target.pathname === '/apps/list') return json({ service: 'PackegeFlowService', appsApi: 1, revision: '0123456789abcdef', complete: true, total: 0, next: null, apps: [] })
      if (target.pathname === '/files/list') {
        const entries = body.path.startsWith('/data/')
          ? [{ name: 'progress.dat', type: 'file', size: data.length, mtime: 1 }]
          : [{ name: 'sdimg_slot1', type: 'file', size: 1024, mtime: 1 }, { name: 'slot1.bin', type: 'file', size: 16, mtime: 1 }]
        return json({ entries, hasMore: false, nextOffset: entries.length })
      }
      if (target.pathname === '/saves/export') return json({ path: `/data/PackegeFlowService/save-exports/${body.id}/files`, files: 1, bytes: data.length })
      if (target.pathname === '/files/read') return new Response(data, { headers: { 'Content-Type': 'application/octet-stream' } })
      if (target.pathname === '/saves/cleanup') return json({ cleaned: true })
      throw new Error(`Unexpected save request: ${target.pathname}`)
    }
    try {
      const exported = await api.createSaveBackup(ps4a, '1234abcd', 'CUSA95001', 'slot1')
      assert.equal(api.readSaveBackup(exported.id, true).manifest.sourceIp, ps4a)
      assert.ok(api.listSaveBackups('1234abcd', 'CUSA95001', ps4a).some(x => x.id === exported.id))
      assert.ok(!api.listSaveBackups('1234abcd', 'CUSA95001', ps4b).some(x => x.id === exported.id))
    } finally { globalThis.fetch = oldFetch; globalThis.createError = oldError }
  } finally {
    if (previous === undefined) delete process.env.PACKAGEFLOW_DATA_DIR; else process.env.PACKAGEFLOW_DATA_DIR = previous
    rmSync(work, { recursive: true, force: true })
  }
})

test('leaving a console view prevents delayed replies from starting follow-up commands', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-console-view-'))
  const oldHook = globalThis.onBeforeUnmount, oldFetch = globalThis.$fetch
  try {
    const bundle = join(work, 'view.cjs')
    await build({ entryPoints: ['app/composables/useConsoleRequest.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
    let dispose, reply, requests = 0
    globalThis.onBeforeUnmount = callback => { dispose = callback }
    globalThis.$fetch = () => { requests++; return new Promise(done => { reply = done }) }
    const request = createRequire(import.meta.url)(bundle).useConsoleRequest()
    const accepted = request('/export', { method: 'POST' })
    dispose(); reply({ id: 'finished-on-original-console' })
    await assert.rejects(accepted, { name: 'AbortError' })
    await assert.rejects(request('/restore'), { name: 'AbortError' })
    assert.equal(requests, 1, 'accepted command is not replayed and no follow-up is sent')
  } finally {
    globalThis.onBeforeUnmount = oldHook; globalThis.$fetch = oldFetch
    rmSync(work, { recursive: true, force: true })
  }
})
