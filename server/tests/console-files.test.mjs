import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { build } from 'esbuild'
import { createError } from 'h3'

const repo = process.cwd()
const serviceSource = resolve(process.env.PACKAGEFLOW_SERVICE_SOURCE || resolve(repo, '../../PS/PackageFlowService'))
const nativeAvailable = existsSync(resolve(serviceSource, 'files.c'))
if (process.env.PACKAGEFLOW_SERVICE_SOURCE) assert.ok(nativeAvailable, 'PACKAGEFLOW_SERVICE_SOURCE must point to the private service source')
test('real file API: folders, copy resume, trash/restore, replacement and editor conflicts', { skip: !nativeAvailable && 'Private service source and OpenOrbis tests are maintained locally' }, async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'packageflow-file-jobs-')), native = resolve(dir, 'bridge'), bundle = resolve(repo, 'node_modules/.cache/console-files-test.mjs')
  const r = spawnSync('cc', ['-DPFS_FILE_TEST', '-std=c11', '-Wall', '-Wextra', '-Werror', '-o', native, resolve(serviceSource, 'tests/files-bridge.c'), resolve(serviceSource, 'files.c')], { cwd: repo, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  await build({ entryPoints: [resolve(repo, 'server/utils/console-files.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  const child = spawn(native, [], { stdio: ['pipe', 'pipe', 'inherit'] }), lines = createInterface({ input: child.stdout }), pending = []
  lines.on('line', line => { const next = pending.shift(); next?.(JSON.parse(line)) })
  function call(route, body) { return new Promise(resolve => { pending.push(resolve); child.stdin.write(`${route}\t${body}\n`) }) }
  const disk = resolve(dir, 'disk'); mkdirSync(disk)
  const ip = '10.1.10.32'
  let failChunk = false, loseMoveReply = false, loseDeleteReply = false, beforeDelete
  globalThis.createError = createError
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname
    if (path.startsWith('/files/upload/') && init.method === 'PUT') {
      if (failChunk && Number(init.headers['X-Offset']) > 0) { failChunk = false; throw new Error('connection interrupted') }
      const result = await call(`PUT:${path.split('/').at(-1)}:${init.headers['X-Offset']}`, Buffer.from(init.body).toString('hex'))
      return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } })
    }
    const body = JSON.parse(init.body || '{}')
    for (const key of ['path', 'destination']) if (body[key]?.startsWith('/data')) body[key] = disk + body[key].slice(5)
    if (path === '/files/delete' && beforeDelete) { const hook = beforeDelete; beforeDelete = undefined; hook(body) }
    const result = await call(path, JSON.stringify(body))
    if (path === '/files/move' && loseMoveReply && result.status === 200) { loseMoveReply = false; throw new Error('reply lost') }
    if (path === '/files/delete' && loseDeleteReply && result.status === 200) { loseDeleteReply = false; throw new Error('delete reply lost') }
    return new Response(path === '/files/read' && result.status === 200 ? Buffer.from(result.asset, 'hex') : JSON.stringify(result.body), { status: result.status, headers: { 'content-type': path === '/files/read' && result.status === 200 ? 'application/octet-stream' : 'application/json' } })
  }
  process.chdir(dir); mkdirSync('.data'); writeFileSync('.data/ps4-service-keys.json', JSON.stringify({ [ip]: '0123456789abcdef0123456789abcdef' }))
  try {
    const f = await import(bundle + '?v=' + Date.now())
    async function wait(id) {
      for (let i = 0; i < 300; ++i) {
        const job = f.fileJobs(ip).jobs.find(j => j.id === id)
        if (['completed', 'failed', 'paused'].includes(job.state)) return job
        await new Promise(r => setTimeout(r, 10))
      }
      throw new Error('job timeout')
    }
    async function run(input, state = 'completed') { const j = f.startFileJob(ip, input); const done = await wait(j.id); assert.equal(done.state, state, JSON.stringify(done)); return done }
    assert.throws(() => f.userFilePath('/data/PackegeFlowService', true))
    assert.throws(() => f.userFilePath('/data/foo/../bar', true))
    assert.throws(() => f.startFileJob(ip, { action: 'trash', paths: ['/user/home'] }))
    const requestId = '11223344-5566-4788-8899-aabbccddeeff'
    const folderJob = await run({ action: 'mkdir', paths: ['/data'], name: 'source', requestId })
    assert.equal(f.startFileJob(ip, { action: 'mkdir', paths: ['/data'], name: 'source', requestId }).id, folderJob.id)
    assert.throws(() => f.startFileJob(ip, { action: 'mkdir', paths: ['/data'], name: 'other', requestId }), /другой операцией/)
    assert.equal(f.fileJobs(ip).jobs.filter(j => j.id === requestId).length, 1)
    const text = 'Hello — Привет\r\n'; writeFileSync(resolve(disk, 'source/settings.json'), JSON.stringify({ text }))
    mkdirSync(resolve(disk, 'source/empty'))
    const data = Buffer.alloc(600000, 37); writeFileSync(resolve(disk, 'source/big.bin'), data)
    await run({ action: 'mkdir', paths: ['/data'], name: 'destination' })
    failChunk = true
    let j = await run({ action: 'copy', paths: ['/data/source'], destination: '/data/destination' }, 'paused')
    f.resumeFileJob(ip, j.id); j = await wait(j.id); assert.equal(j.state, 'completed', JSON.stringify(j))
    assert.deepEqual(readFileSync(resolve(disk, 'destination/source/big.bin')), data)
    assert.ok(existsSync(resolve(disk, 'destination/source/empty')))
    await run({ action: 'copy', paths: ['/data/source'], destination: '/data/destination' }, 'failed')
    loseMoveReply = true
    j = await run({ action: 'rename', paths: ['/data/source/settings.json'], name: 'config.json' }, 'failed')
    f.resumeFileJob(ip, j.id); assert.equal((await wait(j.id)).state, 'completed')
    await run({ action: 'move', paths: ['/data/destination/source'], destination: '/data' }, 'failed')
    await run({ action: 'mkdir', paths: ['/data'], name: 'moved' })
    await run({ action: 'move', paths: ['/data/destination/source'], destination: '/data/moved' })
    await run({ action: 'move', paths: ['/data/moved/source'], destination: '/data/destination' })
    const original = await f.readConsoleText(ip, '/data/source/config.json')
    const saved = await f.saveConsoleText(ip, { ...original, text: '{"ok":true}\r\n' })
    assert.equal((await wait(saved.id)).state, 'completed')
    assert.equal(readFileSync(resolve(disk, 'source/config.json'), 'utf8'), '{"ok":true}\r\n')
    let copies = f.fileJobs(ip).trash; const previous = copies.find(t => t.reason === 'replaced'); assert.ok(previous)
    assert.equal(readFileSync(disk + previous.stored.slice(5), 'utf8'), original.text)
    await assert.rejects(f.saveConsoleText(ip, { ...original, text: 'stale' }), /изменился/)
    await run({ action: 'trash', paths: ['/data/source/config.json'] })
    assert.ok(!existsSync(resolve(disk, 'source/config.json')))
    const removed = f.fileJobs(ip).trash.find(t => t.reason === 'deleted' && t.original.endsWith('config.json'))
    await run({ action: 'restore', trashId: removed.id })
    assert.equal(readFileSync(resolve(disk, 'source/config.json'), 'utf8'), '{"ok":true}\r\n')
    await run({ action: 'restore', trashId: previous.id }, 'failed')
    await run({ action: 'trash', paths: ['/data/destination/source'] })
    const tree = f.fileJobs(ip).trash.find(t => t.original === '/data/destination/source')
    await run({ action: 'restore', trashId: tree.id })
    assert.deepEqual(readFileSync(resolve(disk, 'destination/source/big.bin')), data)
    await assert.rejects(f.readConsoleText(ip, '/data/source/big.bin'), /Редактор/)
    writeFileSync(resolve(disk, 'source/invalid.txt'), Buffer.from([0xff, 0xfe]))
    await assert.rejects(f.readConsoleText(ip, '/data/source/invalid.txt'), /UTF-8/)
    // Installer icons and staged save data retain their existing authenticated upload paths.
    mkdirSync(resolve(disk, 'PackegeFlowService'))
    const uploadId = '12345678-1234-4234-8234-123456789abc'
    const iconPath = resolve(disk, 'PackegeFlowService/install-icon-CUSA00001.png')
    const iconStart = await call('/files/upload/start', JSON.stringify({ path: iconPath, id: uploadId, size: 3 }))
    assert.equal(iconStart.status, 200)
    assert.equal((await call(`PUT:${uploadId}:0`, '010203')).status, 200)
    assert.equal((await call('/files/upload/finish', JSON.stringify({ id: uploadId }))).status, 200)
    assert.equal((await call('/files/upload/start', JSON.stringify({ path: resolve(disk, 'PackegeFlowService/web-key'), id: uploadId, size: 3 }))).status, 400)
    // A protected hidden key must not silently produce an incomplete directory copy.
    mkdirSync(resolve(disk, 'secrets')); writeFileSync(resolve(disk, 'secrets/web-key'), 'hidden')
    await run({ action: 'copy', paths: ['/data/secrets'], destination: '/data/destination' }, 'failed')
    // Permanent deletion requires explicit intent; protected trees are preflighted before any mutation.
    assert.throws(() => f.startFileJob(ip, { action: 'delete', paths: ['/data/source'] }), /Подтвердите/)
    await run({ action: 'delete', paths: ['/data/secrets'], confirmPermanent: true }, 'failed')
    assert.ok(existsSync(resolve(disk, 'secrets/web-key')))
    writeFileSync(resolve(disk, 'erase.txt'), 'disposable')
    loseDeleteReply = true
    j = await run({ action: 'delete', paths: ['/data/erase.txt'], confirmPermanent: true }, 'paused')
    assert.ok(!existsSync(resolve(disk, 'erase.txt')))
    f.resumeFileJob(ip, j.id); assert.equal((await wait(j.id)).state, 'completed')
    // New content arriving during deletion must survive and keep the directory from disappearing.
    mkdirSync(resolve(disk, 'erase-tree')); writeFileSync(resolve(disk, 'erase-tree/old.txt'), 'old')
    beforeDelete = () => writeFileSync(resolve(disk, 'erase-tree/new.txt'), 'new arrival')
    await run({ action: 'delete', paths: ['/data/erase-tree'], confirmPermanent: true }, 'failed')
    assert.equal(readFileSync(resolve(disk, 'erase-tree/new.txt'), 'utf8'), 'new arrival')
    // A changed planned file is not removed.
    writeFileSync(resolve(disk, 'changed.txt'), 'old')
    beforeDelete = () => writeFileSync(resolve(disk, 'changed.txt'), 'changed')
    await run({ action: 'delete', paths: ['/data/changed.txt'], confirmPermanent: true }, 'failed')
    assert.equal(readFileSync(resolve(disk, 'changed.txt'), 'utf8'), 'changed')
    await run({ action: 'delete', paths: ['/data/erase-tree'], confirmPermanent: true })
    assert.ok(!existsSync(resolve(disk, 'erase-tree')))
    await run({ action: 'purge', trashIds: [previous.id], confirmPermanent: true })
    assert.ok(!existsSync(disk + previous.stored.slice(5))); assert.ok(existsSync(resolve(disk, 'source/config.json')))
    assert.ok(!f.fileJobs(ip).trash.some(t => t.id === previous.id))
    await run({ action: 'restore', trashId: previous.id }, 'failed')
    await run({ action: 'trash', paths: ['/data/destination/source'] })
    const purgeTree = f.fileJobs(ip).trash.find(t => t.original === '/data/destination/source')
    loseDeleteReply = true
    j = await run({ action: 'purge', trashIds: [purgeTree.id], confirmPermanent: true }, 'paused')
    assert.equal(f.fileJobs(ip).trash.find(t => t.id === purgeTree.id).purging, j.id)
    await run({ action: 'restore', trashId: purgeTree.id }, 'failed')
    f.resumeFileJob(ip, j.id); assert.equal((await wait(j.id)).state, 'completed')
    assert.ok(!f.fileJobs(ip).trash.some(t => t.id === purgeTree.id))
    assert.ok(!existsSync(disk + purgeTree.stored.slice(5)))
  } finally { child.stdin.end(); child.kill(); lines.close(); process.chdir(repo); rmSync(dir, { recursive: true, force: true }); rmSync(bundle, { force: true }) }
})
