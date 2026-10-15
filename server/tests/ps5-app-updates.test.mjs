import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const work = mkdtempSync(join(tmpdir(), 'pf-web-app-update-'))
const key = `pfWebAppUpdate${process.pid}`
const state = globalThis[key] = {
  data: work, id: 'fixture-ps5', ip: '192.168.50.5', platform: 'ps5', current: '01.000.044', sourceAvailable: true, serviceVersion: '0.1.28-dev', serviceConfirmed: true,
  app: { titleId: 'PPSA95001', contentId: 'IV0000-PPSA95001_00-PACKAGEFLOWUI001', version: '01.000.044', buildId: 'new044', sha256: 'a'.repeat(64), format: 'ufs2', size: 22020096 },
  results: new Map(), writes: [], queue: { id: 'b'.repeat(32), status: 'idle', items: [] }, lostReply: false,
}
const statePrefix = `const s=globalThis[${JSON.stringify(key)}];`
const modules = {
  './console-profiles': `${statePrefix}export const getConsoleProfile=id=>{if(id!==s.id)throw Error('profile missing');return{id:s.id,ip:s.ip,platform:s.platform}};`,
  './console-setup-artifacts': `${statePrefix}export const consoleSetupBundle=async()=>({manifest:{app:{...s.app}}});`,
  './desktop-console-setup': `${statePrefix}
    export const findDesktopPs5AppRequest=(id,sha)=>s.desktopRequest?.id===id&&s.desktopRequest.sha===sha?s.desktopRequest.requestId:null;
    export const readDesktopPs5AppSetup=async(id,request)=>s.results.get(request)||null;
    export const installDesktopPs5App=async(id,request,update)=>{
      if(!update)throw Error('must use app update path');s.writes.push(request);
      s.results.set(request,{consoleId:id,receipt:{packageId:'app',queueId:s.queue.id,sha256:s.app.sha256},queue:s.queue,retry:'active'});
      if(s.wait)await s.wait;
      if(s.lostReply)throw Error('lost reply');
      return s.results.get(request);
    };`,
  './ps5-installation-queue': `${statePrefix}export const getPs5Queue=()=>structuredClone(s.queue);`,
  './ps5-console-games': `${statePrefix}export const ps5ConsoleGameInfo=async()=>{if(s.offline)throw Error('offline');return{titleId:s.app.titleId,contentId:s.app.contentId,version:s.current,installed:true,sourceAvailable:s.sourceAvailable}};`,
  './ps5-service-updates': `${statePrefix}export const ps5ServiceUpdateInfo=async()=>({current:s.serviceVersion,currentConfirmed:s.serviceConfirmed});`,
  './data-path': `${statePrefix}import{join}from'node:path';export const dataPath=(...parts)=>join(s.data,...parts);`,
}
await build({
  entryPoints: ['server/utils/ps5-app-updates.ts'], outfile: join(work, 'updates.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{ name: 'isolated-console', setup(build) {
    build.onResolve({ filter: /^\.\// }, args => args.importer === resolve('server/utils/ps5-app-updates.ts') && modules[args.path] ? { path: args.path, namespace: 'fixture' } : undefined)
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: modules[args.path], loader: 'js' }))
    build.onResolve({ filter: /^\.\/data-path$/ }, () => ({ path: './data-path', namespace: 'fixture' }))
  } }],
})
let api = await import(join(work, 'updates.mjs'))
const marker = () => JSON.parse(readFileSync(join(work, 'console-setup', `app-web-${state.id}.json`), 'utf8'))

