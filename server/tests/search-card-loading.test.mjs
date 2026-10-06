import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'

test('hover preloads without Chromium and opening upgrades an in-flight background request', async () => {
  const path = resolve('node_modules/.cache/search-card-loading-test.mjs')
  const source = readFileSync('app/components/SearchResults.vue', 'utf8').split('<script setup lang="ts">')[1].split('</script>')[0]
  const prefix = `
    import { ref, reactive, computed, nextTick } from 'vue'
    const defineProps = () => globalThis.pfCardProps
    const defineEmits = () => () => {}
    const useAppLocale = () => ({ t: value => value, formatLocale: ref('en') })
    const watch = () => {}, onMounted = () => {}, onBeforeUnmount = () => {}
    const $fetch = (url, options) => globalThis.pfCardFetch(url, options)
  `
  await build({ stdin: { contents: prefix + source + '\nexport { preload, open, detailCache, detailBusy, cancelPreload }', loader: 'ts', resolveDir: process.cwd() }, outfile: path, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  const result = { id: 'release', sourcePage: 'https://rutracker.org/forum/viewtopic.php?t=1', title: 'Release' }
  const calls = [], finishes = []
  const previousObserver = globalThis.IntersectionObserver
  globalThis.IntersectionObserver = class { disconnect() {} observe() {} unobserve() {} }
  globalThis.pfCardProps = { results: [result], visible: true }
  globalThis.pfCardFetch = (url, options) => new Promise(resolve => { calls.push({ url, options }); finishes.push(resolve) })
  try {
    const cards = await import(path)
    const hover = cards.preload(result, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].options.query, undefined, 'Hover must not request browser fallback')
    const click = cards.open(result)
    await new Promise(resolve => setImmediate(resolve))
    finishes.shift()({ status: 'unavailable', fields: [] })
    await hover
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1].options.query, { browser: '1' }, 'Click must retry the HTTP-only failure interactively')
    finishes.shift()({ status: 'available', description: 'Description', fields: [] })
    await click
    assert.equal(cards.detailCache.release.description, 'Description')
    assert.equal(cards.detailBusy.value, false)
    await cards.open(result)
    assert.equal(calls.length, 2, 'A cached description must not navigate Chromium again')
    const cancelledResult = { ...result, id: 'cancelled-release' }
    const background = cards.preload(cancelledResult)
    const opening = cards.open(cancelledResult)
    await new Promise(resolve => setImmediate(resolve))
    globalThis.pfCardProps.visible = false
    cards.cancelPreload()
    await background; await opening
    assert.equal(calls.length, 3, 'Leaving search must cancel the browser upgrade')
    finishes.shift()({ status: 'unavailable', fields: [] })
    await new Promise(resolve => setImmediate(resolve))
    globalThis.pfCardProps.visible = true
    assert.equal(calls.length, 3, 'Returning to search must not reopen a cancelled browser request')
  } finally {
    await new Promise(resolve => setImmediate(resolve))
    globalThis.IntersectionObserver = previousObserver
    delete globalThis.pfCardProps; delete globalThis.pfCardFetch
  }
})
