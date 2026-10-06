import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { resolve } from 'node:path'
const bundle = resolve('node_modules/.cache/service-web-address-test.mjs')
await build({ entryPoints: [resolve('server/utils/service-web-address.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
const { serviceWebAddress, syncServiceWebAddress } = await import(bundle)

test('advertises LAN address and published port, never localhost or a container port', () => {
  assert.equal(serviceWebAddress('192.168.1.55', '4444'), 'http://192.168.1.55:4444')
  for (const ip of ['127.0.0.1', '0.0.0.0', '999.1.1.1', '224.1.1.1', 'localhost']) assert.throws(() => serviceWebAddress(ip, 3000))
  for (const port of [0, 65536, '3000/x', 3.5]) assert.throws(() => serviceWebAddress('10.1.10.47', port))
})
for (const existing of [false, true]) test(`pairing publishes new WEB URL atomically (${existing ? 'replace previous computer' : 'first connection'})`, async () => {
  const path = '/data/PackageFlowUI/server-url.txt', calls = []
  let bytes, finished = false, saved = existing ? 'http://10.1.10.47:3000\n' : undefined
  const request = async (route, body) => {
    calls.push([route, body])
    if (route === 'mkdir') throw { statusCode: 409 }
    if (route === 'stat' && body.path === path && !existing) throw { statusCode: 404 }
    if (route === 'stat') return { type: 'file', revision: '0123456789abcdef', identity: 'abcdef0123456789' }
    if (route === 'upload/finish') { assert.ok(bytes); finished = true }
    if (route === 'replace' || route === 'move') {
      assert.ok(finished); assert.equal(body.destination, path); assert.equal(body.revision, '0123456789abcdef')
      saved = bytes.toString(); return route === 'replace' ? { backup: `${path}.packageflow-backup-${body.id}` } : {}
    }
    return {}
  }
  await syncServiceWebAddress('http://192.168.1.55:4444', request, async (_, value) => { bytes = value })
  assert.equal(saved, 'http://192.168.1.55:4444\n')
  assert.ok(calls.some(([route]) => route === (existing ? 'replace' : 'move')))
  if (existing) assert.ok(calls.some(([route]) => route === 'delete'))
})

test('failed upload never replaces the previous WEB address; invalid address writes nothing', async () => {
  let replacements = 0
  const request = async route => {
    if (route === 'upload/finish') throw new Error('failed')
    if (route === 'replace' || route === 'move') replacements++
    return { type: 'file', revision: '0123456789abcdef' }
  }
  await assert.rejects(syncServiceWebAddress('http://192.168.1.55:4444', request, async () => {}))
  assert.equal(replacements, 0)
  await assert.rejects(syncServiceWebAddress('http://127.0.0.1:3000', () => { throw new Error('must not write') }, async () => {}))
})
