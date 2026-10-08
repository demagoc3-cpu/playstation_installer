import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createError } from 'h3'

test('mixed library keeps platform, console installation and transfer state separate', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-console-platform-')), previous = process.env.PACKAGEFLOW_DATA_DIR
  const previousFetch = globalThis.fetch, previousError = globalThis.createError
  process.env.PACKAGEFLOW_DATA_DIR = join(work, 'data'); mkdirSync(process.env.PACKAGEFLOW_DATA_DIR)
  globalThis.createError = createError
  try {
    const bundle = join(work, 'integration.mjs')
    await build({ stdin: { contents: `export * from './server/utils/package-library'; export * from './server/utils/console-profiles'; export * from './server/utils/console-scope'; export * from './server/utils/ps5-content-metadata'; export * from './shared/content-platform'; export * from './shared/library-pagination'; export * from './server/utils/installation-queue'; export * from './server/utils/torrent-console'; export * from './server/utils/qbittorrent';`, resolveDir: resolve('.') }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const api = await import(pathToFileURL(bundle).href)
    const folder = join(work, 'a misleading CUSA12345 folder'), sys = join(folder, 'sce_sys')
    mkdirSync(sys, { recursive: true }); writeFileSync(join(folder, 'eboot.bin'), 'own test homebrew')
    const param = { titleId: 'PPSA95001', contentId: 'IV0000-PPSA95001_00-PACKAGEFLOWUI001', applicationCategoryType: 0, contentVersion: '01.000.001', localizedParameters: { defaultLanguage: 'ru-RU', 'ru-RU': { titleName: 'Тест PS5' } } }
    writeFileSync(join(sys, 'param.json'), JSON.stringify(param))
    const scanned = await api.scanPackageFolder(folder)
    assert.equal(scanned.packages[0].platform, 'ps5'); assert.equal(scanned.packages[0].format, 'folder'); assert.equal(scanned.packages[0].titleId, 'PPSA95001')
    await assert.rejects(api.readPs5ImageMetadata(join(folder, 'eboot.bin')), /limit|range|bounds|offset/i)
    assert.throws(() => api.ps5ParamMetadata(Buffer.from(JSON.stringify({ ...param, titleId: 'CUSA12345' }))), /Invalid PS5/)
    const ps4 = api.saveConsoleProfile({ name: 'PS4', ip: '192.168.1.4', platform: 'ps4' }).consoles[0]
    const ps5 = api.saveConsoleProfile({ name: 'PS5', ip: '192.168.1.5', platform: 'ps5' }).consoles[1]
    let installed = api.markPackageInstalled(scanned.packages[0].id, true, ps5.ip)
    assert.ok(installed.installedAt)
    assert.equal(api.getLibraryPackages(ps4.ip)[0].installedAt, undefined)
    assert.ok(api.getLibraryPackages(ps5.ip)[0].installedAt)
    const library = [{ ...scanned.packages[0], id: 'ps5' }, { ...scanned.packages[0], id: 'ps4', platform: 'ps4', format: 'pkg', contentType: 'PS4GD', installedAt: undefined }]
    assert.equal(api.filterContent(library, 'all', 'ps4').length, 1)
    assert.equal(api.filterContent(library, 'all', 'ps5').length, 2)
    assert.equal(api.paginateLibrary(library, { unit: 'games' }).summary.games, 2, 'same title ID cannot merge platforms')
    assert.equal(api.contentPlatform({ fileName: 'PS5 PPSA99999.pkg' }), 'unknown', 'filename cannot establish platform')
    await assert.rejects(async () => api.startInstallationQueue({ psIp: ps5.ip, packageIds: [installed.id], packageUrls: { [installed.id]: 'http://192.168.1.2:3000/a' }, transport: 'payload' }), /PS5/)
    await assert.rejects(async () => api.startInstallationQueue({ psIp: ps4.ip, packageIds: [installed.id], packageUrls: { [installed.id]: 'http://192.168.1.2:3000/a' }, transport: 'payload' }), /только пакеты PS4/)
    const aborted = []
    api.inConsoleScope(ps4.ip, () => { api.recordPackageRequest(installed.id); api.registerActiveTransfer(installed.id, () => aborted.push('ps4')) })
    const stop = api.inConsoleScope(ps5.ip, () => { api.recordPackageRequest(installed.id); return api.registerActiveTransfer(installed.id, () => aborted.push('ps5')) })
    api.inConsoleScope(ps4.ip, () => api.blockPackageDelivery(installed.id))
    assert.deepEqual(aborted, ['ps4']); assert.equal(api.inConsoleScope(ps5.ip, () => api.isDeliveryBlocked(installed.id)), false); stop()
    api.inConsoleScope(ps5.ip, () => api.recordPackageDelivery(installed.id, 0, installed.size - 1, true))
    assert.ok(api.inConsoleScope(ps5.ip, () => api.getDeliveredPackageIds().has(installed.id)))
    assert.equal(api.inConsoleScope(ps4.ip, () => api.getDeliveredPackageIds().has(installed.id)), false)
    const response = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
    const token = 'b'.repeat(64)
    globalThis.fetch = async (url, options) => {
      const path = new URL(url).pathname
      if (path === '/health') return response({ apiVersion: 'v1', firmwareRead: true, firmwareRaw: '0x13600007', serviceReport: { service: 'PackageFlowService-PS5', consoleVerified: true, version: '0.1' } })
      if (path === '/api/v1/pair') { assert.equal(options.headers['X-PackageFlow-Pairing-Code'], '123456'); return response({ apiVersion: 'v1', token }) }
      assert.equal(options.headers.Authorization, `Bearer ${token}`)
      return response({ service: 'PackageFlowService-PS5', capabilities: { filesystem: true, installPs4Pkg: false, installPs5Content: false } })
    }
    const paired = await api.pairConsoleProfile(ps5.id, '123456', 'http://192.168.1.2:3000')
    assert.equal(paired.consoles[1].paired, true); assert.equal(paired.consoles[1].firmware, '13.60'); assert.deepEqual(paired.consoles[1].capabilities.formats, [])
    assert.ok(!JSON.stringify(paired).includes(token)); assert.ok(readFileSync(join(process.env.PACKAGEFLOW_DATA_DIR, 'ps5-service-keys.json'), 'utf8').includes(token))
    globalThis.fetch = async () => response({ apiVersion: 'v1', serviceReport: { service: 'PackageFlowService-PS5', consoleVerified: false } })
    assert.equal((await api.probeConsoleProfile(ps5.id)).consoles[1].online, false, 'host stub cannot be a real console')
    api.selectConsoleProfile(ps5.id)
    await api.inConsoleScope(ps4.ip, async () => { await Promise.resolve(); assert.equal(api.currentConsoleIp(), ps4.ip); assert.equal(api.getInstallationQueue().psIp, undefined) })
    // Exercise real production workers concurrently. Finishing one console and
    // cancelling the other must not follow the active PS5 browser profile.
    const other = api.saveConsoleProfile({ name: 'Second PS4', ip: '192.168.1.6', platform: 'ps4' }).consoles[2]
    const indexPath = join(process.env.PACKAGEFLOW_DATA_DIR, 'package-library.json')
    const index = JSON.parse(readFileSync(indexPath, 'utf8'))
    index.packages.push({ ...index.packages[0], id: 'ps4-test', platform: 'ps4', format: 'pkg', signature: 'unknown', contentType: 'PS4GD', titleId: 'CUSA95001', contentId: 'IV0000-CUSA95001_00-PACKAGEFLOWUI001', requiredFirmware: '5.05', sdkFirmware: '5.05', size: 1024, coverPath: undefined, iconSize: 0, icon: { offset: 0, size: 0 } })
    writeFileSync(indexPath, JSON.stringify(index))
    const ps4Token = 'a'.repeat(32)
    writeFileSync(join(process.env.PACKAGEFLOW_DATA_DIR, 'ps4-service-keys.json'), JSON.stringify({ [ps4.ip]: ps4Token, [other.ip]: ps4Token }))
    const jobs = new Map(), posts = new Map(), cap = { service: 'PackegeFlowService', version: '0.4.0', installApi: 1, ready: true, authentication: 'bearer', contentTypes: ['PS4GD'], error: 0, errorHex: '0x00000000' }
    globalThis.fetch = async (url, options) => {
      const address = new URL(url), ip = address.hostname, path = address.pathname
      assert.ok([ps4.ip, other.ip].includes(ip), 'workers must never contact the active PS5')
      if (path === '/system/info') return response({ service: cap.service, firmware: { version: '12.50' } })
      if (path === '/storage') return response({ service: cap.service, volumes: [{ id: 'internal', path: '/user', available: true, availableBytes: 1000000000 }] })
      if (path === '/install/capabilities') return response(cap)
      assert.equal(options.headers.Authorization, `Bearer ${ps4Token}`)
      if (path === '/install/session') return response(cap)
      if (path === '/install/jobs' && options.method === 'POST') {
        const body = JSON.parse(options.body)
        assert.equal(new URL(body.url).searchParams.get('console'), ip)
        posts.set(ip, (posts.get(ip) || 0) + 1)
        const job = { service: cap.service, jobId: body.requestId, requestId: body.requestId, contentId: body.contentId, taskId: 43, state: 'downloading', totalBytes: 1024, downloadedBytes: 1, downloadTotalBytes: 1024, error: 0, errorHex: '0x00000000', pollError: 0 }
        jobs.set(ip, job); return response(job)
      }
      const job = jobs.get(ip)
      assert.ok(job && path.startsWith(`/install/jobs/${job.jobId}`))
      if (path.endsWith('/cancel')) job.state = 'cancelled'
      return response(job)
    }
    const until = async check => { const end = Date.now() + 6000; while (!check()) { assert.ok(Date.now() < end, 'two-console workers timed out'); await new Promise(resolve => setTimeout(resolve, 20)) } }
    const start = ip => api.startInstallationQueue({ psIp: ip, transport: 'service', packageIds: ['ps4-test'], packageUrls: { 'ps4-test': 'http://192.168.1.2:3000/json/ps4-test.json' } })
    start(ps4.ip); start(other.ip); api.selectConsoleProfile(ps5.id)
    await until(() => jobs.size === 2)
    jobs.get(ps4.ip).state = 'installed'
    api.cancelInstallationQueue(other.ip)
    await until(() => api.getInstallationQueue(ps4.ip).status === 'completed' && api.getInstallationQueue(other.ip).status === 'cancelled')
    assert.equal(posts.get(ps4.ip), 1); assert.equal(posts.get(other.ip), 1)
    assert.ok(api.getLibraryPackages(ps4.ip).find(item => item.id === 'ps4-test').installedAt)
    assert.equal(api.getLibraryPackages(other.ip).find(item => item.id === 'ps4-test').installedAt, undefined)
    assert.equal(api.getLibraryPackages(ps5.ip).find(item => item.id === 'ps4-test').installedAt, undefined)
    assert.throws(() => api.torrentInstallTarget(), /PS5/, 'active PS5 cannot silently enable PS4 automation')
    const capturedTarget = api.torrentInstallTarget(ps4.id)
    assert.equal(capturedTarget, ps4.ip)
    writeFileSync(join(process.env.PACKAGEFLOW_DATA_DIR, 'qbittorrent.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:8080', username: 'test', password: '', downloadPath: work, remotePath: '' }))
    const hash = 'c'.repeat(40); let tags = ''
    globalThis.fetch = async (url, options) => {
      const path = new URL(url).pathname
      if (path.endsWith('/auth/login')) return new Response('Ok.', { headers: { 'set-cookie': 'SID=test' } })
      if (path.endsWith('/torrents/add')) { tags = options.body.get('tags'); return new Response('Ok.') }
      if (path.endsWith('/torrents/info')) return response([{ hash, name: 'Test', tags, progress: 1, state: 'stoppedUP' }])
      if (path.endsWith('/torrents/removeTags')) tags = tags.split(',').filter(tag => !options.body.get('tags').split(',').includes(tag)).join(',')
      else if (path.endsWith('/torrents/addTags')) tags += `,${options.body.get('tags')}`
      else assert.fail(`unexpected qBittorrent route ${path}`)
      return new Response('')
    }
    await api.addTorrent(`magnet:?xt=urn:btih:${hash}`, true, capturedTarget)
    api.selectConsoleProfile(other.id)
    assert.equal((await api.getTorrents())[0].installIp, ps4.ip, 'completed torrent keeps its captured destination')
    await api.setTorrentAutoInstall(hash, true, other.ip)
    assert.equal((await api.getTorrents())[0].installIp, other.ip, 'explicit re-enable replaces the previous target')
    assert.ok(!tags.includes(`packageflow-target-${ps4.ip}`))
    writeFileSync(join(process.env.PACKAGEFLOW_DATA_DIR, 'console-profiles.json'), 'broken')
    assert.throws(api.getConsoleProfiles, /профили/)
    assert.equal(readFileSync(join(process.env.PACKAGEFLOW_DATA_DIR, 'console-profiles.json'), 'utf8'), 'broken')
  } finally {
    globalThis.fetch = previousFetch; globalThis.createError = previousError
    if (previous === undefined) delete process.env.PACKAGEFLOW_DATA_DIR; else process.env.PACKAGEFLOW_DATA_DIR = previous
    rmSync(work, { recursive: true, force: true })
  }
})

