import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

test('PS4 reads negotiate bounded blocks, retain legacy support and retry only rejected reads', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-file-read-')), oldDir = process.env.PACKAGEFLOW_DATA_DIR, oldFetch = globalThis.fetch
  process.env.PACKAGEFLOW_DATA_DIR = work
  const ips = Array.from({ length: 8 }, (_, i) => `10.1.10.${50 + i}`)
  writeFileSync(join(work, 'ps4-service-keys.json'), JSON.stringify(Object.fromEntries(ips.map(ip => [ip, '01'.repeat(16)]))))
  const caps = [4194304, undefined, 999999999, 4194304, 4194304, 4194304, 4194304, 4194304]
  const calls = [], capCalls = []; let rejected = 0
  globalThis.fetch = async (url, init) => {
    const u = new URL(url), index = ips.indexOf(u.hostname)
    assert.ok(index >= 0); assert.equal(init.headers.Origin, undefined)
    if (u.pathname === '/files/capabilities') {
      capCalls.push(index)
      if (index === 7) return Response.json({ error: 'unauthorized' }, { status: 403 })
      return Response.json({ maxReadBytes: caps[index] })
    }
    const body = JSON.parse(init.body); calls.push({ index, ...body })
    assert.equal(u.pathname, '/files/read')
    if ((index === 3 && rejected++ < 2) || index === 4) return Response.json({ error: 'busy' }, { status: 503 })
    const size = index === 5 ? body.length + 1 : index === 6 ? 12 : body.length
    return new Response(Buffer.alloc(size, body.offset % 251), { headers: { 'content-type': 'application/octet-stream' } })
  }
  try {
    const bundle = join(work, 'api.mjs')
    await build({ entryPoints: [resolve('server/utils/ps4-service-installer.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const api = await import(bundle)
    assert.deepEqual(await Promise.all([api.consoleFileReadLimit(ips[0]), api.consoleFileReadLimit(ips[0])]), [4194304, 4194304])
    assert.equal(capCalls.filter(i => i === 0).length, 1)
    const large = await api.consoleFileRead(ips[0], '/data/test.bin', 123, 4194304)
    assert.equal(large.length, 4194304); assert.equal(calls.filter(c => c.index === 0).length, 1)
    assert.equal(await api.consoleFileReadLimit(ips[1]), 262144)
    assert.equal((await api.consoleFileRead(ips[1], '/data/test.bin', 0, 600000)).length, 600000)
    assert.deepEqual(calls.filter(c => c.index === 1).map(c => [c.offset, c.length]), [[0, 262144], [262144, 262144], [524288, 75712]])
    assert.equal(await api.consoleFileReadLimit(ips[2]), 4194304)
    assert.equal((await api.consoleFileRead(ips[3], '/data/test.bin', 77, 4194304)).length, 4194304)
    assert.deepEqual(calls.filter(c => c.index === 3).map(c => c.offset), [77, 77, 77])
    await assert.rejects(api.consoleFileRead(ips[4], '/data/test.bin', 0, 10), e => e.statusCode === 503)
    assert.equal(calls.filter(c => c.index === 4).length, 3)
    await assert.rejects(api.consoleFileRead(ips[5], '/data/test.bin', 0, 10), /слишком много/)
    assert.equal((await api.consoleFileRead(ips[6], '/data/test.bin', 0, 4194304)).length, 12)
    await assert.rejects(api.consoleFileReadLimit(ips[7]), e => e.statusCode === 403)
    await assert.rejects(api.consoleFileRead(ips[0], '/data/test.bin', 0, 4194305), e => e.statusCode === 400)
    await assert.rejects(api.consoleFileRead(ips[0], '/data/test.bin', Number.MAX_SAFE_INTEGER, 1), e => e.statusCode === 400)
  } finally {
    globalThis.fetch = oldFetch
    if (oldDir === undefined) delete process.env.PACKAGEFLOW_DATA_DIR; else process.env.PACKAGEFLOW_DATA_DIR = oldDir
    rmSync(work, { recursive: true, force: true })
  }
})
