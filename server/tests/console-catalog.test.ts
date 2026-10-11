import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildConsoleCatalog } from '../utils/console-catalog.ts'
import type { LocalPackage } from '../utils/package-library.ts'

const pkg = (values: Partial<LocalPackage>) => ({
  id: 'base', title: 'Test game', titleId: 'CUSA00001', fileName: 'Base.pkg',
  type: 'Игра', installOrder: 0, size: 6_600_000_000, iconSize: 0,
  libraryRoot: '/private/library', path: '/private/library/Base.pkg',
  contentId: 'test', contentType: 'PS4GD', packageDigest: 'digest', ...values,
} as LocalPackage)

test('console catalog groups packages and orders the base before its patch', () => {
  const result = buildConsoleCatalog([
    pkg({ id: 'patch', title: 'Patch name', fileName: 'Patch.pkg', type: 'Патч', installOrder: 1, iconSize: 10, appVersion: '01.20', requiredFirmware: '09.00' }),
    pkg({}),
  ])
  assert.equal(result.games.length, 1)
  assert.equal(result.games[0]!.title, 'Test game')
  assert.deepEqual(result.games[0]!.packages.map(p => p.kind), ['game', 'patch'])
  assert.equal(result.games[0]!.packages[0]!.size, 6_600_000_000)
  assert.equal(result.games[0]!.packages[1]!.firmware, '09.00')
  assert.equal(result.games[0]!.cover, '/api/packages/patch?asset=icon')
  assert.equal(result.games[0]!.size, 13_200_000_000, 'table shows the complete branch size')
})

test('saved favorite aliases and different CUSA case resolve the whole branch while stale entries are skipped', () => {
  const library = [pkg({ sourceIds: ['old-base'] }), pkg({ id: 'dlc', type: 'DLC', installOrder: 2 }), pkg({ id: 'other', titleId: 'CUSA00002' })]
  for (const id of ['old-base', 'cusa00001']) {
    const result = buildConsoleCatalog(library, 'ru', { favoriteIds: [id, 'removed-game'] })
    assert.equal(result.total, 1)
    assert.deepEqual(result.games[0]!.packages.map(item => item.id), ['base', 'dlc'])
  }
})

test('catalog advertises service installation without local downloads or private paths', () => {
  const result = buildConsoleCatalog([pkg({})])
  assert.deepEqual(result.capabilities, { download: false, install: true, localTorrent: false })
  assert.equal(result.mode, 'web-library')
  assert.equal(result.games[0]!.packages[0]!.magnet, null)
  const json = JSON.stringify(result)
  for (const field of ['libraryRoot', 'path', 'token', 'digest', '/private']) assert.ok(!json.includes(field))
  assert.notEqual(result.games[0]!.description, buildConsoleCatalog([pkg({})], 'en').games[0]!.description)
})

test('catalog bounds match the native client and missing covers remain explicit', () => {
  const source = Array.from({ length: 30 }, (_, group) => Array.from({ length: 20 }, (_, item) => pkg({ id: `${group}-${item}`, titleId: `CUSA${group}`, iconSize: 0 }))).flat()
  const result = buildConsoleCatalog(source)
  assert.equal(result.games.length, 24)
  assert.equal(result.games[0]!.packages.length, 20)
  assert.equal(result.games[0]!.packageCount, 20)
  assert.equal(result.games[0]!.cover, '')
})

test('labels keep filenames separately and count patches/backports and DLC without cached install filtering', () => {
  const result = buildConsoleCatalog([pkg({installedAt:100}), pkg({id:'patch',type:'Патч',appVersion:'01.20',installOrder:1,fileName:'EP0000-CUSA00001_LONG_RUS.pkg'}), pkg({id:'bp',type:'Бэкпорт',installOrder:1}),pkg({id:'dlc',type:'DLC',title:'Costume pack',installOrder:2})])
  const game = result.games[0]!
  assert.equal(game.patchCount,2);assert.equal(game.dlcCount,1);assert.equal(game.packages.length,4)
  assert.equal(game.packages.find(p=>p.id==='patch')!.fileName,'EP0000-CUSA00001_LONG_RUS.pkg')
  assert.match(game.packages.find(p=>p.id==='patch')!.title,/Патч 01.20.*Русификация/)
  assert.equal(game.packages.find(p=>p.id==='dlc')!.title,'Costume pack')
})

