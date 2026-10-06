import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { build } from 'esbuild'

test('Torznab PS4 category, saved credentials, XML links and upstream failures', async () => {
  const repo = process.cwd(), directory = mkdtempSync(resolve(tmpdir(), 'pf-search-'))
  const bundle = resolve(repo, 'node_modules/.cache/search-providers-test.mjs')
  await build({ entryPoints: [resolve(repo, 'server/utils/search-providers.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  const previousFetch = globalThis.fetch
  process.chdir(directory); mkdirSync('.data')
  writeFileSync('.data/search-providers.json', JSON.stringify({ name: 'RuTracker', endpoint: 'http://127.0.0.1:9696/2/api', apiKey: 'private-test-key' }))
  const rss = `<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><item>
    <title>[PS4] Little Nightmares 2 [EUR]</title><size>3800236032</size>
    <enclosure length='3800236032' url='http://127.0.0.1:9696/2/download?id=1&amp;apikey=test-key' />
    <torznab:attr value='12' name='seeders'/></item></channel></rss>`
  let request, body = rss, status = 200
  globalThis.fetch = async url => { request = new URL(url); return new Response(body, { status }) }
  try {
    const source = await import(bundle)
    const publicSettings = source.getSearchSettings()
    assert.equal(publicSettings.categories, '1180')
    assert.equal(publicSettings.hasApiKey, true)
    assert.ok(!JSON.stringify(publicSettings).includes('private-test-key'))
    const results = await source.searchPackages(' Little Nightmares 2 ')
    assert.equal(request.pathname, '/2/api')
    assert.equal(request.searchParams.get('cat'), '1180')
    assert.equal(request.searchParams.get('extended'), '1')
    assert.equal(request.searchParams.get('q'), 'Little Nightmares 2')
    assert.equal(request.searchParams.get('apikey'), 'private-test-key')
    assert.equal(results.length, 1)
    assert.equal(results[0].title, '[PS4] Little Nightmares 2 [EUR]')
    assert.equal(results[0].size, 3800236032)
    assert.equal(results[0].seeders, 12)
    assert.equal(results[0].displayTitle, 'Little Nightmares 2')
    assert.ok(results[0].source.includes('&apikey=test-key'))
    assert.ok(!results[0].source.includes('&amp;'))

    source.saveSearchSettings({ name: 'Changed', apiKey: '', categories: '1180,1000' })
    assert.equal(JSON.parse(readFileSync('.data/search-providers.json')).apiKey, 'private-test-key')
    await source.searchPackages('Example'); assert.equal(request.searchParams.get('cat'), '1180,1000')
    source.saveSearchSettings({ categories: '' })
    await source.searchPackages('Example'); assert.equal(request.searchParams.has('cat'), false)
    assert.throws(() => source.saveSearchSettings({ categories: '1180&apikey=bad' }), /Категории/)
    assert.throws(() => source.saveSearchSettings({ categories: 1180 }), /Неверные настройки/)

    const saved = source.saveSearchSettings({ endpoint: 'http://127.0.0.1:9696/2/api?cat=1180&apikey=url-private-key', apiKey: '' })
    assert.equal(saved.categories, '1180'); assert.equal(saved.hasApiKey, true)
    assert.ok(!saved.endpoint.includes('apikey'))
    assert.equal(JSON.parse(readFileSync('.data/search-providers.json')).apiKey, 'url-private-key')
    const magnetXml = `<rss xmlns:z="http://torznab.com/schemas/2015/feed"><channel><item><title><![CDATA[A &amp; B]]></title><z:attr value="magnet:?xt=urn:btih:abcd&amp;dn=Game" name="magneturl"/><enclosure url="https://example.test/fallback" length="-2"/></item></channel></rss>`
    const magnet = source.parseTorznabResults(magnetXml)[0]
    assert.equal(magnet.title, 'A &amp; B') // CDATA is literal, not entity encoded.
    assert.equal(magnet.source, 'magnet:?xt=urn:btih:abcd&dn=Game')
    assert.equal(magnet.size, 0)
    const full = source.parseTorznabResults(`<rss><item><title>[PS4] Game [1.05]</title><guid>https://rutracker.org/forum/viewtopic.php?t=1</guid><prowlarrindexer id="2">RuTracker.org</prowlarrindexer><description><![CDATA[<p>Details</p><script>ignored</script>]]></description><category>1180</category><torznab:attr name="category" value="1180"/><link>https://example.test/download</link><torznab:attr name="seeders" value="0"/><torznab:attr name="peers" value="24"/><torznab:attr name="grabs" value="4707"/><torznab:attr name="coverurl" value="https://images.example.test/cover.jpg"/></item></rss>`)[0]
    assert.equal(full.sourcePage, 'https://rutracker.org/forum/viewtopic.php?t=1')
    assert.equal(full.indexer, 'RuTracker.org'); assert.deepEqual(full.categories, ['1180'])
    assert.equal(full.seeders, 0); assert.equal(full.leechers, 24); assert.equal(full.grabs, 4707)
    assert.equal(full.cover, 'https://images.example.test/cover.jpg'); assert.equal(full.description, 'Details')
    assert.equal(source.parseTorznabResults('<rss><channel><item><title>Game &#x26; Patch &apos;2&apos;</title><link>https://example.test/a?x=1&amp;y=2</link></item></channel></rss>')[0].title, "Game & Patch '2'")
    assert.throws(() => source.parseTorznabResults('<error code="100" description="Invalid API key private-test-key"/>'), error => error.statusCode === 502 && !error.message.includes('private-test-key'))
    assert.throws(() => source.parseTorznabResults('<html>Login</html>'), /неверный ответ/)
    assert.deepEqual(source.parseTorznabResults('<rss><channel/></rss>'), [])
    const item = '<item><title>Game</title><link>https://example.test/1</link></item>'
    assert.equal(source.parseTorznabResults(`<rss>${item.repeat(50)}</rss>`).length, 1)
    assert.equal(source.parseTorznabResults(`<rss>${Array.from({ length: 50 }, (_, i) => item.replace('/1', `/${i}`)).join('')}</rss>`).length, 50)

    // Raw upstream item counts determine offsets even when visible results are deduplicated.
    const firstPage = source.parseSearchPage(`<rss><torznab:response offset="0" total="125"/>${item.repeat(50)}</rss>`, 0, 50)
    assert.equal(firstPage.results.length, 1); assert.equal(firstPage.nextOffset, 50)
    assert.equal(firstPage.total, 125); assert.equal(firstPage.hasMore, true)
    const lastPage = source.parseSearchPage(`<rss><newznab:response offset='100' total='101'/>${item}</rss>`, 100, 50)
    assert.equal(lastPage.nextOffset, 101); assert.equal(lastPage.hasMore, false)
    // A provider may cap a page below our requested size without sending total.
    assert.equal(source.parseSearchPage(`<rss>${item}</rss>`, 0, 50).hasMore, true)
    assert.equal(source.parseSearchPage('<rss><channel/></rss>', 50, 50).hasMore, false)
    assert.equal(source.parseSearchPage(`<rss><z:response offset="0" total="100"/>${item}</rss>`, 50, 50).hasMore, false)
    body = `<rss><torznab:response offset="50" total="125"/>${item}</rss>`
    const page = await source.searchPackagePage('Example', 50, 50)
    assert.equal(request.searchParams.get('offset'), '50'); assert.equal(request.searchParams.get('limit'), '50')
    assert.equal(page.nextOffset, 51); assert.equal(page.hasMore, true); assert.ok(page.results[0].id)
    for (const [offset, limit] of [[-1, 50], [1.5, 50], [0, 101], [0, 0], [NaN, 50]]) await assert.rejects(source.searchPackagePage('Example', offset, limit), error => error.statusCode === 400)

    body = '<error code="100"/>'; await assert.rejects(source.searchPackages('Example'), /Torznab вернул ошибку/)
    body = '<html>Error</html>'; status = 503; await assert.rejects(source.searchPackages('Example'), /503/)
    globalThis.fetch = async () => { throw new Error('Network failed with private-test-key') }
    await assert.rejects(source.searchPackages('Example'), error => !error.message.includes('private-test-key') && error.statusCode === 502)
    // The timeout must cover reading the body, not only receiving headers.
    const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout
    let timerCleared = false
    try {
      globalThis.setTimeout = (_, milliseconds) => { assert.equal(milliseconds, 60000); return 123 }
      globalThis.clearTimeout = timer => { assert.equal(timer, 123); timerCleared = true }
      globalThis.fetch = async () => ({ ok: true, text: async () => { assert.equal(timerCleared, false); return rss } })
      await source.searchPackages('Example'); assert.equal(timerCleared, true)
    } finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear }
  } finally { globalThis.fetch = previousFetch; process.chdir(repo); rmSync(directory, { recursive: true, force: true }) }
})
