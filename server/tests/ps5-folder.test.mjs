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
test('Folder admission is independent of PKG; untested firmware and malformed receipts remain disabled', () => {
  const body = { service: 'PackageFlowService-PS5', schemaVersion: 1, route: 'staged-pkg', ready: false, reason: 'installer_unavailable', formats: [], platforms: [], exactVersionReceipt: false, folder: { schemaVersion: 1, route: 'staged-folder', ready: true, platforms: ['ps5'] } }
  const c = api.ps5InstallCapabilities(200, body, '13.60'); assert.deepEqual(c.formats, ['folder']); assert.equal(c.installPs5, true); assert.equal(c.installPs4, false); assert.equal(c.installation.ready, false)
  const profile = { platform: 'ps5', online: true, paired: true, capabilities: c }
  assert.equal(api.deviceInstallReason(profile, [{ platform: 'ps5', format: 'folder', size: 10 }], 10), '')
  assert.notEqual(api.deviceInstallReason(profile, [{ platform: 'ps5', format: 'pkg', size: 10 }], 10), '')
  assert.notEqual(api.deviceInstallReason({ ...profile, platform: 'ps4' }, [{ platform: 'ps5', format: 'folder', size: 10 }], 10), '')
  assert.deepEqual(api.ps5InstallCapabilities(200, body, '12.60').formats, [])
  assert.deepEqual(api.ps5InstallCapabilities(200, { ...body, folder: { ...body.folder, platforms: ['ps4','ps5'] } }, '13.60').formats, [])
  assert.deepEqual(api.ps5InstallCapabilities(503, body, '13.60').formats, [])
})
test.after(async () => { await rm(temp, { recursive: true, force: true }) })
