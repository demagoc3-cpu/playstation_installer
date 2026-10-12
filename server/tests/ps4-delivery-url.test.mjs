import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import * as h3 from 'h3'
import { build } from 'esbuild'

test('PS4 suffix URLs serve real manifest/HEAD/ranges and preserve recipient isolation', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-ps4-suffix-'))
  const previous = process.env.PACKAGEFLOW_DATA_DIR
  const globals = new Map(Object.keys(h3).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  process.env.PACKAGEFLOW_DATA_DIR = join(work, 'data'); mkdirSync(process.env.PACKAGEFLOW_DATA_DIR)
  Object.assign(globalThis, h3)
  let server
  try {
    const bytes = Buffer.alloc(2 * 1024 * 1024); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
    const source = join(work, 'Own test.pkg'); writeFileSync(source, bytes)
    const base = { id: 'own', platform: 'ps4', format: 'pkg', title: 'Own test', titleId: 'CUSA95001', contentId: 'IV0000-CUSA95001_00-PACKAGEFLOWUI001', contentType: 'PS4GD', size: bytes.length, type: 'Игра', fileName: 'Own test.pkg', path: source, packageDigest: 'AB'.repeat(32), iconSize: 0, icon: { offset: 0, size: 0 } }
    writeFileSync(join(process.env.PACKAGEFLOW_DATA_DIR, 'package-library.json'), JSON.stringify({ version: 2, packages: [base, { ...base, id: 'ps5', platform: 'ps5' }], deliveries: {} }))
    // Selecting PS5 in the browser must not change PS4 callback ownership.
    writeFileSync(join(process.env.PACKAGEFLOW_DATA_DIR, 'console-profiles.json'), JSON.stringify({ activeId: 'five', consoles: [{ id: 'five', ip: '192.168.0.127', platform: 'ps5' }] }))
    const bundle = join(work, 'routes.mjs')
    await build({ stdin: { contents: `export {default as manifest} from './server/routes/ps4/manifest/[console]/[id].json'; export {default as download} from './server/routes/ps4/package/[console]/[id].pkg'; export {default as legacy} from './server/routes/json/[id].json'; export {inConsoleScope} from './server/utils/console-scope'; export {getPackageDelivery,blockPackageDelivery,recordPackageDelivery,resetPackageDelivery} from './server/utils/package-library'`, resolveDir: resolve('.') }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const api = await import(pathToFileURL(bundle).href)
    const app = h3.createApp()
    app.use('/ps4/manifest', api.manifest); app.use('/ps4/package', api.download); app.use('/json', api.legacy)
    server = createServer(h3.toNodeListener(app)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const manifestUrl = `${origin}/ps4/manifest/10.1.10.32/own.json`
    const response = await fetch(manifestUrl); assert.equal(response.status, 200)
    const manifest = await response.json(); assert.equal(manifest.packageDigest, base.packageDigest); assert.equal(manifest.originalFileSize, bytes.length)
    const url = manifest.pieces[0].url
    assert.equal(url, `${origin}/ps4/package/10.1.10.32/own.pkg`); assert.ok(url.endsWith('.pkg')); assert.ok(manifestUrl.endsWith('.json'))
    const head = await fetch(url, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(bytes.length)); assert.equal((await head.arrayBuffer()).byteLength, 0)
    assert.equal(api.inConsoleScope('10.1.10.32', () => api.getPackageDelivery('own')).bytesSent, 0, 'HEAD does not stream or count file bytes')
    for (const [range, start, end] of [['bytes=0-15', 0, 15], ['bytes=4000-4095', 4000, 4095], ['bytes=1048500-1049000',1048500,1049000], ['bytes=-16', bytes.length-16, bytes.length-1]]) {
      const res = await fetch(url, { headers: { Range: range } }); assert.equal(res.status, 206); assert.equal(res.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`)
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes.subarray(start, end + 1))
    }
    assert.equal(api.inConsoleScope('192.168.0.127', () => api.getPackageDelivery('own')).bytesSent, 0, 'active PS5 receives no PS4 progress')
    const invalid = await fetch(url, { headers: { Range: 'bytes=3000000-' } }); assert.equal(invalid.status, 416); assert.equal(invalid.headers.get('content-range'), `bytes */${bytes.length}`)
    api.inConsoleScope('10.1.10.32', () => api.blockPackageDelivery('own'))
    assert.equal((await fetch(manifestUrl)).status, 410); assert.equal((await fetch(url)).status, 410)
    assert.equal((await fetch(`${url}?console=10.1.10.33`)).status, 410, 'path recipient cannot be overridden by query')
    const other = await fetch(`${origin}/ps4/package/10.1.10.33/own.pkg`); assert.equal(other.status, 200); assert.deepEqual(Buffer.from(await other.arrayBuffer()), bytes)
    await new Promise(resolve=>setTimeout(resolve,20))
    assert.equal(api.inConsoleScope('10.1.10.33',()=>api.getPackageDelivery('own')).bytesSent,bytes.length,'Final socket progress must remain owned by the concrete recipient')
    assert.equal(api.getPackageDelivery('own').bytesSent,0,'Socket callbacks must not create legacy progress outside the recipient scope')
    const clock=Date.now
    try {
      let now=clock();Date.now=()=>now
      api.inConsoleScope('10.1.10.34',()=>{api.resetPackageDelivery('own');api.recordPackageDelivery('own',0,65535,false)})
      now+=31000
      assert.equal(api.inConsoleScope('10.1.10.34',()=>api.getPackageDelivery('own')).partial,true,'A quiet header probe is only a partial transfer')
      api.inConsoleScope('10.1.10.34',()=>api.recordPackageDelivery('own',65536,bytes.length-1,true))
      const complete=api.inConsoleScope('10.1.10.34',()=>api.getPackageDelivery('own'))
      assert.equal(complete.bytesSent,bytes.length)
      assert.equal(complete.partial,undefined,'Late BGFT body must replace the provisional partial result')
    } finally { Date.now=clock }
    assert.equal((await fetch(`${origin}/ps4/manifest/10.1.10.33/ps5.json`)).status, 400)
    assert.equal((await fetch(`${origin}/ps4/package/10.1.10.33/ps5.pkg`)).status, 400)
    const legacy = await fetch(`${origin}/json/own.json?console=10.1.10.33`); assert.equal(legacy.status, 200); assert.equal((await legacy.json()).pieces[0].url, `${origin}/ps4/package/10.1.10.33/own.pkg`)
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
    if (previous === undefined) delete process.env.PACKAGEFLOW_DATA_DIR; else process.env.PACKAGEFLOW_DATA_DIR = previous
    rmSync(work, { recursive: true, force: true })
  }
})
