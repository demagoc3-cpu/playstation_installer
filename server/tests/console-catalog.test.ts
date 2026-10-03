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
