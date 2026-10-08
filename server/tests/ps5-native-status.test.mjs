import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createError } from 'h3'

test('native status refreshes an expired console without a WEB tab and coalesces probes', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-native-status-'))
  const previousData = process.env.PACKAGEFLOW_DATA_DIR, previousNow = Date.now
  const names = ['fetch', 'createError', 'defineEventHandler', 'getQuery', 'setHeader']
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]))
  let time = previousNow(), consoleId, healthy = true, healthReads = 0
  process.env.PACKAGEFLOW_DATA_DIR = join(work, 'data'); mkdirSync(process.env.PACKAGEFLOW_DATA_DIR)
  Date.now = () => time
  globalThis.createError = createError
  globalThis.defineEventHandler = handler => handler
  globalThis.getQuery = () => ({ consoleId })
  globalThis.setHeader = () => {}
  try {
    const bundle = join(work, 'integration.mjs')
    await build({ stdin: { contents: `export { default as status } from './server/api/catalog/v2/status.get'; export * from './server/utils/console-profiles';`, resolveDir: resolve('.') }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const api = await import(pathToFileURL(bundle).href)
    const profile = api.saveConsoleProfile({ name: 'PS5', ip: '192.168.1.5', platform: 'ps5' }).consoles[0]
    consoleId = profile.id
    globalThis.fetch = async (url, options) => {
      if (!healthy) throw new Error('Disconnected test console')
      const path = new URL(url).pathname
      const response = body => new Response(JSON.stringify(body))
      if (path === '/health') { healthReads++; return response({ apiVersion: 'v1', firmwareRead: true, firmwareRaw: '0x13600007', serviceReport: { service: 'PackageFlowService-PS5', platform: 'ps5', consoleVerified: true, version: '0.1.3-dev' } }) }
      if (path === '/api/v1/pair') return response({ apiVersion: 'v1', token: 'b'.repeat(64) })
      assert.equal(options.headers.Authorization, `Bearer ${'b'.repeat(64)}`)
      if (path === '/api/v1/system') return response({ service: 'PackageFlowService-PS5', storageRead: true, freeBytes: 8000000, totalBytes: 10000000 })
      return response({ service: 'PackageFlowService-PS5', capabilities: { installPs4Pkg: false, installPs5Content: false } })
    }
    await api.pairConsoleProfile(profile.id, '123456', 'http://192.168.1.2:3000')
    time += 61000
    assert.equal(api.getConsoleProfiles().consoles[0].online, false)
    const before = healthReads
    const results = await Promise.all(Array.from({ length: 8 }, () => api.status({})))
    assert.ok(results.every(result => result.online && result.paired && result.firmware === '13.60'))
    assert.equal(healthReads, before + 1, 'simultaneous native polls share one console probe')
    await api.status({}); assert.equal(healthReads, before + 1, 'fresh snapshot avoids network traffic')
    healthy = false; time += 16000
    assert.equal((await api.status({})).online, false, 'a disconnected console is not kept online')
  } finally {
    Date.now = previousNow
    for (const name of names) { if (previous[name] === undefined) delete globalThis[name]; else globalThis[name] = previous[name] }
    if (previousData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR; else process.env.PACKAGEFLOW_DATA_DIR = previousData
    rmSync(work, { recursive: true, force: true })
  }
})
