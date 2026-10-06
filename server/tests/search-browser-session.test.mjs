import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { build } from 'esbuild'

test('source browser reuses a session, serializes navigation, recovers lost sessions, and closes', async () => {
  const bundle = resolve('node_modules/.cache/search-browser-session-test.mjs')
  await build({ entryPoints: ['server/utils/search-browser-session.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  const previousFetch = globalThis.fetch, sessions = new Set(), commands = []
  let busy = 0, highest = 0, lose = false, redirect = false, challenge = false, expired500 = false
  const json = value => new Response(JSON.stringify(value))
  globalThis.fetch = async (endpoint, options) => {
    const value = JSON.parse(options.body); commands.push({ endpoint, ...value })
    if (value.cmd === 'sessions.list') return json({ status: 'ok', sessions: [...sessions] })
    if (value.cmd === 'sessions.create') { sessions.add(value.session); return json({ status: 'ok', session: value.session }) }
    if (value.cmd === 'sessions.destroy') { sessions.delete(value.session); return json({ status: 'ok' }) }
    assert.ok(sessions.has(value.session)); busy++; highest = Math.max(highest, busy)
    await new Promise(resolve => setTimeout(resolve, 5)); busy--
    if (expired500) { expired500 = false; return new Response(JSON.stringify({ status: 'error', message: 'Error solving the challenge: invalid session id' }), { status: 500 }) }
    if (lose) { lose = false; sessions.delete(value.session); return json({ status: 'error', message: 'Session does not exist' }) }
    return json({ status: 'ok', solution: { status: 200, response: challenge ? '<html>_cf_chl_opt</html>' : '<html>Source<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></html>', url: redirect ? 'http://127.0.0.1/private' : value.url,
      userAgent: 'Verified Browser/1.0', cookies: [{ name: 'cf_clearance', value: 'verified', domain: '.rutracker.org', path: '/forum', secure: true }] } })
  }
  const browser = await import(bundle), endpoint = 'http://127.0.0.1:8191/v1', source = 'https://rutracker.org/forum/viewtopic.php?t=123'
  try {
    const pages = await Promise.all([browser.readBrowserPage(endpoint, source), browser.readBrowserPage(endpoint, source)])
    assert.equal(pages[0].html, '<html>Source<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></html>'); assert.equal(highest, 1)
    assert.equal(commands.filter(c => c.cmd === 'sessions.create').length, 1)
    assert.equal(browser.browserRequestHeaders(new URL(source)).Cookie, 'cf_clearance=verified')
    assert.equal(browser.browserRequestHeaders(new URL('https://rutracker.org/forum-other')).Cookie, undefined)
    assert.equal(browser.browserRequestHeaders(new URL('https://other.test/forum')).Cookie, undefined)
    assert.equal(browser.browserRequestHeaders(new URL('http://rutracker.org/forum')).Cookie, undefined)
    const restarted = await import(bundle + '?restart')
    await restarted.readBrowserPage(endpoint, source)
    assert.equal(commands.filter(c => c.cmd === 'sessions.create').length, 1)
    lose = true; await browser.readBrowserPage(endpoint, source)
    assert.equal(commands.filter(c => c.cmd === 'sessions.create').length, 2)
    expired500 = true; await browser.readBrowserPage(endpoint, source)
    assert.equal(commands.filter(c => c.cmd === 'sessions.create').length, 3, 'HTTP 500 invalid session must create a fresh browser')
    redirect = true; await assert.rejects(browser.readBrowserPage(endpoint, source), /Unexpected proxy redirect/)
    redirect = false; challenge = true
    await assert.rejects(browser.readBrowserPage(endpoint, source), /Browser verification incomplete/)
    await restarted.closeSearchBrowser(); await browser.closeSearchBrowser()
    assert.deepEqual(browser.browserRequestHeaders(new URL(source)), {})
    assert.equal(sessions.size, 0)
  } finally { await browser.closeSearchBrowser(); globalThis.fetch = previousFetch }
})
