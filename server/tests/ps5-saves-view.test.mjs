import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { parse, compileScript } from '@vue/compiler-sfc'
import { build } from 'esbuild'

test('PS5 save view lists saves independently of backup errors and can clear game/user/platform filters', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-save-view-'))
  let failSaves = false
  const rows = [
    { titleId: 'PPSA00001', title: 'Fixture PS5', userId: 'ab12cd34', kind: 'native' },
    { titleId: 'PPSA00001', title: 'Fixture PS5', userId: '11223344', kind: 'native' },
    { titleId: 'CUSA00002', title: 'Fixture PS4', userId: 'ab12cd34', kind: 'legacy' },
  ]
  globalThis.pfSaveViewFixture = {
    async request(route, options) {
      assert.equal(options.body.consoleId, 'selected-ps5')
      if (route.endsWith('/backups')) throw Error('Backup storage unavailable')
      if (failSaves) throw Error('PS5 offline')
      return { complete: true, entries: rows }
    },
  }
  try {
    const { descriptor } = parse(readFileSync('app/components/Ps5ConsoleSaves.vue', 'utf8'))
    const script = compileScript(descriptor, { id: 'save-view-test' }).content
    const contents = `import {ref,computed,watch,reactive,nextTick} from 'vue';
      const useConsoleRequest=()=>globalThis.pfSaveViewFixture.request;
      const useAppLocale=()=>({t:s=>s,formatLocale:ref('ru-RU')});
      const onMounted=()=>{},onBeforeUnmount=()=>{};
      export {reactive,nextTick};\n${script}`
    const outfile = join(work, 'view.cjs')
    await build({ stdin: { contents, loader: 'ts', resolveDir: process.cwd() }, outfile, alias:{'#shared':resolve('shared')}, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
    const module = createRequire(import.meta.url)(outfile)
    const props = module.reactive({ consoleId: 'selected-ps5', focusTitleId: 'PPSA99999' })
    const view = module.default.setup(props, { expose() {} })
    await view.load()
    assert.equal(view.entries.value.length, 3, 'backup listing failure must not hide console saves')
    assert.equal(view.loaded.value, true)
    assert.equal(view.error.value, '')
    assert.equal(view.copiesError.value, 'Backup storage unavailable')
    assert.equal(view.filtered.value.length, 0)
    view.resetFilters()
    assert.equal(view.filtered.value.length, 3)
    assert.equal(view.groups.value.length, 2, 'group all user saves by game like ps5upload')
    view.kind.value = 'native'; view.user.value = '11223344'
    assert.equal(view.filtered.value.length, 1)
    props.focusTitleId = 'CUSA00002'; await module.nextTick()
    assert.equal(view.filtered.value.length, 1, 'new game focus clears incompatible user/platform filters')
    props.focusTitleId = ''; await module.nextTick()
    assert.equal(view.filtered.value.length, 3)
    failSaves = true; await view.load()
    assert.equal(view.entries.value.length, 0, 'failed refresh must not leave stale actionable rows')
    assert.equal(view.loaded.value, false)
    assert.equal(view.error.value, 'PS5 offline')
    assert.equal(view.busy.value, false)
  } finally {
    delete globalThis.pfSaveViewFixture
    rmSync(work, { recursive: true, force: true })
  }
})