test('legacy installed marks stay with their original PS4 after the saved IP changes', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-console-migration-')), previous = process.env.PACKAGEFLOW_DATA_DIR
  const previousError = globalThis.createError
  process.env.PACKAGEFLOW_DATA_DIR = join(work, 'data'); mkdirSync(process.env.PACKAGEFLOW_DATA_DIR)
  globalThis.createError = createError
  try {
    const oldIp = '192.168.2.4', nextIp = '192.168.2.6', pkgPath = join(work, 'own-test.pkg')
    writeFileSync(pkgPath, Buffer.alloc(131072))
    writeFileSync(join(process.env.PACKAGEFLOW_DATA_DIR, 'ps4.json'), JSON.stringify({ ip: oldIp }))
    const stored = { id: 'legacy', title: 'Own Test', fileName: 'own-test.pkg', titleId: 'CUSA95001', contentId: 'IV0000-CUSA95001_00-PACKAGEFLOWUI001', contentType: 'PS4GD', size: 131072, type: 'Игра', installOrder: 0, packageDigest: '', iconSize: 0, icon: { offset: 0, size: 0 }, path: pkgPath, libraryRoot: work, sourceModifiedAt: 1, installedAt: 123 }
    writeFileSync(join(process.env.PACKAGEFLOW_DATA_DIR, 'package-library.json'), JSON.stringify({ version: 2, packages: [stored, { ...stored, id: 'image', platform: 'ps5', format: 'ufs2', contentType: 'PS5GD', installedAt: undefined }], deliveries: {} }))
    const bundle = join(work, 'migration.mjs')
    await build({ stdin: { contents: `export * from './server/utils/package-library'; export * from './server/utils/console-profiles'; export * from './server/utils/console-scope';`, resolveDir: resolve('.') }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const api = await import(pathToFileURL(bundle).href)
    assert.equal(api.getConsoleProfiles().consoles.length, 1)
    api.saveConsoleProfile({ name: 'New PS4', ip: nextIp, platform: 'ps4' })
    writeFileSync(join(process.env.PACKAGEFLOW_DATA_DIR, 'ps4.json'), JSON.stringify({ ip: nextIp }))
    assert.equal(api.legacyConsoleIp(), oldIp)
    assert.equal(api.getLibraryPackages(oldIp).find(item => item.id === 'legacy').installedAt, 123)
    assert.equal(api.getLibraryPackages(nextIp).find(item => item.id === 'legacy').installedAt, undefined)
    api.markPackageInstalled('legacy', true, nextIp)
    assert.equal(api.getLibraryPackages(oldIp).find(item => item.id === 'legacy').installedAt, 123)
    assert.ok(api.getLibraryPackages(nextIp).find(item => item.id === 'legacy').installedAt)
    api.inConsoleScope(nextIp, () => {
      api.recordPackageDelivery('image', 65536, 131071, true)
      assert.equal(api.getPackageDelivery('image').completedAt, undefined, 'PS5 image requires its header as well as the tail')
      api.recordPackageDelivery('image', 0, 65535, true)
      assert.ok(api.getPackageDelivery('image').completedAt)
    })
  } finally {
    globalThis.createError = previousError
    if (previous === undefined) delete process.env.PACKAGEFLOW_DATA_DIR; else process.env.PACKAGEFLOW_DATA_DIR = previous
    rmSync(work, { recursive: true, force: true })
  }
})
