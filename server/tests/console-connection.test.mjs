import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { createError } from 'h3'

test('native connection requires a bearer accepted by PS4, with no credential exposure', async () => {
  const repo = process.cwd(), folder = mkdtempSync(resolve(tmpdir(), 'pf-connection-'))
  const bundle = resolve(repo, 'node_modules/.cache/console-connection-test.mjs')
  await build({ entryPoints: [resolve(repo, 'server/api/catalog/v1/connection.get.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  const previous = globalThis.fetch, ip = '10.1.10.32'
  globalThis.defineEventHandler = fn => fn
  globalThis.setHeader = () => {}
  globalThis.getQuery = () => ({ ip })
  globalThis.createError = createError
  process.chdir(folder); mkdirSync('.data')
  let requests = 0, status = 200, offline = false
  globalThis.fetch = async (_, init) => {
    requests++
    assert.equal(init.headers.Authorization, 'Bearer 0123456789abcdef0123456789abcdef')
    if (offline) throw new Error('offline')
    return new Response(JSON.stringify(status === 200 ? { fileApi: 2 } : { error: 'service_key_required' }), { status })
  }
  try {
    const route = (await import(bundle)).default
    assert.deepEqual(await route({}), { paired: 0, online: 1 }); assert.equal(requests, 0)
    writeFileSync('.data/ps4-service-keys.json', JSON.stringify({ [ip]: '0123456789abcdef0123456789abcdef' }))
    assert.deepEqual(await route({}), { paired: 1, online: 1 })
    status = 401; assert.deepEqual(await route({}), { paired: 0, online: 1 })
    offline = true; assert.deepEqual(await route({}), { paired: 0, online: 0 })
  } finally { process.chdir(repo); globalThis.fetch = previous; rmSync(folder, { recursive: true, force: true }) }
})