test('WEB offers a bundled same-version revision without claiming its build is already installed', async () => {
  const info = await api.ps5AppUpdateInfo(state.id)
  assert.equal(info.current, '01.000.044')
  assert.equal(info.release.buildId, 'new044')
  assert.equal(info.currentBuildId, '')
  assert.equal(info.updateAvailable, true)
  assert.equal(info.canUpdate, true)
  assert.equal(info.flow, null)
  assert.equal(state.writes.length, 0, 'checking for updates cannot dispatch an install')
})
test('the WEB app update button requires a confirmed live ELF 0.1.28 or later', async () => {
  const writes = state.writes.length
  state.serviceVersion = '0.1.27-dev'
  const older = await api.ps5AppUpdateInfo(state.id)
  assert.equal(older.canUpdate, false)
  assert.equal(older.serviceReady, false)
  assert.equal(older.message, 'Сначала обновите ELF службы PS5 до 0.1.28 или новее')
  state.serviceVersion = '0.1.28-dev'; state.serviceConfirmed = false
  assert.equal((await api.ps5AppUpdateInfo(state.id)).canUpdate, false, 'an unconfirmed cached version is not enough')
  state.serviceConfirmed = true
  assert.equal((await api.ps5AppUpdateInfo(state.id)).canUpdate, true)
  assert.equal(state.writes.length, writes, 'ELF readiness checks cannot dispatch an app installation')
})
test('a lost acceptance survives WEB reload and only reads the original receipt', async () => {
  state.lostReply = true
  await assert.rejects(api.beginPs5AppUpdate(state.id), /lost reply/)
  const original = marker()
  assert.equal(original.sha256, state.app.sha256)
  assert.equal(state.writes.length, 1)
  api = await import(`${join(work, 'updates.mjs')}?restart=1`)
  assert.equal((await api.ps5AppUpdateInfo(state.id)).flow.state, 'active')
  assert.equal((await api.beginPs5AppUpdate(state.id)).flow.state, 'active')
  assert.equal(marker().requestId, original.requestId)
  assert.equal(state.writes.length, 1, 'a second click must never create another accepted install')
  state.results.get(original.requestId).retry = 'unconfirmed'
  assert.equal((await api.beginPs5AppUpdate(state.id)).flow.state, 'unconfirmed')
  assert.equal(state.writes.length, 1)
  state.lostReply = false
})
test('a confirmed terminal attempt may rotate only on an explicit update action', async () => {
  const original = marker().requestId
  state.results.get(original).retry = 'different-build'
  await api.ps5AppUpdateInfo(state.id)
  assert.equal(marker().requestId, original)
  await api.beginPs5AppUpdate(state.id)
  assert.notEqual(marker().requestId, original)
  assert.equal(state.writes.length, 2)
  state.results.get(marker().requestId).retry = 'installed'
  const info = await api.ps5AppUpdateInfo(state.id)
  assert.equal(info.currentBuildId, 'new044')
  assert.equal(info.updateAvailable, false)
  await api.beginPs5AppUpdate(state.id)
  assert.equal(state.writes.length, 2)
})
test('a changed bundle cannot supersede an unknown previous request', async () => {
  const original = marker().requestId
  state.app.sha256 = 'c'.repeat(64)
  state.results.get(original).retry = 'unconfirmed'
  const info = await api.ps5AppUpdateInfo(state.id)
  assert.equal(info.canUpdate, false)
  await api.beginPs5AppUpdate(state.id)
  assert.equal(marker().requestId, original)
  assert.equal(state.writes.length, 2)
  state.results.get(original).retry = 'installed'
  await api.beginPs5AppUpdate(state.id)
  assert.notEqual(marker().requestId, original)
  assert.equal(state.writes.length, 3)
  state.results.get(marker().requestId).retry = 'installed'
})
test('foreign platform, a busy queue and a corrupt request cannot send a package', async () => {
  state.platform = 'ps4'
  await assert.rejects(api.beginPs5AppUpdate(state.id), { statusCode: 400 })
  state.platform = 'ps5'
  state.queue.items = [{ state: 'sending', packageId: 'other', size: 100, bytesSent: 30 }]
  assert.equal((await api.ps5AppUpdateInfo(state.id)).canUpdate, false)
  state.queue.items = []
  const path = join(work, 'console-setup', `app-web-${state.id}.json`), saved = readFileSync(path)
  writeFileSync(path, '{broken')
  await assert.rejects(api.ps5AppUpdateInfo(state.id), { statusCode: 503 })
  await assert.rejects(api.beginPs5AppUpdate(state.id), { statusCode: 503 })
  assert.equal(state.writes.length, 3)
  writeFileSync(path, saved)
})
test('WEB recognizes the confirmed Windows installation and never sends the same bundle again', async () => {
  state.id = 'windows-ps5'
  const requestId = 'd'.repeat(32), writes = state.writes.length
  state.desktopRequest = { id: state.id, sha: state.app.sha256, requestId }
  state.results.set(requestId, { consoleId: state.id, receipt: { packageId: 'app', queueId: state.queue.id, sha256: state.app.sha256 }, queue: state.queue, retry: 'installed' })
  const info = await api.ps5AppUpdateInfo(state.id)
  assert.equal(info.currentBuildId, 'new044')
  assert.equal(info.flow.state, 'completed')
  assert.equal(info.updateAvailable, false)
  assert.equal(info.canUpdate, false)
  assert.equal((await api.beginPs5AppUpdate(state.id)).flow.state, 'completed')
  assert.equal(state.writes.length, writes)
  assert.equal(existsSync(join(work, 'console-setup', `app-web-${state.id}.json`)), false, 'read-only Windows receipt recognition does not create a WEB request')
})
test('a Windows receipt cannot hide a deleted source; restoration still requires an explicit click', async () => {
  const original = state.desktopRequest.requestId, writes = state.writes.length
  state.results.get(original).retry = 'absent'
  state.sourceAvailable = false
  const info = await api.ps5AppUpdateInfo(state.id)
  assert.equal(info.currentBuildId, '')
  assert.equal(info.installed, false)
  assert.equal(info.canUpdate, true)
  assert.equal(state.writes.length, writes)
  await api.beginPs5AppUpdate(state.id)
  assert.equal(state.writes.length, writes + 1)
  assert.notEqual(marker().requestId, original)
  assert.equal(marker().sha256, state.app.sha256)
})
test('a preflight-only WEB marker reconciles the old Windows bundle before advancing to a new bundle', async () => {
  state.id = 'preflight-ps5'; state.sourceAvailable = true
  const writes = state.writes.length, markerId = 'e'.repeat(32), windowsId = 'f'.repeat(32), oldSha = state.app.sha256
  const path = join(work, 'console-setup', `app-web-${state.id}.json`)
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, consoleId: state.id, ip: state.ip, requestId: markerId, sha256: oldSha, startedAt: 1 }))
  const markerBefore = readFileSync(path, 'utf8')
  state.desktopRequest = { id: state.id, sha: oldSha, requestId: windowsId }
  state.results.set(windowsId, { consoleId: state.id, receipt: { packageId: 'app', queueId: state.queue.id, sha256: oldSha }, queue: state.queue, retry: 'installed' })
  assert.equal((await api.ps5AppUpdateInfo(state.id)).flow.state, 'completed')
  assert.equal(readFileSync(path, 'utf8'), markerBefore, 'GET must not adopt the Windows receipt into its WEB marker')
  state.app.sha256 = '9'.repeat(64)
  state.results.get(windowsId).retry = 'unconfirmed'
  assert.equal((await api.ps5AppUpdateInfo(state.id)).canUpdate, false)
  await api.beginPs5AppUpdate(state.id)
  assert.equal(state.writes.length, writes, 'a shared unknown attempt cannot authorize a new bundle')
  assert.equal(readFileSync(path, 'utf8'), markerBefore)
  state.results.get(windowsId).retry = 'different-build'
  assert.equal((await api.ps5AppUpdateInfo(state.id)).canUpdate, true)
  assert.equal(readFileSync(path, 'utf8'), markerBefore)
  await api.beginPs5AppUpdate(state.id)
  assert.equal(state.writes.length, writes + 1)
  assert.notEqual(marker().requestId, markerId)
  assert.notEqual(marker().requestId, windowsId)
  assert.equal(marker().sha256, state.app.sha256)
})
test('a stale WEB marker cannot cause replacement when the shared receipt proves the current bundle is installed', async () => {
  state.id = 'stale-sha-ps5'
  const requestId = '7'.repeat(32), writes = state.writes.length
  const path = join(work, 'console-setup', `app-web-${state.id}.json`)
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, consoleId: state.id, ip: state.ip, requestId, sha256: '8'.repeat(64), startedAt: 1 }))
  const before = readFileSync(path, 'utf8')
  // The shared reader reconciles the missing old request with the newer,
  // successful Windows receipt. Its SHA is the proof, rather than marker SHA.
  state.results.set(requestId, { consoleId: state.id, receipt: { requestId: '6'.repeat(32), packageId: 'app', queueId: state.queue.id, sha256: state.app.sha256 }, queue: state.queue, retry: 'installed' })
  const info = await api.ps5AppUpdateInfo(state.id)
  assert.equal(info.flow.state, 'completed')
  assert.equal(info.currentBuildId, state.app.buildId)
  assert.equal(info.canUpdate, false)
  assert.equal(info.updateAvailable, false)
  assert.equal((await api.beginPs5AppUpdate(state.id)).flow.state, 'completed')
  assert.equal(state.writes.length, writes)
  assert.equal(readFileSync(path, 'utf8'), before)
})
test.after(() => { delete globalThis[key]; rmSync(work, { recursive: true, force: true }) })
