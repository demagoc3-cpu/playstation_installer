import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { build } from 'esbuild'

test('durable descriptions survive restart, coalesce loads, expire, and recover from bad cache', async () => {
  const repo = process.cwd(), directory = mkdtempSync(resolve(tmpdir(), 'pf-search-cache-'))
  const bundle = resolve(repo, 'node_modules/.cache/search-details-cache-test.mjs')
  await build({ entryPoints: [resolve(repo, 'server/utils/search-details-cache.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  process.chdir(directory)
  const originalNow = Date.now
  try {
    const cache = await import(bundle), topic = 'https://rutracker.org/forum/viewtopic.php?t=123'
    const value = { status: 'available', description: 'Release description', cover: 'https://example.test/cover.jpg', fields: [{ label: 'Год выпуска', value: '2024' }] }
    let calls = 0, release
    const loader = async () => { calls++; await new Promise(resolve => { release = resolve }); return value }
    const first = cache.cachedSearchDetails(topic, loader), concurrent = cache.cachedSearchDetails(`${topic}&tracking=1`, loader)
    while (!release) await new Promise(resolve => setTimeout(resolve, 1))
    release()
    assert.deepEqual(await first, value); assert.deepEqual(await concurrent, value); assert.equal(calls, 1)
    const restarted = await import(bundle + '?restart')
    assert.deepEqual(await restarted.cachedSearchDetails(topic, async () => { throw new Error('Must read disk') }), value)
    const path = resolve('.data/search-details-cache', `${cache.detailsCacheKey(topic)}.json`)
    const stored = readFileSync(path, 'utf8')
    assert.ok(!stored.includes('tracking')); assert.ok(!stored.includes('seeders')); assert.equal(readdirSync('.data/search-details-cache').length, 1)
    const saved = JSON.parse(stored); saved.expires = Date.now() - 1; writeFileSync(path, JSON.stringify(saved))
    const updated = { ...value, description: 'Updated release' }
    assert.deepEqual(await cache.cachedSearchDetails(topic, async () => { calls++; return updated }), updated)
    assert.equal(calls, 2)
    writeFileSync(path, '{broken')
    assert.deepEqual(await cache.cachedSearchDetails(topic, async () => { calls++; return value }), value)
    writeFileSync(path, JSON.stringify({ version: 1, expires: Date.now() + 1000, details: { ...value, cover: 'javascript:alert(1)' } }))
    await cache.cachedSearchDetails(topic, async () => { calls++; return value }); assert.equal(calls, 4)
    Date.now = () => originalNow() + 2 * 24 * 60 * 60 * 1000
    await cache.cachedSearchDetails(topic, async () => { calls++; return value }); assert.equal(calls, 5)
    Date.now = originalNow
    let failed = 0
    const unavailable = async () => { failed++; return { status: 'unavailable', fields: [] } }
    await cache.cachedSearchDetails('https://example.test/missing', unavailable)
    await cache.cachedSearchDetails('https://example.test/missing', unavailable)
    assert.equal(failed, 2)
    assert.equal(cache.detailsCacheKey('https://example.test/topic?apikey=secret'), undefined)
    const mixedTopic = 'https://example.test/mixed'
    let finishBackground
    const background = cache.cachedSearchDetails(mixedTopic, () => new Promise(resolve => { finishBackground = resolve }), 'http')
    while (!finishBackground) await new Promise(resolve => setTimeout(resolve, 1))
    const interactive = await cache.cachedSearchDetails(mixedTopic, async () => value, 'browser')
    assert.deepEqual(interactive, value, 'Interactive loading must not inherit a failed background HTTP request')
    finishBackground({ status: 'unavailable', fields: [] })
    assert.equal((await background).status, 'unavailable')
    assert.equal(cache.detailsCacheKey('https://example.test/?b=2&a=1#fragment'), cache.detailsCacheKey('https://example.test/?a=1&b=2'))
  } finally { Date.now = originalNow; process.chdir(repo); rmSync(directory, { recursive: true, force: true }) }
})
