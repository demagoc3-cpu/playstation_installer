import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { blake3 } from '@noble/hashes/blake3.js'
const temp = await mkdtemp(join(tmpdir(), 'pf-folder-web-')), modulePath = join(temp, 'api.mjs')
await build({ stdin: { contents: "export * from './server/utils/ps5-folder-driver'; export * from './shared/ps5-install-readiness'; export * from './shared/device-eligibility';", resolveDir: resolve('.') }, outfile: modulePath, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const api = await import(pathToFileURL(modulePath).href), signal = new AbortController().signal
const fixture = async name => {
  const root = join(temp, name); await mkdir(join(root, 'sce_sys'), { recursive: true }); await mkdir(join(root, 'empty'))
  const param = JSON.stringify({ titleId: 'PPSA95037', contentId: 'IV0000-PPSA95037_00-PACKAGEFLOWUI001', contentVersion: '01.000.036' })
  await writeFile(join(root, 'sce_sys/param.json'), param); await writeFile(join(root, 'eboot.bin'), Buffer.alloc(700000, 13)); await writeFile(join(root, 'zero'), '')
  return { root, item: { platform: 'ps5', order: 0, format: 'folder', size: 700000 + Buffer.byteLength(param), titleId: 'PPSA95037', contentId: 'IV0000-PPSA95037_00-PACKAGEFLOWUI001', appVersion: '01.000.036', transferId: 'a'.repeat(32), bytesSent: 0 } }
}
test('Folder resumes durable offset after lost reply, publishes once, and requires exact registration proof', async () => {
  const { root, item } = await fixture('resume'), progress = [], p = await api.createFolderPlan(root, item, signal, n => progress.push(n))
  assert.equal(progress.at(-1), item.size); assert.ok(p.entries.some(e => e.path === 'empty' && e.dir)); assert.ok(p.entries.some(e => e.path === 'zero' && e.size === 0))
  assert.equal(p.manifestHash, Buffer.from(blake3(Buffer.from(api.folderManifest(p)))).toString('hex'))
  const transfers = new Map(), offsets = []; let lost = false, published = false, publishCount = 0, registered = false
  const request = async (id, path, headers = {}, bytes) => {
    let t = transfers.get(id)
    if (path.endsWith('/begin')) { if (t) return { status: 409, body: {} }; t = { id, size: +headers['X-PackageFlow-Size'], blake3: headers['X-PackageFlow-Blake3'], bytesDurable: 0, cancelled: false, verified: false, chunkMax: 262144, data: Buffer.alloc(0) }; transfers.set(id, t) }
    if (path.endsWith('/chunk')) { const offset = +headers['X-PackageFlow-Offset']; offsets.push(offset); assert.equal(offset, t.bytesDurable); t.data = Buffer.concat([t.data, bytes]); t.bytesDurable += bytes.length; if (!lost) { lost = true; throw new Error('lost durable acknowledgement') } }
    if (path === '/api/v1/transfers/commit') { assert.equal(Buffer.from(blake3(t.data)).toString('hex'), t.blake3); t.verified = true }
    if (path === '/api/v1/folder/commit') { assert.ok([...transfers.values()].every(t => t.verified)); if (!published) { published = true; publishCount++ }; return { status: 202, body: {} } }
    if (path === '/api/v1/folder/status') return published ? { status: 200, body: { id, title: p.title, proof: 'folder-registration', state: registered ? 'registered' : 'published', manifestHash: p.manifestHash, metadataHash: p.metadataHash } } : { status: 404, body: {} }
    return { status: 200, body: t }
  }
  const phases = []; const save = patch => { if (patch.progressPhase) phases.push(patch.progressPhase); Object.assign(item, patch) }
  await assert.rejects(api.runFolderPlan(p, item, signal, request, save), /lost/)
  assert.equal(published, false); assert.equal(item.installDispatched, undefined)
  await api.runFolderPlan(p, item, signal, request, save)
  assert.equal(offsets[1], 262144, 'durable chunk is not resent'); assert.equal(item.bytesSent, item.size); assert.equal(publishCount, 1); assert.ok(phases.includes('device-check'), 'device verification must not be labelled as transfer')
  assert.equal((await api.runFolderPlan(p, item, signal, request, save)).state, 'installing'); assert.equal(publishCount, 1)
  registered = true; const result = await api.runFolderPlan(p, item, signal, request, save)
  assert.equal(result.state, 'installed'); assert.equal(result.confirmation, 'service-registration')
  await assert.rejects(api.runFolderPlan(p, item, signal, async () => ({ status: 200, body: { id: p.id, title: p.title, proof: 'folder-registration', state: 'registered', manifestHash: 'b'.repeat(64), metadataHash: p.metadataHash } }), save), /не соответствует/)
})
test('Folder rejects source changes, unsafe paths and links before publication', async () => {
  const { root, item } = await fixture('mutated'), p = await api.createFolderPlan(root, item, signal, () => {})
  await writeFile(join(root, 'added'), 'unexpected')
  let requests = 0; await assert.rejects(api.runFolderPlan(p, item, signal, async () => { requests++; throw new Error() }, () => {}), /изменилась/); assert.equal(requests, 0)
  for (const path of ['../x','/x','a//b','a/./b','a\\b','C:x','x\0']) assert.equal(api.folderRelativePath(path), false)
  const other = await fixture('linked'); await symlink(join(other.root, 'eboot.bin'), join(other.root, 'alias'))
  await assert.rejects(api.createFolderPlan(other.root, other.item, signal, () => {}), /Ссылки/)
  await assert.rejects(api.createFolderPlan(root, { ...item, platform: 'ps4' }, signal, () => {}), /метаданные/)
})
test('published Folder reports overdue registration, keeps checking and never republishes', async () => {
  const { root, item } = await fixture('registration-timeout')
  const p = await api.createFolderPlan(root, item, signal, () => {})
  Object.assign(item, { installDispatched: true, bytesSent: item.size })
  let now = 1000000, registered = false
  const clock = Date.now, requests = [], save = patch => Object.assign(item, patch)
  const request = async (id, path) => {
    requests.push(path)
    return { status: 200, body: { id, title: p.title, proof: 'folder-registration', state: registered ? 'registered' : 'published', manifestHash: p.manifestHash, metadataHash: p.metadataHash } }
  }
  try {
    Date.now = () => now
    assert.equal((await api.runFolderPlan(p, item, signal, request, save)).state, 'installing')
    assert.equal(item.folderPublishedAt, now)
    now += 120000
    assert.equal((await api.runFolderPlan(p, item, signal, request, save)).state, 'installing')
    // The timestamp survives persistence and restarting the queue worker.
    const restored = JSON.parse(JSON.stringify(item))
    now++
    await assert.rejects(api.runFolderPlan(p, restored, signal, request, patch => Object.assign(restored, patch)), /PS5 не подтвердила регистрацию за 2 минуты/)
    assert.equal(restored.bytesSent, item.size)
    registered = true
    const result = await api.runFolderPlan(p, restored, signal, request, patch => Object.assign(restored, patch))
    assert.equal(result.state, 'installed')
    assert.equal(result.confirmation, 'service-registration')
    assert.ok(requests.every(path => path === '/api/v1/folder/status'))
  } finally { Date.now = clock }
})
test('Folder admission is independent of PKG; untested firmware and malformed receipts remain disabled', () => {
  const body = { service: 'PackageFlowService-PS5', schemaVersion: 1, route: 'staged-pkg', ready: false, reason: 'installer_unavailable', formats: [], platforms: [], exactVersionReceipt: false, folder: { schemaVersion: 1, route: 'staged-folder', ready: true, platforms: ['ps5'] } }
  const c = api.ps5InstallCapabilities(200, body, '13.60'); assert.deepEqual(c.formats, ['folder']); assert.equal(c.installPs5, true); assert.equal(c.installPs4, false); assert.equal(c.installation.ready, false)
  const profile = { platform: 'ps5', firmware: '13.60', online: true, paired: true, capabilities: c }
  assert.equal(api.deviceInstallReason(profile, [{ platform: 'ps5', format: 'folder', size: 10 }], 10), '')
  assert.notEqual(api.deviceInstallReason(profile, [{ platform: 'ps5', format: 'pkg', size: 10 }], 10), '')
  assert.notEqual(api.deviceInstallReason({ ...profile, platform: 'ps4' }, [{ platform: 'ps5', format: 'folder', size: 10 }], 10), '')
  assert.deepEqual(api.ps5InstallCapabilities(200, body, '12.60').formats, [])
  assert.deepEqual(api.ps5InstallCapabilities(200, { ...body, folder: { ...body.folder, platforms: ['ps4','ps5'] } }, '13.60').formats, [])
  assert.deepEqual(api.ps5InstallCapabilities(503, body, '13.60').formats, [])
})
test.after(async () => { await rm(temp, { recursive: true, force: true }) })

test('negotiated pipeline uploads the next file while verifying, bounds pending checks and gates publication', async () => {
  const { root, item } = await fixture('pipeline')
  for (const name of ['a', 'b', 'c']) { await writeFile(join(root, name), name); item.size++ }
  const p = await api.createFolderPlan(root, item, signal, () => {}), files = p.entries.filter(e => !e.dir && e.size)
  const transfers = new Map(), gates = new Map(), begun = [], published = []
  const request = async (id, path, headers = {}, bytes) => {
    let t = transfers.get(id)
    if (path.endsWith('/begin')) { begun.push(id); t = { id, size: +headers['X-PackageFlow-Size'], blake3: headers['X-PackageFlow-Blake3'], bytesDurable: 0, cancelled: false, verified: false, chunkMax: 262144 }; transfers.set(id, t) }
    if (path.endsWith('/chunk')) { assert.equal(+headers['X-PackageFlow-Offset'], t.bytesDurable); t.bytesDurable += bytes.length }
    if (path === '/api/v1/transfers/commit') {
      if (id === files[0].id || id === files[1].id) { let release; const wait = new Promise(r => { release = r }); gates.set(id, { wait, release }); return { status: 202, body: {} } }
      t.verified = true
    }
    if (path === '/api/v1/operations/status') { await gates.get(id).wait; t.verified = true; return { status: 200, body: { id, phase: 'verifying', running: false, status: 200, result: t } } }
    if (path === '/api/v1/folder/commit') { assert.ok([...transfers.values()].every(t => t.verified)); published.push(id); return { status: 202, body: {} } }
    return { status: 200, body: t }
  }
  const work = api.runFolderPlan(p, item, signal, request, patch => Object.assign(item, patch), 2)
  for (let i = 0; gates.size < 2 && i < 1000; i++) await new Promise(r => setImmediate(r))
  assert.equal(gates.size, 2, 'second file is uploaded before first verification finishes')
  assert.deepEqual(begun, [files[0].id, files[1].id], 'a third pending file is blocked by the bounded window')
  assert.equal(item.state, 'sending'); assert.equal(item.installDispatched, undefined); assert.deepEqual(published, [])
  for (const gate of gates.values()) gate.release()
  await work; assert.deepEqual(published, [p.id]); assert.equal(item.bytesSent, item.size)
})

test('a background hash failure stops further sending and never publishes a partial folder', async () => {
  const { root, item } = await fixture('pipeline-failed'), p = await api.createFolderPlan(root, item, signal, () => {})
  const transfers = new Map(); let release, published = false
  const failed = new Promise(resolve => { release = resolve })
  const request = async (id, path, headers = {}, bytes, requestSignal) => {
    let t = transfers.get(id)
    if (path.endsWith('/begin')) { t = { id, size: +headers['X-PackageFlow-Size'], blake3: headers['X-PackageFlow-Blake3'], bytesDurable: 0, cancelled: false, verified: false, chunkMax: 262144 }; transfers.set(id, t) }
    if (path.endsWith('/chunk')) { if (transfers.size > 1) { release(); await new Promise(r => setImmediate(r)); requestSignal.throwIfAborted() }; t.bytesDurable += bytes.length }
    if (path === '/api/v1/transfers/commit') return { status: 202, body: {} }
    if (path === '/api/v1/operations/status') { await failed; return { status: 200, body: { id, phase: 'verifying', running: false, status: 422 } } }
    if (path === '/api/v1/folder/commit') published = true
    return { status: 200, body: t }
  }
  await assert.rejects(api.runFolderPlan(p, item, signal, request, patch => Object.assign(item, patch), 2), /BLAKE3/)
  assert.equal(published, false); assert.equal(transfers.has(p.id), false); assert.equal(item.installDispatched, undefined)
})

test('local publication reports preparation bytes without counting them as network transfer', async () => {
  const { root, item } = await fixture('publication-progress'), p = await api.createFolderPlan(root, item, signal, () => {})
  item.installDispatched = true
  const request = async (id, path) => path === '/api/v1/folder/status' ? { status: 404, body: {} } : { status: 200, body: { id, phase: 'publishing-folder', running: true, status: 202, result: { bytesPrepared: 350000, bytesTotal: p.total } } }
  const r = await api.runFolderPlan(p, item, signal, request, () => assert.fail('must not transfer or redispatch'))
  assert.equal(r.state, 'installing'); assert.match(r.detail, /Подготавливаем/); assert.equal(r.bytesSent, undefined)
})

test('streamed Folder begins after metadata scan, hashes bytes as sent, recovers lost ACK and publishes only sealed files', async () => {
  const { root, item } = await fixture('stream-resume'), progress = [], p = await api.createFolderPlan(root, item, signal, n => progress.push(n), true)
  assert.equal(p.version, 2); assert.equal(p.manifestHash, ''); assert.ok(p.planHash)
  assert.ok(p.entries.filter(e => !e.dir && e.size).every(e => !e.hash), 'preparation never computes content hashes')
  assert.deepEqual(progress, [0,0])
  const transfers = new Map(), offsets = [], snapshots = []; let lost = false, publication = false
  const request = async (id, path, headers = {}, bytes) => {
    let t = transfers.get(id)
    if (path.endsWith('/begin')) {
      if (t) return { status: 409, body: {} }
      const stream = headers['X-PackageFlow-Stream'] === 'folder-stream-v2'
      t = { id, size: +headers['X-PackageFlow-Size'], blake3: headers['X-PackageFlow-Blake3'], sourceIdentity: stream ? headers['X-PackageFlow-Blake3'] : '', hashPending: stream, bytesDurable: 0, cancelled: false, verified: false, chunkMax: 262144, data: Buffer.alloc(0) }; transfers.set(id, t)
    }
    if (path.endsWith('/chunk')) {
      assert.equal(+headers['X-PackageFlow-Offset'], t.bytesDurable); offsets.push(t.bytesDurable)
      t.data = Buffer.concat([t.data, bytes]); t.bytesDurable += bytes.length
      if (!lost) { assert.equal(p.entries.find(e=>e.id===id).hash, undefined, 'first upload starts before full-file hash'); lost = true; throw new Error('lost ACK') }
    }
    if (path === '/api/v1/transfers/commit') {
      if (t.hashPending) { assert.equal(headers['X-PackageFlow-Stream'], 'folder-stream-v2'); assert.equal(headers['X-PackageFlow-Blake3'], Buffer.from(blake3(t.data)).toString('hex')); t.blake3 = headers['X-PackageFlow-Blake3']; t.hashPending = false }
      assert.equal(Buffer.from(blake3(t.data)).toString('hex'), t.blake3); t.verified = true
    }
    if (path === '/api/v1/folder/commit') { assert.ok([...transfers.values()].every(t => t.verified && !t.hashPending)); publication = true; return { status: 202, body: {} } }
    return { status: 200, body: t }
  }
  const save = patch => Object.assign(item,patch), persist = value => snapshots.push(structuredClone(value))
  await assert.rejects(api.runFolderPlan(p,item,signal,request,save,0,persist),/lost ACK/)
  assert.equal(publication,false)
  await api.runFolderPlan(p,item,signal,request,save,0,persist)
  assert.equal(offsets[1],262144); assert.equal(publication,true); assert.equal(item.hash,p.manifestHash)
  assert.ok(snapshots.at(-1).entries.filter(e=>!e.dir).every(e=>e.hash))
  await api.verifyFolderPlan(p,item,root)
  const mutated = structuredClone(p); mutated.entries[0].path = 'foreign'; await assert.rejects(api.verifyFolderPlan(mutated,item,root),/изменился/)
})

test('streamed route is admitted only with exact tested protocol and single-copy receipt', () => {
  const body = { service: 'PackageFlowService-PS5', schemaVersion: 1, folder: { schemaVersion: 1, route: 'staged-folder', ready: true, platforms: ['ps5'], verificationWindow: 2, streamProtocol: 'folder-stream-v2', storageCopies: 1, streamingHash: true } }
  assert.equal(api.ps5InstallCapabilities(200,body,'13.60').folder.streamProtocol,'folder-stream-v2')
  for(const patch of [{storageCopies:2},{streamingHash:false},{streamProtocol:'unknown'}]) assert.equal(api.ps5InstallCapabilities(200,{...body,folder:{...body.folder,...patch}},'13.60').folder.streamProtocol,undefined)
})

for (const batchMax of [16777216,33554432]) test(`qualified ${batchMax/1048576} MiB batches resume a lost acknowledgement without resending and seal the same file`, async () => {
  const { root, item } = await fixture('batch-resume-'+batchMax)
  const data=Buffer.alloc(36*1048576+137,0x37);await writeFile(join(root,'eboot.bin'),data);item.size+=data.length-700000
  const p=await api.createFolderPlan(root,item,signal,()=>{},true),transfers=new Map(),offsets=[];let lost=false,published=false
  const request=async(id,path,headers={},bytes)=>{
    let t=transfers.get(id)
    if(path.endsWith('/begin')){if(t)return{status:409,body:t};t={id,size:+headers['X-PackageFlow-Size'],blake3:headers['X-PackageFlow-Blake3'],sourceIdentity:headers['X-PackageFlow-Blake3'],hashPending:true,bytesDurable:0,cancelled:false,verified:false,chunkMax:4194304,batchMax,data:Buffer.alloc(0)};transfers.set(id,t)}
    if(path.endsWith('/batch')||path.endsWith('/chunk')){assert.equal(+headers['X-PackageFlow-Offset'],t.bytesDurable);assert.ok(bytes.length<=batchMax);if(t.size===data.length)offsets.push(t.bytesDurable);t.data=Buffer.concat([t.data,bytes]);t.bytesDurable+=bytes.length;if(!lost&&t.size===data.length){lost=true;throw Error('lost batch ACK')}}
    if(t?.size===data.length)assert.ok(!path.endsWith('/chunk'),'qualified stream uses batches')
    if(path.endsWith('/transfers/commit')){const actual=Buffer.from(blake3(t.data)).toString('hex');assert.equal(headers['X-PackageFlow-Blake3']||t.blake3,actual);t.blake3=actual;t.hashPending=false;t.verified=true}
    if(path==='/api/v1/folder/commit'){assert.ok([...transfers.values()].every(t=>t.verified));published=true;return{status:202,body:{}}}
    return{status:200,body:t}
  }
  const save=patch=>Object.assign(item,patch)
  await assert.rejects(api.runFolderPlan(p,item,signal,request,save,0,()=>{}),/lost batch ACK/)
  assert.equal(published,false)
  await api.runFolderPlan(p,item,signal,request,save,0,()=>{})
  assert.deepEqual(offsets,Array.from({length:Math.ceil(data.length/batchMax)},(_,i)=>i*batchMax));assert.equal(item.bytesSent,item.size);assert.equal(published,true)
})
