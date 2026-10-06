import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'

test('background descriptions stay on HTTP; opening one blocked card verifies once and reuses cookies', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'pf-details-http-'))
  const previousData = process.env.PACKAGEFLOW_DATA_DIR, previousFetch = globalThis.fetch
  process.env.PACKAGEFLOW_DATA_DIR = directory
  const bundle = resolve('node_modules/.cache/search-details-loading-test.mjs')
  const html = '<div class="post_body">Описание: A game description<img src="https://images.example.test/cover.jpg"></div>'
  const httpCalls = [], browserCalls = []
  const request = (url, options, callback) => {
    httpCalls.push({ url: url.toString(), headers: options.headers })
    const req = new EventEmitter()
    req.end = () => queueMicrotask(() => {
      const response = new EventEmitter(), accepted = options.headers.Cookie?.includes('cf_clearance=verified')
      response.statusCode = accepted ? 200 : 403
      response.headers = { 'content-type': 'text/html; charset=utf-8' }
      response.resume = () => {}
      callback(response)
      if (accepted) queueMicrotask(() => { response.emit('data', Buffer.from(html)); response.emit('end') })
    })
    return req
  }
  globalThis.pfDetailHttp = { request }
  globalThis.fetch = async (_endpoint, options) => {
    const value = JSON.parse(options.body); browserCalls.push(value)
    const response = value.cmd === 'sessions.list' ? { status: 'ok', sessions: [] }
      : value.cmd === 'sessions.create' ? { status: 'ok', session: value.session }
      : value.cmd === 'sessions.destroy' ? { status: 'ok' }
      : { status: 'ok', solution: { status: 200, url: value.url, response: html, userAgent: 'Verified Browser/1.0', cookies: [
        { name: 'cf_clearance', value: 'verified', domain: '.rutracker.org', path: '/', secure: true },
        { name: 'foreign', value: 'private', domain: '.other.test', path: '/', secure: true },
        { name: 'bad', value: 'unsafe\r\nvalue', domain: '.rutracker.org', path: '/', secure: true }
      ] } }
    return new Response(JSON.stringify(response))
  }
  await build({ entryPoints: ['server/utils/search-source.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', plugins: [{ name: 'public-http-fixture', setup(build) {
    build.onResolve({ filter: /^node:(?:https?|dns\/promises)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'node:dns/promises'
      ? "export async function lookup(){return [{address:'93.184.216.34',family:4}]}"
      : 'export default globalThis.pfDetailHttp' }))
  } }] })
  try {
    const source = await import(bundle)
    const register = (id, host = 'rutracker.org') => source.registerSearchResults([{ title: 'Game ' + id, source: 'magnet:?xt=urn:btih:' + id, sourcePage: `https://${host}/forum/viewtopic.php?t=${id}` }])[0]
    const first = register(1)
    assert.equal((await source.getSearchDetails(first.id)).status, 'unavailable')
    assert.equal(browserCalls.length, 0, 'Background prefetch must never open Chromium')
    assert.equal((await source.getSearchDetails(first.id, true)).status, 'available')
    assert.equal(browserCalls.filter(c => c.cmd === 'request.get').length, 1)
    assert.equal(browserCalls.filter(c => c.cmd === 'sessions.destroy').length, 1, 'Chromium must close after its cookies work over HTTP')
    assert.equal((await source.getSearchDetails(register(2).id)).status, 'available')
    assert.equal(browserCalls.filter(c => c.cmd === 'request.get').length, 1, 'Next card must reuse cookies over HTTP')
    assert.equal(httpCalls.at(-1).headers.Cookie, 'cf_clearance=verified')
    assert.equal(httpCalls.at(-1).headers['User-Agent'], 'Verified Browser/1.0')
    assert.equal((await source.getSearchDetails(register(3, 'rutracker.net').id)).status, 'unavailable')
    assert.equal(httpCalls.at(-1).headers.Cookie, undefined, 'Cookies must not cross origins')
    assert.equal(browserCalls.filter(c => c.cmd === 'request.get').length, 1)
  } finally {
    globalThis.fetch = previousFetch; delete globalThis.pfDetailHttp
    if (previousData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR; else process.env.PACKAGEFLOW_DATA_DIR = previousData
    rmSync(directory, { recursive: true, force: true })
  }
})
