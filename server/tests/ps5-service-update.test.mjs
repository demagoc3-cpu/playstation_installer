import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

test('PS5 update closes only an acknowledged idle service; exact receipt and no replay', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-ps5-update-'))
  try {
    const bundle = join(work, 'driver.mjs')
    await build({ entryPoints: [resolve('server/utils/ps5-service-update-driver.ts')], outfile: bundle, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
    const { runPs5ServiceUpdate, ps5ServiceUpdateReceipt } = await import(pathToFileURL(bundle).href)
    const health = (pid, version = '0.1.3-dev', buildId = '') => ({ status: 200, body: { apiVersion: 'v1', pid, serviceReport: { service: 'PackageFlowService-PS5', platform: 'ps5', consoleVerified: true, version, buildId } } })
    async function scenario(options = {}) {
      const flow = { id: 'a'.repeat(32), consoleId: 'device-one', ip: '192.168.0.127', version: '0.1.4-dev', buildId: 'ps5-service-web-update-001', sha256: 'b'.repeat(64), state: 'preparing', message: '', startedAt: 1 }
      const calls = [], states = []; let shutdown = false, transferred = false, pauses = 0
      const driver = {
        idle: () => options.busy !== true,
        save: value => states.push(value.state), pause: async () => { pauses++ },
        request: async (path, headers) => {
          calls.push(path)
          if (path === '/api/v1/status') return health(shutdown ? 172 : 170, options.newer ? '0.1.5-dev' : shutdown || options.already ? flow.version : '0.1.3-dev', shutdown || options.already ? options.wrongBuild ? 'wrong-build' : flow.buildId : '')
          if (path === '/api/v1/operations/status') return { status: 200, body: { running: options.operationBusy === true } }
          if (path === '/api/v1/update/prepare') { assert.equal(headers['X-PackageFlow-Update-Id'], flow.id); return { status: options.oldApi ? 404 : 200, body: { requestId: options.wrongId ? 'c'.repeat(32) : flow.id, requested: true, ready: options.noAck !== true } } }
          if (path === '/api/v1/update/status') return { status: 200, body: { requestId: flow.id, requested: true, ready: false } }
          if (path === '/api/v1/shutdown') { shutdown = true; if (options.lostShutdown) throw new Error('lost shutdown reply'); return { status: 200, body: { ok: true, scope: 'packageflow-process' } } }
          throw new Error(`unexpected ${path}`)
        },
        health: async () => { calls.push('health'); if (options.oldStillAlive) return health(170); if (options.foreign) return { status: 503, body: {} }; throw new Error('ECONNREFUSED') },
        connect: async () => { calls.push('connect'); if (options.noLoader) throw new Error('loader unavailable'); return { close: () => calls.push('close'), send: async bytes => { assert.deepEqual([...bytes], [1, 2, 3]); transferred = true; calls.push('send'); if (options.lostUpload) throw new Error('upload reply lost') } } }
      }
      await runPs5ServiceUpdate(flow, new Uint8Array([1, 2, 3]), driver)
      assert.ok(calls.filter(p => p === '/api/v1/shutdown').length <= 1)
      assert.ok(calls.filter(p => p === 'send').length <= 1)
      return { flow, calls, states, transferred, pauses }
    }
    const good = await scenario()
    assert.equal(good.flow.state, 'completed'); assert.ok(good.calls.indexOf('connect') < good.calls.indexOf('/api/v1/shutdown'))
    assert.deepEqual(good.states, ['preparing', 'stopping', 'sending', 'verifying', 'completed'])
    assert.equal(ps5ServiceUpdateReceipt(good.flow, health(172, good.flow.version, good.flow.buildId)), true)
    assert.equal(ps5ServiceUpdateReceipt(good.flow, health(170, good.flow.version, good.flow.buildId)), false, 'old PID is not an update receipt')
    assert.equal(ps5ServiceUpdateReceipt(good.flow, health(172, good.flow.version, 'other-build')), false)
    assert.equal(ps5ServiceUpdateReceipt({ ...good.flow, previousPid: undefined }, health(172, good.flow.version, good.flow.buildId)), false)
    for (const option of ['busy', 'operationBusy', 'oldApi', 'noAck', 'wrongId', 'noLoader', 'newer']) {
      const r = await scenario({ [option]: true }); assert.equal(r.flow.state, 'failed', option); assert.ok(!r.calls.includes('/api/v1/shutdown'), option); assert.equal(r.transferred, false)
    }
    for (const option of ['foreign', 'oldStillAlive', 'lostShutdown']) {
      const r = await scenario({ [option]: true }); assert.equal(r.flow.state, 'unconfirmed', option); assert.equal(r.transferred, false)
    }
    assert.equal((await scenario({ lostUpload: true })).flow.state, 'unconfirmed')
    assert.equal((await scenario({ wrongBuild: true })).flow.state, 'unconfirmed', 'a different build never confirms the update')
    const same = await scenario({ already: true }); assert.equal(same.flow.state, 'completed'); assert.ok(!same.calls.includes('connect'), 'same authenticated build needs no replacement')
  } finally { rmSync(work, { recursive: true, force: true }) }
})

test('refresh reconciles a lost PS5 update receipt without shutdown or payload replay', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-update-receipt-')), previous = process.env.PACKAGEFLOW_DATA_DIR, fetchBefore = globalThis.fetch
  process.env.PACKAGEFLOW_DATA_DIR = work
  try {
    const id = '11111111-1111-1111-1111-111111111111', ip = '192.168.0.127'
    writeFileSync(join(work, 'console-profiles.json'), JSON.stringify({ version: 1, activeId: id, consoles: [{ id, ip, name: 'Test PS5', platform: 'ps5', verified: true, version: '0.1.3-dev', firmware: '13.60' }] }))
    writeFileSync(join(work, 'ps5-service-keys.json'), JSON.stringify({ [ip]: 'a'.repeat(64) }))
    mkdirSync(join(work, 'ps5-service-updates'))
    const flowFile = join(work, 'ps5-service-updates', `${id}.json`)
    const flow = { id: 'b'.repeat(32), consoleId: id, ip, version: '0.1.4-dev', buildId: 'ps5-service-web-update-001', sha256: 'c'.repeat(64), state: 'unconfirmed', message: '', previousPid: 170, startedAt: 1 }
    writeFileSync(flowFile, JSON.stringify(flow))
    const bundle = join(work, 'receipt.mjs')
    await build({ entryPoints: [resolve('server/utils/ps5-service-updates.ts')], outfile: bundle, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
    let pid = 170, calls = 0
    globalThis.fetch = async (url, options) => {
      assert.equal(url, `http://${ip}:8095/api/v1/status`); assert.equal(options.method, 'GET'); calls++
      return new Response(JSON.stringify({ apiVersion: 'v1', pid, serviceReport: { service: 'PackageFlowService-PS5', platform: 'ps5', consoleVerified: true, version: flow.version, buildId: flow.buildId } }), { headers: { 'Content-Type': 'application/json' } })
    }
    const { ps5ServiceUpdateInfo } = await import(pathToFileURL(bundle).href)
    assert.equal((await ps5ServiceUpdateInfo(id)).flow.state, 'unconfirmed')
    pid = 172
    assert.equal((await ps5ServiceUpdateInfo(id)).flow.state, 'completed')
    assert.equal(JSON.parse(readFileSync(flowFile, 'utf8')).state, 'completed')
    await ps5ServiceUpdateInfo(id); assert.equal(calls, 2, 'completed receipt does not trigger further requests')
  } finally {
    globalThis.fetch = fetchBefore
    if (previous === undefined) delete process.env.PACKAGEFLOW_DATA_DIR; else process.env.PACKAGEFLOW_DATA_DIR = previous
    rmSync(work, { recursive: true, force: true })
  }
})
