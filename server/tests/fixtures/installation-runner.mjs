// Runs the production queue/client in a temporary cwd. Only the two external
// devices are simulated: payload commands and console HTTP replies.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = process.cwd()
const directory = mkdtempSync(resolve(tmpdir(), 'packageflow-queue-'))
const mode = process.argv[2]
process.chdir(directory)
mkdirSync('.data')
writeFileSync('game.pkg', Buffer.alloc(1024))
const item = { id: 'one', title: 'Test Game', fileName: 'game.pkg', size: 8589934592, type: 'Игра', titleId: 'CUSA00001', installOrder: 0,
  requiredFirmware: '5.05', sdkFirmware: '5.05',
  contentId: 'EP0000-CUSA00001_00-ABCDEFGHIJKLMNOP', contentType: 'PS4GD', packageDigest: 'a'.repeat(40), iconSize: 0,
  path: resolve('game.pkg'), libraryRoot: directory, sourceModifiedAt: 1, icon: { offset: 0, size: 0 } }
if (mode === 'icon') {
  item.coverPath = resolve('icon.png')
  item.iconSize = 8
  writeFileSync(item.coverPath, Buffer.from('89504e470d0a1a0a', 'hex'))
}
writeFileSync('.data/package-library.json', JSON.stringify({ version: 2, packages: [item], deliveries: {} }))
const ip = '192.168.88.147'
const token = 'abcdef0123456789abcdef0123456789'
const input = { psIp: ip, packageIds: ['one'], packageUrls: { one: 'http://192.168.88.10:3000/json/one.json' } }
const calls = { payload: 0, commands: 0, service: 0, submit: 0, pair: 0, cancel: 0, icon: 0 }
globalThis.queueTestCalls = calls
globalThis.createError = value => Object.assign(new Error(value.message), value)
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (error) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) return next(`${specifier}.ts`, context)
      throw error
    }
  },
  load(url, context, next) {
    if (url.endsWith('/server/utils/ps4-installer.ts')) return { format: 'module', shortCircuit: true, source: `
      export async function startInstaller() { globalThis.queueTestCalls.payload++; }
      export async function sendPackage() { globalThis.queueTestCalls.commands++; }
    ` }
    return next(url, context)
  },
})
let currentJob, offline = false
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const cap = { service: 'PackegeFlowService', version: '0.4.0', installApi: 1, ready: true, authentication: 'bearer', contentTypes: ['PS4GD'], error: 0, errorHex: '0x00000000' }
const makeJob = id => ({ service: 'PackegeFlowService', jobId: id, requestId: id, contentId: item.contentId, taskId: 43, state: 'downloading',
  totalBytes: item.size, downloadedBytes: 5368709120, downloadTotalBytes: item.size, error: 0, errorHex: '0x00000000', pollError: 0 })
