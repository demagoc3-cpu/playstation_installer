import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getPs4SystemSnapshot, ps4ServiceIp } from '../utils/ps4-service.ts'

const identity = { service: 'PackegeFlowService', version: '0.3.0', environment: 'ps4' }
function fixtures() {
  return {
    '/ping': { status: 200, body: { ...identity, status: 'ok' } },
    '/system/info': { status: 200, body: { ...identity, pkgVersion: '1.02', firmware: { version: '11.00' }, model: { name: null }, hen: { name: null, version: null } } },
    '/storage': { status: 200, body: { ...identity, volumes: [{ id: 'internal', path: '/user', available: true, totalBytes: 1000, freeBytes: 400, availableBytes: 350, usedBytes: 600 }] } },
    '/status': { status: 200, body: { ...identity, status: 'ok', uptimeSeconds: 80, requests: 4, replies: 3 } },
  }
}
test('LAN and public unicast IPv4 addresses can select the service', () => {
  for (const ip of ['127.0.0.1', '127.1.0.1', '0.0.0.0', '224.0.0.1', '240.0.0.1', '255.255.255.255', '192.168.0.999', '192.168.1.2@evil.com', 'http://192.168.1.2', ['192.168.1.2'], '::1']) assert.equal(ps4ServiceIp(ip), null)
  assert.equal(ps4ServiceIp('192.168.088.147'), '192.168.88.147')
  assert.equal(ps4ServiceIp('172.16.0.2'), '172.16.0.2')
  assert.equal(ps4ServiceIp('134.17.24.238'), '134.17.24.238')
  assert.equal(ps4ServiceIp('8.8.8.8'), '8.8.8.8')
  assert.equal(ps4ServiceIp('172.32.0.1'), '172.32.0.1')
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
test('independent daemon mode and process ID are available, old services remain compatible', async () => {
  const data = fixtures()
  const older = await getPs4SystemSnapshot('192.168.88.147', async (_, path) => data[path])
  assert.equal(older.runtime?.mode, null)
  assert.equal(older.runtime?.processId, null)
  const current = await getPs4SystemSnapshot('192.168.88.147', async (_, path) => path === '/status'
    ? { ...data[path], body: { ...data[path].body, runtimeMode: 'daemon', processId: 231, daemonRegistration: 0 } }
    : data[path])
  assert.equal(current.runtime?.mode, 'daemon')
  assert.equal(current.runtime?.processId, 231)
  assert.equal(current.runtime?.daemonRegistration, 0)
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
  assert.equal(result.system?.filesystemAccess?.sdkRawRaxHex, null)
  assert.equal(result.system?.filesystemAccess?.sdkCarry, null)
  assert.equal(result.system?.henName, null)
})
test('raw 64-bit SDK reply preserves carry without treating errno 256 as HEN detection', async () => {
  const data = fixtures()
  for (const raw of ['0x0000000000000100', '0xFFFFFFFFFFFFFFFF', 'not-hex']) {
    const calls: string[] = []
    const result = await getPs4SystemSnapshot('192.168.88.147', async (_, path) => {
      calls.push(path)
      return path === '/system/info' ? { status: 200, body: { ...data[path].body,
        hen: { name: null, version: null },
        filesystemAccess: { enabled: false, error: -2147352574, sdkProbed: true,
          sdkResult: -256, sdkErrno: 256, sdkRawRaxHex: raw, sdkCarry: true } } } : data[path]
    })
    assert.equal(result.system?.filesystemAccess?.sdkRawRaxHex, raw === 'not-hex' ? null : raw)
    assert.equal(result.system?.filesystemAccess?.sdkCarry, true)
    assert.equal(result.system?.filesystemAccess?.enabled, false)
    assert.equal(result.system?.henName, null)
    assert.deepEqual(calls, ['/ping', '/system/info', '/storage', '/status'])
  }
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
test('deferred SDK remains unknown and web polling never triggers the probe', async () => {
  const data = fixtures()
  const calls: string[] = []
  const result = await getPs4SystemSnapshot('192.168.88.147', async (_, path) => {
    calls.push(path)
    return path === '/system/info' ? { status: 200, body: { ...data[path].body,
      filesystemAccess: { enabled: false, error: -2147352574, stage: 'verify_user',
        sdkProbed: false, sdkResult: null, sdkResultHex: null, sdkErrno: 0 } } } : data[path]
  })
  assert.deepEqual(calls, ['/ping', '/system/info', '/storage', '/status'])
  assert.equal(result.ready, true)
  assert.equal(result.system?.filesystemAccess?.sdkProbed, false)
  assert.equal(result.system?.filesystemAccess?.sdkResult, null)
  assert.equal(result.system?.henName, null)
})
