import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';

function packageEntry(id, title, platform = 'ps4') {
  return {
    id,
    title,
    platform,
    format: 'pkg',
    fileName: `${id}.pkg`,
    size: 1024,
    type: 'Игра',
    titleId: platform === 'ps5' ? 'PPSA10002' : 'CUSA10001',
    installOrder: 0,
    url: `/api/packages/${id}`,
    contentId: `${platform}-${id}`,
    contentType: 'game',
    libraryRoot: 'fixture-library',
    appVersion: '01.00',
  };
}

const alpha = packageEntry('alpha', 'Alpha adventure');
const beta = packageEntry('beta', 'Beta adventure', 'ps5');

async function mountLibrary() {
  const directory = mkdtempSync(join(tmpdir(), 'pf-library-selection-'));
  const { descriptor } = parse(readFileSync(resolve('app/app.vue'), 'utf8'));
  const source = compileScript(descriptor, { id: 'library-selection-test' }).content;
  const outfile = join(directory, 'app.cjs');
  // Run the real application setup and Vue reactivity, without startup polling or
  // a browser. Only the library/activity/queue API responses below are fixtures.
  const prefix = `
    import { ref, reactive, computed, watch, nextTick, effectScope } from 'vue';
    const useAppLocale = () => ({ t: value => value, locale: ref('ru'), formatLocale: ref('ru-RU') });
    const useHead = () => {};
    const useRuntimeConfig = () => ({ public: { donation: {} } });
    const useState = (_key, initial) => ref(initial());
    const onMounted = () => {}, onBeforeUnmount = () => {}, onUnmounted = () => {};
    const saved = new Map();
    const localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
    const document = { querySelector: () => null, visibilityState: 'visible' };
    const window = { location: { hash: '', pathname: '/', search: '' }, clearInterval, confirm: () => true };
    const history = { replaceState: () => {} };
    let fetchFixture;
    const $fetch = (...args) => fetchFixture(...args);
    const setFetch = value => { fetchFixture = value };
    export { nextTick, effectScope, setFetch, saved };
  `;
  try {
    await build({
      stdin: { contents: `${prefix}\n${source}`, loader: 'ts', resolveDir: process.cwd() },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
      alias: { '#shared': resolve('shared') },
      define: { 'import.meta.client': 'false' },
    });
    const module = createRequire(import.meta.url)(outfile);
    const entries = [
      alpha,
      beta,
      ...Array.from({ length: 60 }, (_, index) =>
        packageEntry(
          `library-${index}`,
          `Library ${String(index).padStart(2, '0')}`,
          index % 2 ? 'ps5' : 'ps4',
        ),
      ),
    ].map((item) => ({ ...item }));
    const requests = [],
      unexpected = [];
    module.setFetch(async (url, options = {}) => {
      requests.push({ url, options });
      if (url === '/api/packages') {
        const { q = '', page = 1, pageSize = 25, platform = 'all' } = options.query;
        const filtered = entries.filter(
          (item) =>
            item.title.toLowerCase().includes(q.toLowerCase()) &&
            (platform === 'all' || item.platform === platform),
        );
        const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
        const current = Math.min(page, pages);
        return {
          packages: filtered.slice((current - 1) * pageSize, current * pageSize),
          page: current,
          pageSize,
          pages,
          total: filtered.length,
          unit: 'games',
          summary: {
            packages: entries.length,
            games: entries.length,
            size: entries.length * 1024,
            installed: 0,
            delivered: 0,
            ready: entries.length,
            readyDlc: 0,
          },
        };
      }
      if (url === '/api/consoles/activity') return [];
      if (url === '/api/ps4/installation' || url === '/api/consoles/installation')
        return { status: 'idle', items: [] };
      unexpected.push(url);
      throw new Error(`Unexpected request: ${url}`);
    });
    const scope = module.effectScope();
    const view = scope.run(() => module.default.setup({}, { expose() {}, emit() {} }));
    async function settle() {
      for (let index = 0; index < 20; index++) {
        await module.nextTick();
        if (!view.libraryBusy.value) {
          await module.nextTick();
          assert.equal(view.libraryError.value, '');
          assert.deepEqual(unexpected, []);
          return;
        }
      }
      assert.fail('Library page did not settle');
    }
    return {
      view,
      entries,
      requests,
      saved: module.saved,
      settle,
      async search(query) {
        view.libraryQuery.value = query;
        view.searchLibrary();
        await settle();
      },
      cleanup() {
        scope.stop();
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function assertSelection(view, ids) {
  assert.deepEqual([...view.selected.value].sort(), [...ids].sort());
  assert.deepEqual([...view.selectedPackages.keys()].sort(), [...ids].sort());
  assert.deepEqual(view.selectedItems.value.map((item) => item.id).sort(), [...ids].sort());
}

async function selectTwo(harness) {
  await harness.search('Alpha');
  const first = harness.view.packages.value[0];
  harness.view.toggleSelected(first.rowId);
  await harness.search('Beta');
  harness.view.toggleSelected(harness.view.packages.value[0].rowId);
  return first;
}

test('library selection survives searches, empty results, pagination and platform filters, and installs every selected package', async () => {
  const h = await mountLibrary();
  try {
    const v = h.view;
    await selectTwo(h);
    assertSelection(v, ['alpha', 'beta']);

    await h.search('no matching game');
    assert.equal(v.packages.value.length, 0);
    assertSelection(v, ['alpha', 'beta']);
    await h.search('');
    v.changeLibraryPage(2);
    await h.settle();
    assert.equal(v.libraryPage.value, 2);
    assert.equal(
      v.packages.value.some((item) => ['alpha', 'beta'].includes(item.id)),
      false,
    );
    assertSelection(v, ['alpha', 'beta']);
    v.changeLibraryPageSize(50);
    await h.settle();
    assert.equal(v.libraryPageSize.value, 50);
    assert.equal(h.saved.get('packageflow-library-page-size'), '50');
    assertSelection(v, ['alpha', 'beta']);

    v.libraryPlatform.value = 'ps4';
    v.libraryPage.value = 1;
    await v.loadLibraryPage();
    assert.ok(v.packages.value.every((item) => item.platform === 'ps4'));
    assertSelection(v, ['alpha', 'beta']);
    h.entries.find((item) => item.id === 'alpha').title = 'Alpha refreshed metadata';
    await h.search('Alpha');
    assert.equal(
      v.selectedItems.value.find((item) => item.id === 'alpha').title,
      'Alpha refreshed metadata',
    );
    assertSelection(v, ['alpha', 'beta']);

    v.showSelected.value = true;
    v.installSelected();
    assert.equal(v.showSelected.value, false);
    assert.deepEqual(v.installSelection.value, { packageIds: ['alpha', 'beta'] });
    assertSelection(v, ['alpha', 'beta']);
  } finally {
    h.cleanup();
  }
});

test('selection review can remove an off-page package, cancel installation without loss, and explicitly clear the basket', async () => {
  const h = await mountLibrary();
  try {
    const v = h.view;
    const offPage = await selectTwo(h);
    assert.equal(
      v.packages.value.some((item) => item.rowId === offPage.rowId),
      false,
    );
    v.removeSelected(offPage.rowId);
    assertSelection(v, ['beta']);
    v.showSelected.value = true;
    v.installSelected();
    assert.deepEqual(v.installSelection.value, { packageIds: ['beta'] });
    // DeviceInstallModal's close event clears only its request in app.vue.
    v.installSelection.value = null;
    assertSelection(v, ['beta']);
    await h.search('Alpha');
    assert.equal(v.isSelected('alpha'), false);
    assertSelection(v, ['beta']);
    v.clearSelection();
    assertSelection(v, []);
    v.installSelected();
    assert.equal(v.installSelection.value, null);
  } finally {
    h.cleanup();
  }
});

test('queueing a game drops only the sent packages from the selection; the rest stays until explicit clear', async () => {
  const h = await mountLibrary();
  try {
    const v = h.view;
    const first = await selectTwo(h);
    v.installOne(first);
    assert.deepEqual(v.installSelection.value, { packageIds: ['alpha'] });
    await v.confirmedSelectionQueued();
    assert.ok(h.requests.some((request) => request.url === '/api/ps4/installation'));
    // Sent packages leave the selection, so the next install does not resend them.
    assertSelection(v, ['beta']);
    v.installItems(v.selectedItems.value);
    assert.deepEqual(v.installSelection.value, { packageIds: ['beta'] });
    v.clearSelection();
    assertSelection(v, []);
  } finally {
    h.cleanup();
  }
});