globalThis.fetch = async (url, options) => {
  calls.service++
  const path = new URL(url).pathname
  if (path === '/system/info' && globalThis.cancelBeforeDispatch) { const cancel = globalThis.cancelBeforeDispatch;globalThis.cancelBeforeDispatch=undefined;await delay(0);cancel() }
  if (path === '/system/info') return response({ service: cap.service, firmware: { version: '12.50' } })
  if (path === '/storage') return response({ service: cap.service, volumes: [{ id: 'internal', path: '/user', available: true,
    availableBytes: mode === 'space' ? 1024 : 20 * 1024 ** 3 }] })
  if (path === '/install/pair') { calls.pair++; assert.deepEqual(JSON.parse(options.body), { code: 'F7Y-YUH' }); return response({ service: cap.service, paired: true, token }) }
  if (path === '/install/capabilities') return response(cap)
  assert.equal(options.headers.Authorization, `Bearer ${token}`)
  if (path === '/install/session') return response(cap)
  if (path === '/files/stat' && mode === 'icon') {
    assert.equal(JSON.parse(options.body).path, '/data/PackegeFlowService/install-icon-CUSA00001.png')
    return response({ error: 'not_found' }, 404)
  }
  if (path === '/files/upload/start' && mode === 'icon') {
    assert.equal(JSON.parse(options.body).size, 8)
    return response({ offset: 0 })
  }
  if (path === '/files/upload/11111111-1111-1111-1111-111111111111' && mode === 'icon') {
    assert.equal(Buffer.from(options.body).toString('hex'), '89504e470d0a1a0a')
    calls.icon++
    return response({ offset: 8 })
  }
  if (path === '/files/upload/finish' && mode === 'icon') return response({ completed: true })
  if (path === '/install/jobs' && options.method === 'POST') {
    calls.submit++
    if (mode === 'already-installed' && calls.submit === 1) return response({ error: 'component_already_installed', errorHex: '0x00000000' }, 409)
    if (mode === 'busy-rejection') return response({ error: 'another_service_job_active', errorHex: '0x00000000' }, 409)
    assert.equal(calls.submit, mode === 'already-installed' ? 2 : 1, 'accepted task must never be POSTed twice')
    if (mode === 'icon') assert.equal(calls.icon, 1, 'BGFT icon must be on the console before task registration')
    const body = JSON.parse(options.body); assert.equal(body.size, item.size); assert.equal(body.contentType, mode === 'already-installed' ? 'PS4AC' : mode.startsWith('cancel-one') ? 'PS4GP' : 'PS4GD')
    currentJob = makeJob(body.requestId)
    throw new Error('Connection lost after PS4 accepted the task')
  }
  assert(currentJob && path.startsWith(`/install/jobs/${currentJob.jobId}`))
  if (offline && !path.endsWith('/cancel')) throw new Error('Temporary connection loss')
  if (path.endsWith('/cancel')) { calls.cancel++; if (mode !== 'cancel-stuck') currentJob.state = 'cancelled' }
  return response(currentJob)
}
const load = name => import(name === 'installation-queue' && process.env.PACKAGEFLOW_QUEUE_TEST_BUNDLE
  ? pathToFileURL(process.env.PACKAGEFLOW_QUEUE_TEST_BUNDLE).href
  : name === 'ps4-service-installer' && process.env.PACKAGEFLOW_SERVICE_CLIENT_TEST_BUNDLE
    ? pathToFileURL(process.env.PACKAGEFLOW_SERVICE_CLIENT_TEST_BUNDLE).href
    : pathToFileURL(resolve(root, `server/utils/${name}.ts`)).href)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const readQueue = () => JSON.parse(readFileSync('.data/installation-queue.json', 'utf8'))
