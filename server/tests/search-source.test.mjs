import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { build } from 'esbuild'

test('release source parsing, metadata and public address boundaries', async () => {
  const parserPath = resolve('node_modules/.cache/search-source-parser-test.mjs')
  const sourcePath = resolve('node_modules/.cache/search-source-test.mjs')
  const titlePath = resolve('node_modules/.cache/search-title-test.mjs')
  const formatsPath = resolve('node_modules/.cache/search-formats-test.mjs')
  for (const [entry, outfile] of [['server/utils/search-source-parser.ts', parserPath], ['server/utils/search-source.ts', sourcePath], ['shared/search-metadata.ts', titlePath], ['shared/search-formats.ts', formatsPath]]) {
    await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  }
  const { parseSearchSource, publicWebUrl, htmlText } = await import(parserPath)
  const { isPublicAddress, isRuTrackerTopic, registerSearchResults, getSearchDetails } = await import(sourcePath)
  const { searchTitleMetadata } = await import(titlePath)
  const { searchReleaseFormats } = await import(formatsPath)
  const page = `<html><head><title>Release topic</title></head><body>
    <div class="post_body">Little Nightmares 2<br><img class="postImgAligned" src="https://images.example.test/cover.png">
    <b>Год выпуска</b>: 2021<br><b>Код диска</b>: CUSA12779<br><b>Язык интерфейса игры</b>: Russian, English<br>
    <b>Описание</b>: A &amp; B<script>alert('injected')</script><br>Second line
    <div class="sp-wrap"><div class="sp-head">Скриншоты</div><div class="sp-body">Hidden screenshots</div></div></div>
    <div class="post_body">Reply, not a description<img src="https://images.example.test/wrong.png"></div></body></html>`
  const details = parseSearchSource(page, 'https://rutracker.org/forum/viewtopic.php?t=6027023')
  assert.equal(details.status, 'available')
  assert.equal(details.cover, 'https://images.example.test/cover.png')
  assert.deepEqual(details.fields, [{ label: 'Год выпуска', value: '2021' }, { label: 'Код диска', value: 'CUSA12779' }, { label: 'Язык интерфейса игры', value: 'Russian, English' }])
  assert.ok(details.description.includes('A & B\nSecond line'))
  for (const unwanted of ['injected', '<b>', 'Reply, not', 'Hidden screenshots']) assert.ok(!details.description.includes(unwanted))
  assert.equal(htmlText('<img src=x onerror=alert(1)><p>Only text</p><iframe>ignore</iframe>'), 'Only text')
  assert.equal(publicWebUrl('', 'https://example.test/topic'), undefined)
  for (const url of ['javascript:alert(1)', 'data:image/png;base64,aaa', 'https://user:secret@example.test/a', 'https://example.test/a?apikey=secret']) assert.equal(publicWebUrl(url), undefined)
  assert.equal(publicWebUrl('/cover.jpg', 'https://example.test/topic'), 'https://example.test/cover.jpg')
  assert.equal(parseSearchSource('<title>Login</title><meta name="description" content="Sign in">', 'https://example.test').status, 'unavailable')
  assert.equal(parseSearchSource('<html><title>Topic</title></html>', 'https://example.test').status, 'unavailable')
  assert.equal(parseSearchSource('<meta property="og:image" content="https://example.test/cover.jpg"><meta property="og:description" content="Game">', 'https://example.test').cover, 'https://example.test/cover.jpg')
  const metadata = searchTitleMetadata('[PS4] Little Nightmares 2 [EUR] [MULTI+RUS] [1.05] + Backport [5.05/6.72/7.02]', ['1180'])
  assert.deepEqual(metadata, { displayTitle: 'Little Nightmares 2', platform: 'PS4', formats: ['pkg'], titleId: undefined, version: '1.05', region: 'EUR', languages: ['Русский', 'Мультиязычная'], firmwareVersions: ['5.05', '6.72', '7.02'], backport: true })
  assert.equal(searchTitleMetadata('Unknown game').version, undefined)
  assert.equal(searchTitleMetadata('Game 2021').platform, undefined)
  assert.equal(searchTitleMetadata('Game CUSA12779 FW 9.00').titleId, 'CUSA12779')
  assert.deepEqual(searchTitleMetadata('Game CUSA12779 FW 9.00').firmwareVersions, ['9.00'])
  assert.deepEqual(searchTitleMetadata('Game', ['1180']).formats, ['pkg'], 'PS4 always has a PKG tag even without a title marker')
  assert.deepEqual(searchReleaseFormats('[PS5] Game [Folder]'), ['folder'])
  assert.deepEqual(searchReleaseFormats('[PS4] Game [Folder]', '', [], 'PS4'), ['pkg'])
  assert.deepEqual(searchReleaseFormats('[PS5] Game [FPKG]'), ['pkg'])
  assert.deepEqual(searchReleaseFormats('[PS5] Game.ufs2'), ['ufs2'])
  assert.deepEqual(searchReleaseFormats('[PS5] Game [FFPKG]'), ['ufs2'])
  assert.deepEqual(searchReleaseFormats('[PS5] Game [exFAT]'), ['exfat'])
  assert.deepEqual(searchReleaseFormats('[PS5] Game.ffpfs'), ['pfs'])
  assert.deepEqual(searchReleaseFormats('[PS5] Game [PFS / FFPFSC]'), ['pfs', 'ffpfsc'])
  assert.deepEqual(searchReleaseFormats('Game', 'Формат: PKG / Folder\nОписание: Game'), ['pkg', 'folder'])
  assert.deepEqual(searchReleaseFormats('Game', '', [{ label: 'Package format', value: 'UFS2' }]), ['ufs2'])
  assert.deepEqual(searchReleaseFormats('Game', 'Copy files to a folder; PKG installation instructions follow.', [{ label: 'Описание', value: 'A folder and a PKG' }]), [], 'Generic instructions must not turn into format tags')
  const formatDetails = parseSearchSource('<div class="post_body">Формат: Folder<br>Описание: A game</div>', 'https://example.test/topic')
  assert.equal(formatDetails.description, 'A game')
  assert.deepEqual(formatDetails.fields, [{ label: 'Формат', value: 'Folder' }])
  assert.deepEqual(searchReleaseFormats('Game', formatDetails.description, formatDetails.fields), ['folder'], 'Format survives extracting the synopsis')
  for (const ip of ['127.0.0.1', '10.1.10.32', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '2001:db8::1']) assert.equal(isPublicAddress(ip), false, ip)
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip)
  assert.equal(isRuTrackerTopic(new URL('https://rutracker.org/forum/viewtopic.php?t=6027023')), true)
  assert.equal(isRuTrackerTopic(new URL('https://rutracker.org.attacker.test/forum/viewtopic.php?t=6027023')), false)
  assert.equal(isRuTrackerTopic(new URL('https://rutracker.org/forum/login.php')), false)
  assert.equal(isRuTrackerTopic(new URL('http://rutracker.org:3000/forum/viewtopic.php?t=6027023')), false)
  assert.throws(() => getSearchDetails('https://127.0.0.1'), /Результат поиска устарел/)
  const [registered] = registerSearchResults([{ title: 'Private target', source: 'magnet:?xt=urn:btih:one', sourcePage: 'http://127.0.0.1:3000/private' }])
  const stable = registerSearchResults([{ title: 'Stable release', source: 'https://example.test/download?token=old', sourcePage: 'https://example.test/topic' }])[0]
  const refreshed = registerSearchResults([{ title: 'Stable release', source: 'https://example.test/download?token=new', sourcePage: 'https://example.test/topic' }])[0]
  assert.equal(stable.id, refreshed.id)
  const privateDetails = await getSearchDetails(registered.id)
  assert.equal(privateDetails.status, 'unavailable')
})
