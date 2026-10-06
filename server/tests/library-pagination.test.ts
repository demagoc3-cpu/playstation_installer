import assert from 'node:assert/strict'
import { test } from 'node:test'
import { paginateLibrary, librarySearchTokens, matchesLibrarySearch } from '../../shared/library-pagination.ts'

const items = Array.from({ length: 2800 }, (_, index) => ({
  id: `pkg-${index}`, title: index % 4 === 0 ? `Игра ${Math.floor(index / 4)}` : `Дополнение ${index}`,
  fileName: `release-${index}.pkg`, titleId: `CUSA${String(Math.floor(index / 4)).padStart(5, '0')}`,
  contentId: `CONTENT-${index}`, type: index % 4 === 0 ? 'Игра' : index % 4 === 1 ? 'Патч' : 'DLC',
  size: 1024, installOrder: index % 4 === 0 ? 0 : index % 4 === 1 ? 1 : 2,
  appVersion: '01.00', iconSize: index % 4 === 0 ? 16 : 0, installedAt: index === 2799 ? 123 : undefined,
}))

test('2800 packages are split into bounded, ordered pages without gaps or duplicates', () => {
  for (const size of [25, 50, 100]) {
    const first = paginateLibrary([...items].reverse(), { pageSize: size })
    assert.equal(first.packages.length, size)
    assert.equal(first.total, 2800)
    assert.equal(first.pages, 2800 / size)
    assert.deepEqual(first.summary, { packages: 2800, games: 700, size: 2800 * 1024, installed: 1, delivered: 0, ready: 2799, readyDlc: 1399 })
    const seen = []
    for (let page = 1; page <= first.pages; page++) seen.push(...paginateLibrary(items, { page, pageSize: size }).packages.map(item => item.id))
    assert.equal(new Set(seen).size, 2800)
    assert.deepEqual(seen, items.map(item => item.id), 'all pages follow the same stable global order')
    assert.deepEqual(new Set(seen), new Set(items.map(item => item.id)))
  }
})

test('search filters the entire library before pagination, including file names and content IDs', () => {
  for (const q of ['RELEASE-2799', 'content-2799', 'дополнение 2799']) {
    const found = paginateLibrary(items, { q, page: 112, pageSize: 25 })
    assert.deepEqual(found.packages.map(item => item.id), ['pkg-2799'])
    assert.equal(found.total, 1)
    assert.equal(found.page, 1)
    assert.equal(found.summary.packages, 2800, 'global counters do not shrink with a search')
    assert.equal(found.packages[0].groupTitle, 'Игра 699')
    assert.equal(found.packages[0].groupPackages, 4)
    assert.equal(found.packages[0].groupReadyDlc, 1)
    assert.equal(found.packages[0].groupIconId, 'pkg-2796', 'base-game cover survives a patch/DLC-only search')
  }
  assert.equal(paginateLibrary(items, { q: 'CUSA00699' }).total, 4)
  assert.equal(paginateLibrary(items, { q: 'Дополнение' }).total, 2100)
  assert.equal(paginateLibrary(items, { q: 'not-in-library' }).total, 0)
  assert.equal(paginateLibrary(items, { q: 'not-in-library' }).pages, 1)
  assert.ok(matchesLibrarySearch({ ...items[0], title: 'Ёжик' }, librarySearchTokens('ежик')))
})

test('invalid page/size values are bounded and page overflow is clamped after removals', () => {
  for (const page of ['wrong', -1, 1.5, Infinity, [], {}]) assert.equal(paginateLibrary(items, { page }).page, 1)
  for (const pageSize of ['all', 2800, -1, 26, Infinity]) assert.equal(paginateLibrary(items, { pageSize }).packages.length, 25)
  assert.equal(paginateLibrary(items.slice(0, 26), { page: 112 }).page, 2)
  assert.equal(paginateLibrary([], { page: 112 }).page, 1)
  assert.equal(paginateLibrary(items, {}, new Set(['pkg-0', 'pkg-2799'])).summary.delivered, 2)
  assert.equal(paginateLibrary(items, { page: 1 }).packages.at(-1)?.groupReadyDlc, 2, 'off-page DLC remains available')
  assert.equal(paginateLibrary(items, { page: 2 }).packages[0].groupTitle, 'Игра 6', 'branches split at a page boundary retain their full-library title')
})