const installed = () => JSON.parse(readFileSync('.data/package-library.json', 'utf8')).packages[0].installedAt
async function until(check) {
  const deadline = Date.now() + 8000
  while (!check()) { assert(Date.now() < deadline, `timed out in ${mode}`); await delay(30) }
}
try {
  if (mode === 'preference') {
    const preference = await load('installation-preference')
    assert.equal(preference.getInstallationPreference(), 'service')
    assert.equal(preference.setInstallationPreference('payload'), 'payload')
    assert.equal(preference.getInstallationPreference(), 'payload')
    assert.throws(() => preference.setInstallationPreference('auto'))
    assert.equal(preference.getInstallationPreference(), 'payload')
  } else if (mode === 'legacy') {
    writeFileSync('.data/installation-queue.json', JSON.stringify({ version: 1, status: 'running', psIp: ip, createdAt: 1,
      items: [{ packageId: 'one', url: input.packageUrls.one, state: 'waiting', detail: '', bytesSent: 0, dispatchedAt: Date.now() - 25000 }] }))
    const queue = await load('installation-queue'); queue.ensureInstallationQueueRunning()
    await until(() => readQueue().status === 'completed')
    assert.equal(readQueue().transport, 'payload'); assert.equal(readQueue().items[0].state, 'unconfirmed')
    assert.equal(installed(), undefined); assert.equal(calls.service, 0); assert.equal(calls.commands, 0)
  } else if (mode === 'payload') {
    const queue = await load('installation-queue')
    assert.throws(() => queue.startInstallationQueue({ ...input, transport: 'auto' }))
    assert.throws(() => queue.startInstallationQueue(input), /сопряжения/)
    const preference = await load('installation-preference')
    preference.setInstallationPreference('payload')
    const result = queue.startInstallationQueue(input); assert.equal(result.transport, 'payload')
    await until(() => calls.commands === 1)
    assert.equal(calls.service, 0); assert.equal(calls.payload, 1)
    queue.cancelInstallationQueue(); assert.equal(readQueue().status, 'cancelled')
    await delay(1550); assert.equal(calls.commands, 1)
  } else if (mode === 'append') {
    writeFileSync('.data/package-library.json', JSON.stringify({ version: 2, packages: [item, { ...item, id: 'two', title: 'Queued Patch', contentType: 'PS4GP', installOrder: 1 }], deliveries: {} }))
    writeFileSync('.data/installation-queue.json', JSON.stringify({ version: 1, transport: 'payload', id: 'active', status: 'running', psIp: ip, createdAt: 1,
      items: [{ packageId: 'one', url: input.packageUrls.one, state: 'waiting', detail: 'PS4 скачивает пакет', bytesSent: 1234, dispatchedAt: Date.now() }] }))
    const queue = await load('installation-queue')
    const result = queue.appendInstallationQueue({ psIp: ip, queueId: 'active', packageIds: ['two'], packageUrls: { two: 'http://192.168.88.10:3000/json/two.json' } })
    assert.equal(result.items.length, 2)
    assert.equal(result.items[0].state, 'waiting'); assert.equal(result.items[0].bytesSent, 1234)
    assert.equal(result.items[1].state, 'pending')
    assert.throws(() => queue.appendInstallationQueue({ psIp: ip, queueId: 'active', packageIds: ['two'], packageUrls: {} }), /уже находятся/)
    assert.throws(() => queue.appendInstallationQueue({ psIp: ip, queueId: 'old', packageIds: ['two'], packageUrls: {} }), /изменилась/)
    queue.cancelInstallationQueue()
  } else if (mode === 'cancel-one' || mode === 'cancel-one-before-dispatch') {
    writeFileSync('.data/ps4-service-keys.json', JSON.stringify({[ip]:token}))
    writeFileSync('.data/package-library.json', JSON.stringify({version:2,packages:[item,{...item,id:'two',title:'Next package',contentType:'PS4GP',installOrder:1}],deliveries:{}}))
    const queue = await load('installation-queue')
    if (mode === 'cancel-one') {
      const id='11111111-1111-1111-1111-111111111111';currentJob=makeJob(id)
      writeFileSync('.data/installation-queue.json',JSON.stringify({version:1,transport:'service',id:'current-test',status:'running',psIp:ip,createdAt:1,
        items:[{packageId:'one',url:input.packageUrls.one,state:'receiving',detail:'',bytesSent:10,requestId:id,serviceDispatchedAt:1},
          {packageId:'two',url:input.packageUrls.one,state:'pending',detail:'',bytesSent:0}]}))
      assert.throws(()=>queue.cancelCurrentInstallation('old','one',ip))
      assert.throws(()=>queue.cancelCurrentInstallation('current-test','two',ip))
      queue.cancelCurrentInstallation('current-test','one',ip)
    } else {
      globalThis.cancelBeforeDispatch=()=>queue.cancelCurrentInstallation(readQueue().id,'one',ip)
      queue.startInstallationQueue({...input,transport:'service',packageIds:['one','two'],packageUrls:{...input.packageUrls,two:input.packageUrls.one}})
    }
    await until(()=>calls.submit===1&&currentJob&&readQueue().items[1].serviceDispatchedAt)
    assert.equal(readQueue().items[0].state,'cancelled');assert.equal(calls.cancel,mode==='cancel-one'?1:0)
    assert.throws(()=>queue.cancelCurrentInstallation(readQueue().id,'one',ip))
    currentJob.state='installed';await until(()=>readQueue().status==='completed')
    assert.equal(readQueue().items[1].state,'installed');assert.equal(calls.submit,1);assert.match(readQueue().message,/с ошибкой — 0, отменено — 1/)
  } else if (mode === 'space') {
    writeFileSync('.data/ps4-service-keys.json', JSON.stringify({ [ip]: token }))
    const queue = await load('installation-queue')
    queue.startInstallationQueue({ ...input, transport: 'service' })
    await until(() => readQueue().status === 'failed')
    assert.match(readQueue().items[0].detail, /Недостаточно места/)
    assert.equal(calls.submit, 0)
  } else if (mode === 'firmware') {
    const newer = { ...item, id: 'newer', title: 'Too New', requiredFirmware: '13.00', sdkFirmware: '13.00' }
    writeFileSync('.data/package-library.json', JSON.stringify({ version: 2, packages: [newer, item], deliveries: {} }))
    writeFileSync('.data/ps4-service-keys.json', JSON.stringify({ [ip]: token }))
    const queue = await load('installation-queue')
    queue.startInstallationQueue({ ...input, packageIds: ['newer', 'one'], packageUrls: { ...input.packageUrls, newer: input.packageUrls.one }, transport: 'service' })
    await until(() => calls.submit === 1)
    assert.equal(readQueue().items[0].state, 'skipped')
    assert.match(readQueue().items[0].detail, /13\.00.*12\.50/)
    assert.equal(readQueue().items[1].packageId, 'one')
    currentJob.state = 'installed'
    await until(() => readQueue().status === 'completed')
    assert.equal(readQueue().items[1].state, 'installed')
    assert.match(readQueue().message, /пропущено.*1/)
  } else if (mode === 'firmware-unverified') {
    writeFileSync('.data/package-library.json', JSON.stringify({ version: 2, packages: [{ ...item, requiredFirmware: undefined, sdkFirmware: undefined }], deliveries: {} }))
    writeFileSync('.data/ps4-service-keys.json', JSON.stringify({ [ip]: token }))
    const queue = await load('installation-queue')
    queue.startInstallationQueue({ ...input, transport: 'service' })
    await until(() => readQueue().status === 'completed')
    assert.equal(readQueue().items[0].state, 'skipped')
    assert.equal(calls.submit, 0)
  } else {
    const client = await load('ps4-service-installer')
    if (mode === 'already-installed' || mode === 'busy-rejection') {
      writeFileSync('.data/ps4-service-keys.json', JSON.stringify({ [ip]: token }))
      writeFileSync('.data/package-library.json', JSON.stringify({ version: 2, packages: [{ ...item, contentType: 'PS4AC' }, { ...item, id: 'two', title: 'Next Package', contentType: 'PS4AC' }], deliveries: {} }))
      const queue = await load('installation-queue')
      queue.startInstallationQueue({ ...input, packageIds: ['one', 'two'], packageUrls: { ...input.packageUrls, two: input.packageUrls.one }, transport: 'service' })
      if (mode === 'busy-rejection') {
        await until(() => readQueue().status === 'failed')
        assert.equal(readQueue().items[0].state, 'failed')
        assert.equal(readQueue().items[1].state, 'pending')
        assert.equal(calls.submit, 1)
      } else {
        await until(() => calls.submit === 2 && currentJob)
        assert.equal(readQueue().items[0].state, 'skipped')
        assert.match(readQueue().items[0].detail, /уже установлен/)
        currentJob.state = 'installed'
        await until(() => readQueue().status === 'completed')
        assert.equal(readQueue().items[1].state, 'installed')
        assert.match(readQueue().message, /пропущено — 1/)
      }
    } else if (mode === 'silent-stall') {
      writeFileSync('.data/ps4-service-keys.json', JSON.stringify({ [ip]: token }))
      writeFileSync('.data/package-library.json', JSON.stringify({ version: 2, packages: [item, { ...item, id: 'two', title: 'Next Package' }], deliveries: {} }))
      const id = '11111111-1111-1111-1111-111111111111'
      currentJob = { ...makeJob(id), state: 'installing', downloadedBytes: item.size, installing: false, updating: 0 }
      writeFileSync('.data/installation-queue.json', JSON.stringify({ version: 1, transport: 'service', id: 'recovered', status: 'running', psIp: ip, createdAt: 1,
        items: [
          { packageId: 'one', url: input.packageUrls.one, state: 'installing', detail: '', bytesSent: item.size, requestId: id, serviceDispatchedAt: 1,
            serviceIdleSince: Date.now() - 16 * 60_000, serviceProgress: `${item.size}:${item.size}:::` },
          { packageId: 'two', url: input.packageUrls.one, state: 'pending', detail: 'Ожидает очереди', bytesSent: 0 },
        ] }))
      const queue = await load('installation-queue'); queue.ensureInstallationQueueRunning()
      await until(() => calls.cancel === 1 && calls.submit === 1)
      assert.equal(readQueue().items[0].state, 'unconfirmed')
      assert.match(readQueue().items[0].detail, /не подтвердила установку/)
      currentJob.state = 'installed'
      await until(() => readQueue().status === 'completed')
      assert.equal(readQueue().items[1].state, 'installed')
    } else if (mode === 'terminal-failure') {
      writeFileSync('.data/ps4-service-keys.json', JSON.stringify({ [ip]: token }))
      writeFileSync('.data/package-library.json', JSON.stringify({ version: 2, packages: [item, { ...item, id: 'two', title: 'Next Package' }], deliveries: {} }))
      const id = '11111111-1111-1111-1111-111111111111'
      currentJob = { ...makeJob(id), state: 'failed', error: -2137456521, errorHex: '0x80990077' }
      writeFileSync('.data/installation-queue.json', JSON.stringify({ version: 1, transport: 'service', id: 'recovered', status: 'running', psIp: ip, createdAt: 1,
        items: [
          { packageId: 'one', url: input.packageUrls.one, state: 'installing', detail: '', bytesSent: item.size, requestId: id, serviceDispatchedAt: 1 },
          { packageId: 'two', url: input.packageUrls.one, state: 'pending', detail: 'Ожидает очереди', bytesSent: 0 },
        ] }))
      const queue = await load('installation-queue'); queue.ensureInstallationQueueRunning()
      await until(() => calls.submit === 1)
      assert.equal(readQueue().items[0].state, 'failed')
      assert.match(readQueue().items[0].detail, /0x80990077/i)
      currentJob.state = 'installed'
      await until(() => readQueue().status === 'completed')
      assert.equal(readQueue().items[1].state, 'installed')
      assert.match(readQueue().message, /с ошибкой — 1/)
      assert.equal(calls.submit, 1)
    } else if (mode === 'restart') {
      writeFileSync('.data/ps4-service-keys.json', JSON.stringify({ [ip]: token }))
      const id = '11111111-1111-1111-1111-111111111111'; currentJob = { ...makeJob(id), state: 'installed' }
      writeFileSync('.data/installation-queue.json', JSON.stringify({ version: 1, transport: 'service', id: 'restored', status: 'running', psIp: ip, createdAt: 1,
        items: [{ packageId: 'one', url: input.packageUrls.one, state: 'sending', detail: '', bytesSent: 0, requestId: id, serviceDispatchedAt: 1 }] }))
      const queue = await load('installation-queue'); queue.ensureInstallationQueueRunning()
      await until(() => readQueue().status === 'completed')
      assert.equal(calls.submit, 0); assert.equal(calls.pair, 0); assert.equal(calls.payload, 0); assert(installed())
    } else {
      await assert.rejects(client.saveServiceKey(ip, 'invalid')); assert.equal(calls.service, 0)
      const result = await client.saveServiceKey(ip, 'f7y-yuh')
      if (mode === 'icon') {
        const queue = await load('installation-queue')
        const fixedId = '11111111-1111-1111-1111-111111111111'
        writeFileSync('.data/installation-queue.json', JSON.stringify({ version: 1, transport: 'service', id: 'icon', status: 'running', psIp: ip, createdAt: 1,
          items: [{ packageId: 'one', url: input.packageUrls.one, state: 'pending', detail: '', bytesSent: 0, requestId: fixedId }] }))
        queue.ensureInstallationQueueRunning()
        await until(() => calls.icon === 1 && calls.submit === 1)
        currentJob.state = 'installed'
        await until(() => readQueue().status === 'completed')
        assert.equal(calls.payload, 0)
      } else {
      assert.equal(result.configured, true); assert.equal(JSON.stringify(result).includes(token), false)
      assert(client.serviceKeyConfigured(ip)); assert.equal(calls.pair, 1)
      const queue = await load('installation-queue'); queue.startInstallationQueue({ ...input, transport: 'service' })
      await until(() => readQueue().items[0].state === 'receiving')
      assert.equal(readQueue().items[0].bytesSent, 5368709120); assert.equal(calls.submit, 1); assert.equal(calls.payload, 0)
      currentJob.downloadedBytes = currentJob.totalBytes
      await delay(1600); assert.equal(readQueue().status, 'running'); assert.equal(installed(), undefined)
      if (mode === 'interruption') {
        offline = true; await until(() => readQueue().items[0].state === 'verifying')
        assert.equal(calls.submit, 1); assert.equal(installed(), undefined)
        offline = false; currentJob.state = 'installed'
        await until(() => readQueue().status === 'completed'); assert(installed())
      } else if (mode === 'cancel') {
        queue.cancelInstallationQueue(); await until(() => readQueue().status === 'cancelled'); assert.equal(calls.cancel, 1); assert.equal(installed(), undefined)
      } else if (mode === 'cancel-removed') {
        currentJob.state = 'cancelling'; currentJob.error = -2137456615; currentJob.errorHex = '0x80990019'; currentJob.pollError = -2137456615
        queue.cancelInstallationQueue(); await until(() => readQueue().status === 'cancelled')
        assert.equal(readQueue().items[0].state, 'unconfirmed'); assert.equal(calls.cancel, 0); assert.equal(installed(), undefined)
      } else if (mode === 'cancel-stuck') {
        currentJob.state = 'cancelling'; currentJob.error = -5; currentJob.errorHex = '0xFFFFFFFB'
        const cancelled = queue.cancelInstallationQueue(); assert.equal(cancelled.status, 'cancelling')
        await until(() => calls.cancel >= 1)
        assert.throws(() => queue.resolveCancelledQueue('wrong'), /изменилась/)
        queue.resolveCancelledQueue(cancelled.id)
        assert.equal(readQueue().status, 'cancelled'); assert.equal(readQueue().items[0].state, 'unconfirmed')
        assert.equal(installed(), undefined); await delay(1550); assert.equal(readQueue().status, 'cancelled')
      } else {
        currentJob.state = 'installed'; await until(() => readQueue().status === 'completed'); assert(installed())
      }
      await client.getServiceInstallerStatus(ip); assert.equal(calls.pair, 1)
      assert.equal(calls.submit, 1); assert.equal(calls.payload, 0)
      }
    }
  }
  console.log(`PASS: ${mode}`)
} finally { rmSync(directory, { recursive: true, force: true }) }
