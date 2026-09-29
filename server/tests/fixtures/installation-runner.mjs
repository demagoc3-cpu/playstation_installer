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
  contentId: 'EP0000-CUSA00001_00-ABCDEFGHIJKLMNOP', contentType: 'PS4GD', packageDigest: 'a'.repeat(40), iconSize: 0,
  path: resolve('game.pkg'), libraryRoot: directory, sourceModifiedAt: 1, icon: { offset: 0, size: 0 } }
writeFileSync('.data/package-library.json', JSON.stringify({ version: 2, packages: [item], deliveries: {} }))
const ip = '192.168.88.147'
const token = 'abcdef0123456789abcdef0123456789'
const input = { psIp: ip, packageIds: ['one'], packageUrls: { one: 'http://192.168.88.10:3000/json/one.json' } }
const calls = { payload: 0, commands: 0, service: 0, submit: 0, pair: 0, cancel: 0 }
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
let currentJob
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const cap = { service: 'PackegeFlowService', version: '0.4.0', installApi: 1, ready: true, authentication: 'bearer', contentTypes: ['PS4GD'], error: 0, errorHex: '0x00000000' }
const makeJob = id => ({ service: 'PackegeFlowService', jobId: id, requestId: id, contentId: item.contentId, taskId: 43, state: 'downloading',
  totalBytes: item.size, downloadedBytes: 5368709120, downloadTotalBytes: item.size, error: 0, errorHex: '0x00000000', pollError: 0 })
globalThis.fetch = async (url, options) => {
  calls.service++
  const path = new URL(url).pathname
  if (path === '/install/pair') { calls.pair++; assert.deepEqual(JSON.parse(options.body), { code: 'F7Y-YUH' }); return response({ service: cap.service, paired: true, token }) }
  if (path === '/install/capabilities') return response(cap)
  assert.equal(options.headers.Authorization, `Bearer ${token}`)
  if (path === '/install/session') return response(cap)
  if (path === '/install/jobs' && options.method === 'POST') {
    calls.submit++; assert.equal(calls.submit, 1, 'accepted task must never be POSTed twice')
    const body = JSON.parse(options.body); assert.equal(body.size, item.size); assert.equal(body.contentType, 'PS4GD')
    currentJob = makeJob(body.requestId)
    throw new Error('Connection lost after PS4 accepted the task')
  }
  assert(currentJob && path.startsWith(`/install/jobs/${currentJob.jobId}`))
  if (path.endsWith('/cancel')) { calls.cancel++; currentJob.state = 'cancelled' }
  return response(currentJob)
}
const load = name => import(pathToFileURL(resolve(root, `server/utils/${name}.ts`)).href)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const readQueue = () => JSON.parse(readFileSync('.data/installation-queue.json', 'utf8'))
const installed = () => JSON.parse(readFileSync('.data/package-library.json', 'utf8')).packages[0].installedAt
async function until(check) {
  const deadline = Date.now() + 8000
  while (!check()) { assert(Date.now() < deadline, `timed out in ${mode}`); await delay(30) }
}
try {
  if (mode === 'legacy') {
    writeFileSync('.data/installation-queue.json', JSON.stringify({ version: 1, status: 'running', psIp: ip, createdAt: 1,
      items: [{ packageId: 'one', url: input.packageUrls.one, state: 'waiting', detail: '', bytesSent: 0, dispatchedAt: Date.now() - 25000 }] }))
    const queue = await load('installation-queue'); queue.ensureInstallationQueueRunning()
    await until(() => readQueue().status === 'completed')
    assert.equal(readQueue().transport, 'payload'); assert.equal(readQueue().items[0].state, 'unconfirmed')
    assert.equal(installed(), undefined); assert.equal(calls.service, 0); assert.equal(calls.commands, 0)
  } else if (mode === 'payload') {
    const queue = await load('installation-queue')
    assert.throws(() => queue.startInstallationQueue({ ...input, transport: 'auto' }))
    const result = queue.startInstallationQueue(input); assert.equal(result.transport, 'payload')
    await until(() => calls.commands === 1)
    assert.equal(calls.service, 0); assert.equal(calls.payload, 1)
    queue.cancelInstallationQueue(); assert.equal(readQueue().status, 'cancelled')
    await delay(1550); assert.equal(calls.commands, 1)
  } else {
    const client = await load('ps4-service-installer')
    if (mode === 'restart') {
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
      assert.equal(result.configured, true); assert.equal(JSON.stringify(result).includes(token), false)
      assert(client.serviceKeyConfigured(ip)); assert.equal(calls.pair, 1)
      const queue = await load('installation-queue'); queue.startInstallationQueue({ ...input, transport: 'service' })
      await until(() => readQueue().items[0].state === 'receiving')
      assert.equal(readQueue().items[0].bytesSent, 5368709120); assert.equal(calls.submit, 1); assert.equal(calls.payload, 0)
      currentJob.downloadedBytes = currentJob.totalBytes
      await delay(1600); assert.equal(readQueue().status, 'running'); assert.equal(installed(), undefined)
      if (mode === 'cancel') {
        queue.cancelInstallationQueue(); await until(() => readQueue().status === 'cancelled'); assert.equal(calls.cancel, 1); assert.equal(installed(), undefined)
      } else {
        currentJob.state = 'installed'; await until(() => readQueue().status === 'completed'); assert(installed())
      }
      await client.getServiceInstallerStatus(ip); assert.equal(calls.pair, 1)
      assert.equal(calls.submit, 1); assert.equal(calls.payload, 0)
    }
  }
  console.log(`PASS: ${mode}`)
} finally { rmSync(directory, { recursive: true, force: true }) }
