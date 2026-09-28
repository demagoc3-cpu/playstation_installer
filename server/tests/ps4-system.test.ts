import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getPs4SystemSnapshot, localPs4Ip } from '../utils/ps4-service.ts'

const identity = { service: 'PackegeFlowService', version: '0.3.0', environment: 'ps4' }
function fixtures() {
  return {
    '/ping': { status: 200, body: { ...identity, status: 'ok' } },
    '/system/info': { status: 200, body: { ...identity, pkgVersion: '1.02', firmware: { version: '11.00' }, model: { name: null }, hen: { name: null, version: null } } },
    '/storage': { status: 200, body: { ...identity, volumes: [{ id: 'internal', path: '/user', available: true, totalBytes: 1000, freeBytes: 400, availableBytes: 350, usedBytes: 600 }] } },
    '/status': { status: 200, body: { ...identity, status: 'ok', uptimeSeconds: 80, requests: 4, replies: 3 } },
  }
}
test('only canonical local IPv4 addresses can select the service', () => {
  for (const ip of ['127.0.0.1', '8.8.8.8', '192.168.0.999', '192.168.1.2@evil.com', 'http://192.168.1.2', ['192.168.1.2'], '172.32.0.1', '::1']) assert.equal(localPs4Ip(ip), null)
  assert.equal(localPs4Ip('192.168.088.147'), '192.168.88.147')
  assert.equal(localPs4Ip('172.16.0.2'), '172.16.0.2')
})
test('current service returns system, usable disk space and counters', async () => {
  const data = fixtures()
  const result = await getPs4SystemSnapshot('192.168.88.147', async (_, path) => data[path])
  assert.equal(result.ready, true)
  assert.equal(result.pkgVersion, '1.02')
  assert.equal(result.system?.firmware, '11.00')
  assert.equal(result.system?.model, null)
  assert.equal(result.system?.henVersion, null)
  assert.equal(result.storage?.[0]?.availableBytes, 350)
  assert.deepEqual(result.issues, [])
})
test('legacy ping stays online and explicitly requests the new PKG', async () => {
  const result = await getPs4SystemSnapshot('192.168.88.147', async (_, path) => path === '/ping'
    ? { status: 200, body: { service: identity.service, version: '0.2.0', status: 'ok' } }
    : { status: 404, body: { error: 'not_found' } })
  assert.equal(result.ready, true)
  assert.equal(result.updateRequired, true)
  assert.equal(result.system, null)
  assert.equal(result.storage, null)
})
test('offline response contains no stale console data', async () => {
  const result = await getPs4SystemSnapshot('192.168.88.147', async () => { throw new Error('timeout') })
  assert.equal(result.ready, false)
  assert.equal(result.system, null)
  assert.equal(result.storage, null)
  assert.equal(result.runtime, null)
})
test('failed or invalid disk response preserves system data', async () => {
  for (const fail of [true, false]) {
    const data = fixtures()
    data['/storage'].body.volumes[0]!.freeBytes = 2000
    const result = await getPs4SystemSnapshot('192.168.88.147', async (_, path) => {
      if (path === '/storage' && fail) throw new Error('disk timeout')
      return data[path]
    })
    assert.equal(result.ready, true)
    assert.equal(result.system?.firmware, '11.00')
    assert.equal(result.storage, null)
    assert.equal(result.issues.length, 1)
  }
})
test('unreadable volume remains unknown rather than zero', async () => {
  const data = fixtures()
  data['/storage'].body.volumes[0]!.available = false
  const result = await getPs4SystemSnapshot('192.168.88.147', async (_, path) => data[path])
  assert.equal(result.storage?.[0]?.available, false)
  assert.equal(result.storage?.[0]?.totalBytes, null)
})
test('the real PS4 1.02 ENOENT response retains its diagnostic code', async () => {
  const data = fixtures()
  const result = await getPs4SystemSnapshot('192.168.88.147', async (_, path) => path === '/storage' ? {
    status: 200, body: { ...identity, volumes: [{ id: 'internal', path: '/user', available: false,
      totalBytes: null, freeBytes: null, availableBytes: null, usedBytes: null, error: -2147352574 }] },
  } : data[path])
  assert.equal(result.ready, true)
  assert.equal(result.storage?.[0]?.error, -2147352574)
  assert.equal(result.storage?.[0]?.available, false)
  assert.equal(result.storage?.[0]?.totalBytes, null)
})
test('GoldHEN SDK and hardware family do not pretend to be release or CUH', async () => {
  const data = fixtures()
  const result = await getPs4SystemSnapshot('192.168.88.147', async (_, path) => path === '/system/info' ? {
    status: 200, body: { ...data[path].body, model: { name: null, family: 'PS4 Pro' },
      hen: { name: 'GoldHEN', version: null, sdkVersion: '1.00' }, filesystemAccess: { enabled: true, error: 0 } },
  } : data[path])
  assert.equal(result.system?.modelFamily, 'PS4 Pro')
  assert.equal(result.system?.model, null)
  assert.equal(result.system?.henName, 'GoldHEN')
  assert.equal(result.system?.henSdk, '1.00')
  assert.equal(result.system?.henVersion, null)
  assert.equal(result.system?.filesystemAccess?.enabled, true)
})
test('PS4 1.03 access failure does not mean HEN is absent; old diagnostics stay nullable', async () => {
  const data = fixtures()
  const result = await getPs4SystemSnapshot('192.168.88.147', async (_, path) => path === '/system/info' ? {
    status: 200, body: { ...data[path].body, pkgVersion: '1.03', firmware: { version: '12.50' },
      model: { name: null, family: 'PS4 (Fat / Slim)' }, hen: { name: null, version: null, sdkVersion: null },
      filesystemAccess: { enabled: false, error: -1, sandboxBefore: 1, sandboxAfter: 1 } },
  } : data[path])
  assert.equal(result.ready, true)
  assert.equal(result.system?.filesystemAccess?.error, -1)
  assert.equal(result.system?.filesystemAccess?.sdkResult, null)
  assert.equal(result.system?.filesystemAccess?.sandboxAfter, 1)
  assert.equal(result.system?.henName, null)
})
test('raw SDK failure and stage survive aggregation for console diagnostics', async () => {
  const data = fixtures()
  const result = await getPs4SystemSnapshot('192.168.88.147', async (_, path) => path === '/system/info' ? {
    status: 200, body: { ...data[path].body, filesystemAccess: { enabled: false, error: -78,
      errorHex: '0xFFFFFFB2', stage: 'sdk_version', sdkResult: -78, sdkResultHex: '0xFFFFFFB2',
      sdkErrno: 78, sandboxBefore: 1, sandboxAfter: 1 } },
  } : data[path])
  assert.equal(result.ready, true)
  assert.equal(result.system?.filesystemAccess?.errorHex, '0xFFFFFFB2')
  assert.equal(result.system?.filesystemAccess?.sdkResult, -78)
  assert.equal(result.system?.filesystemAccess?.sdkErrno, 78)
  assert.equal(result.system?.filesystemAccess?.stage, 'sdk_version')
})
