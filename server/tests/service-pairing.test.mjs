import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { createError } from 'h3'

test('pairing stores the credential privately and changes PS4 WEB host only after authentication', async () => {
  const folder = mkdtempSync(resolve(tmpdir(), 'pf-pairing-')), bundle = resolve('node_modules/.cache/service-pairing-test.mjs')
  const previousFetch = globalThis.fetch, previousData = process.env.PACKAGEFLOW_DATA_DIR
  process.env.PACKAGEFLOW_DATA_DIR = folder; globalThis.createError = createError
  await build({ entryPoints: [resolve('server/utils/ps4-service-installer.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  const api = await import(bundle), ip = '10.1.10.32', key = '0123456789abcdef0123456789abcdef'
  let authRejected = false, serviceReady = true
  let failed = false, saved = 'http://10.1.10.47:3000\n', staged = '', writes = 0
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname
    if (path === '/install/pair') {
      assert.deepEqual(JSON.parse(init.body), { code: 'ABC-123' })
      return Response.json(failed ? { error: 'pairing_code_invalid' } : { service: 'PackegeFlowService', paired: true, token: key }, { status: failed ? 403 : 200 })
    }
    if (path === '/install/capabilities') {
      assert.equal(init.headers.Authorization, undefined)
      return Response.json({ service: 'PackegeFlowService', installApi: 1, authentication: 'bearer', ready: serviceReady, contentTypes: ['PS4GD'], errorHex: '0x00000000' })
    }
    assert.equal(init.headers.Authorization, `Bearer ${key}`)
    if (path === '/install/session' && authRejected) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (path === '/install/session') return Response.json({ service: 'PackegeFlowService', installApi: 1, authentication: 'bearer', ready: true, contentTypes: ['PS4GD'] })
    if (init.method === 'PUT') { writes++; staged = init.body.toString(); return Response.json({ offset: Buffer.byteLength(staged) }) }
    if (path === '/files/mkdir') return Response.json({ error: 'file_operation_failed' }, { status: 409 })
    if (path === '/files/stat') return Response.json({ type: 'file', revision: '0123456789abcdef', identity: 'abcdef0123456789' })
    if (path === '/files/replace') { saved = staged; return Response.json({ completed: true }) }
    assert.ok(['/files/upload/start', '/files/upload/finish'].includes(path))
    return Response.json({ completed: true, offset: 0 })
  }
  try {
    assert.equal((await api.getServiceInstallerStatus(ip)).paired, false)
    failed = true
    await assert.rejects(api.saveServiceKey(ip, 'ABC-123', 'http://192.168.1.55:4444'), { statusCode: 403 })
    assert.equal(writes, 0); assert.equal(saved, 'http://10.1.10.47:3000\n')
    failed = false
    const result = await api.saveServiceKey(ip, 'abc-123', 'http://192.168.1.55:4444')
    assert.equal(result.ready, true); assert.equal(saved, 'http://192.168.1.55:4444\n')
    assert.equal(JSON.parse(readFileSync(resolve(folder, 'ps4-service-keys.json'), 'utf8'))[ip], key)
    assert.ok(!JSON.stringify(result).includes(key))
    await api.saveServiceKey(ip, 'ABC-123', 'http://192.168.1.66:5555')
    assert.equal(saved, 'http://192.168.1.66:5555\n')
    assert.equal((await api.getServiceInstallerStatus(ip)).paired, true)
    assert.equal((await api.updatePairedServiceWebAddress(ip, 'http://192.168.1.99:3333')).updated, true)
    assert.equal(saved, 'http://192.168.1.99:3333\n')
    serviceReady = false
    const inactive = await api.getServiceInstallerStatus(ip)
    assert.equal(inactive.paired, true); assert.equal(inactive.ready, false)
    serviceReady = true; authRejected = true
    const rejected = await api.getServiceInstallerStatus(ip)
    assert.equal(rejected.configured, true); assert.equal(rejected.paired, false)
    globalThis.fetch = async () => { throw new Error('Offline fixture') }
    const offline = await api.getServiceInstallerStatus(ip)
    assert.equal(offline.configured, true); assert.equal(offline.paired, null)
    assert.ok(!JSON.stringify(offline).includes(key))
  } finally {
    globalThis.fetch = previousFetch
    if (previousData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR; else process.env.PACKAGEFLOW_DATA_DIR = previousData
    rmSync(folder, { recursive: true, force: true })
  }
})