test('native pages cover all 2800 packages without duplicates and search includes off-page packages', () => {
  const source = Array.from({ length: 700 }, (_, group) => Array.from({ length: 4 }, (_, item) => pkg({
    id: `pkg-${group}-${item}`, titleId: `CUSA${String(group).padStart(5, '0')}`,
    title: item ? 'Extra content' : `Game ${group}`, type: item ? 'DLC' : 'Игра', installOrder: item ? 2 : 0,
    fileName: `release-${group}-${item}.pkg`, contentId: `CONTENT-${group}-${item}`,
  }))).flat()
  const ids: string[] = []
  for (let offset = 0; offset < 700; offset += 20) {
    const page = buildConsoleCatalog(source, 'ru', { offset, limit: 20 })
    assert.equal(page.games.length, 20)
    assert.equal(page.total, 700)
    assert.equal(page.totalPackages, 2800)
    assert.equal(page.nextOffset, offset + 20)
    assert.equal(page.hasMore, offset + 20 < 700)
    ids.push(...page.games.flatMap(game => game.packages.map(item => item.id)))
  }
  assert.equal(ids.length, 2800)
  assert.equal(new Set(ids).size, 2800)
  const found = buildConsoleCatalog(source, 'ru', { q: 'CONTENT-699-3', limit: 20 })
  assert.equal(found.total, 1)
  assert.equal(found.games[0]!.title, 'Game 699')
  assert.equal(found.games[0]!.packages.length, 4, 'a matching DLC keeps its full game branch')
  const favorites = buildConsoleCatalog(source, 'ru', { favoriteIds: ['CUSA00699', 'CUSA00400'], limit: 20 })
  assert.deepEqual(favorites.games.map(game => game.id), ['CUSA00400', 'CUSA00699'])
  assert.equal(buildConsoleCatalog(source, 'ru', { favoriteIds: [] }).total, 0)
  assert.equal(buildConsoleCatalog(source, 'ru', { q: 'no matches' }).total, 0)
  assert.equal(buildConsoleCatalog(source, 'ru', { offset: 9999, limit: 20 }).offset, 680)
  assert.equal(buildConsoleCatalog(source, 'ru', { offset: -1, limit: 999 }).games.length, 30)
})

 test('native density choices return the requested 10, 20 or 30 cards',()=>{
 const source=Array.from({length:73},(_,i)=>pkg({id:`game-${i}`,titleId:`CUSA${String(i).padStart(5,'0')}`}))
 for(const limit of [10,20,30]){const first=buildConsoleCatalog(source,'ru',{limit}),next=buildConsoleCatalog(source,'ru',{limit,offset:limit});assert.equal(first.games.length,limit);assert.equal(next.games.length,limit);assert.equal(new Set([...first.games,...next.games].map(g=>g.id)).size,limit*2);assert.equal(next.offset,limit)}
 })

test('v2 favorites and branches keep PS4 and PS5 separate', () => {
  const source = [pkg({ id: 'ps4', platform: 'ps4', format: 'pkg', titleId: 'SAME00001' }),
    pkg({ id: 'ps5', platform: 'ps5', format: 'folder', titleId: 'SAME00001', contentType: 'PS5GD' })]
  const all = buildConsoleCatalog(source, 'ru', { groupByPlatform: true })
  assert.equal(all.total, 2)
  assert.deepEqual(buildConsoleCatalog(source, 'ru', { groupByPlatform: true, favoriteIds: ['ps5:SAME00001'] }).games.map(game => game.id), ['ps5:SAME00001'])
  assert.deepEqual(buildConsoleCatalog(source, 'ru', { groupByPlatform: true, favoriteIds: ['ps4'] }).games.map(game => game.id), ['ps4:SAME00001'])
})

test('global size ordering uses the base, before pagination, and leaves set totals intact', () => {
  const source = Array.from({ length: 61 }, (_, i) => [
    pkg({ id: `base-${i}`, titleId: `PPSA${String(i).padStart(5, '0')}`, title: `Game ${i}`, size: (i + 1) * 5_000_000_000 }),
    pkg({ id: `patch-${i}`, titleId: `PPSA${String(i).padStart(5, '0')}`, type: 'Патч', installOrder: 1, size: (61 - i) * 500_000_000_000 }),
  ]).flat().reverse()
  const seen: string[] = []
  for (let offset = 0; offset < 61; offset += 20) {
    const page = buildConsoleCatalog(source, 'ru', { sort: 'size-desc', limit: 20, offset })
    seen.push(...page.games.map(game => game.title))
  }
  assert.deepEqual(seen, Array.from({ length: 61 }, (_, i) => `Game ${60 - i}`))
  const first = buildConsoleCatalog(source, 'ru', { sort: 'size-asc', limit: 10 }).games[0]!
  assert.equal(first.baseSize, 5_000_000_000)
  assert.equal(first.size, 5_000_000_000 + 61 * 500_000_000_000)
  assert.equal(buildConsoleCatalog(source, 'ru', { sort: 'title-desc' }).games[0]!.title, 'Game 60')
  assert.equal(buildConsoleCatalog(source, 'ru', { sort: 'invalid' }).games[0]!.title, 'Game 0')
})

test('base variants sort deterministically and a patch-only branch has no base size', () => {
  const source = [pkg({ id: 'z', fileName: 'Z.pkg', size: 1 }), pkg({ id: 'a', fileName: 'A.pkg', size: 9 }),
    pkg({ id: 'patch-only', titleId: 'CUSA00002', type: 'Патч', installOrder: 1, size: 100 })]
  for (const items of [source, [...source].reverse()]) {
    const games = buildConsoleCatalog(items, 'ru', { sort: 'size-asc' }).games
    assert.equal(games[0]!.baseSize, 0)
    assert.equal(games[0]!.size, 100)
    assert.equal(games[1]!.baseSize, 9)
    assert.equal(games[1]!.packages[0]!.id, 'a')
  }
  assert.deepEqual(source.map(item => item.id), ['z', 'a', 'patch-only'])
})

test('platform, search and favorites combine before global sorting and paging', async () => {
  const { filterContent } = await import('../../shared/content-platform.ts')
  const source = Array.from({ length: 45 }, (_, i) => pkg({ id: `game-${i}`, titleId: `SAME${String(i).padStart(5, '0')}`,
    platform: i % 2 ? 'ps5' : 'ps4', title: `Wanted ${i}`, size: (i + 1) * 10_000_000_000 }))
  const favorites = source.filter(item => Number(item.id.slice(5)) >= 10).map(item => item.id)
  const games = buildConsoleCatalog(filterContent(source, 'ps5', 'ps5'), 'ru', {
    groupByPlatform: true, q: 'Wanted', favoriteIds: favorites, sort: 'size-desc', limit: 10, offset: 10,
  })
  assert.equal(games.total, 17)
  assert.deepEqual(games.games.map(item => item.title), ['Wanted 23', 'Wanted 21', 'Wanted 19', 'Wanted 17', 'Wanted 15', 'Wanted 13', 'Wanted 11'])
  assert.equal(filterContent(source, 'ps5', 'ps4').length, 0)
})
