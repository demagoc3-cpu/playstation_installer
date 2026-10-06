import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'

test('packaged WEB startup, relocated settings and safe update drain', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'pf-desktop-runtime-'))
  const listener = createServer()
  await new Promise(done => listener.listen(0, '127.0.0.1', done))
  const port = listener.address().port
  await new Promise(done => listener.close(done))
  const child = spawn(process.execPath, [resolve('.output/server/index.mjs')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), PACKAGEFLOW_DATA_DIR: directory, PACKAGEFLOW_HOST_IP: '10.1.10.47', PACKAGEFLOW_LAUNCHER_KEY: 'fixture-launcher-key' }, stdio: 'ignore'
  })
  const request = (path, method = 'GET', body, authenticated = true) => fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(authenticated ? { 'X-PackageFlow-Launcher-Key': 'fixture-launcher-key' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000)
  })
  try {
    let ready = false
    for (let i = 0; i < 60; i++) {
      try { if ((await request('/api/desktop/status')).ok) { ready = true; break } } catch { }
      await new Promise(done => setTimeout(done, 100))
    }
    assert.ok(ready, 'Packaged WEB must start')
    assert.equal((await request('/api/desktop/status', 'GET', null, false)).status, 404)
    const status = await (await request('/api/desktop/status')).json()
    assert.equal(status.application, 'PackageFlow'); assert.equal(status.busy, false)
    assert.ok(!JSON.stringify(status).includes('fixture-launcher-key'))
    assert.equal((await request('/api/desktop/rebind', 'POST', {}, false)).status, 404)
    const address = await request('/api/desktop/rebind', 'POST', {})
    assert.equal(address.status, 200); assert.equal((await address.json()).configured, false)
    const settings = await request('/api/search/settings', 'POST', { endpoint: 'http://127.0.0.1:9696/2/api', apiKey: 'fixture-prowlarr-key', categories: '1180' })
    assert.ok(settings.ok)
    const saved = JSON.parse(readFileSync(resolve(directory, 'search-providers.json'), 'utf8'))
    assert.equal(saved.apiKey, 'fixture-prowlarr-key')
    assert.ok(!JSON.stringify(await settings.json()).includes('fixture-prowlarr-key'))
    writeFileSync(resolve(directory, 'installation-queue.json'), JSON.stringify({ status: 'running', items: [] }))
    const blocked = await (await request('/api/desktop/prepare-stop', 'POST', {})).json()
    assert.equal(blocked.busy, true)
    assert.equal((await request('/api/search/settings')).status, 200, 'Busy stop must restore WEB access')
    writeFileSync(resolve(directory, 'installation-queue.json'), JSON.stringify({ status: 'completed', items: [] }))
    const drain = await (await request('/api/desktop/prepare-stop', 'POST', {})).json()
    assert.equal(drain.busy, false)
    assert.equal((await request('/api/search/settings', 'POST', { categories: '1180' })).status, 503, 'New mutations must not race with replacement')
  } finally {
    child.kill('SIGTERM')
    await Promise.race([new Promise(done => child.once('exit', done)), new Promise(done => setTimeout(() => { child.kill('SIGKILL'); done() }, 2000))])
    rmSync(directory, { recursive: true, force: true })
  }
})
