import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';

test('table review is mandatory, sends only selected destinations/packages, and never resubmits a lost reply', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-install-dialog-')),
    calls = [];
  const old = globalThis.pfInstallDialogFixture;
  const pkg = {
    packageId: 'base',
    title: 'Game',
    titleId: 'CUSA95001',
    type: 'Игра',
    version: '01.00',
    size: 100,
    canOverwrite: true,
    canReinstall: false,
    affected: [],
    reinstallReason: '',
  };
  globalThis.pfInstallDialogFixture = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('install-preview'))
      return {
        selection: { packageIds: ['base'] },
        files: 1,
        size: 100,
        packages: [pkg],
        devices: ['one', 'two'].map((id) => ({
          profile: { id, ip: '192.168.1.5', platform: 'ps5', freeBytes: 1000 },
          eligible: true,
          requiredBytes: 0,
          selectedBytes: 0,
          queueBytes: 0,
          reviewToken: id === 'one' ? 'a'.repeat(64) : 'b'.repeat(64),
          queuedPackages: [],
          installedPackages: [pkg],
        })),
      };
    throw new Error('lost reply');
  };
  try {
    const { descriptor } = parse(readFileSync('app/components/DeviceInstallModal.vue', 'utf8'));
    const script = compileScript(descriptor, { id: 'install-dialog' }).content;
    const contents = `import {ref,computed} from 'vue';const onMounted=()=>{};const onBeforeUnmount=()=>{};const useAppLocale=()=>({t:s=>s});const localStorage={getItem:()=>null,setItem:()=>{}};const $fetch=(url,options)=>globalThis.pfInstallDialogFixture(url,options);\n${script}`;
    const outfile = join(work, 'view.cjs');
    await build({
      stdin: { contents, loader: 'ts', resolveDir: join(process.cwd(), 'app/components') },
      outfile,
      alias: { '#shared': resolve('shared') },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    });
    const module = createRequire(import.meta.url)(outfile),
      props = { selection: { packageIds: ['base'] } },
      view = module.default.setup(props, { expose() {}, emit() {} });
    props.selection.packageIds.push('not-selected', 'LittleNightmares');
    await view.load();
    assert.deepEqual(
      calls[0].options.body,
      { packageIds: ['base'] },
      'selection is frozen when opening the modal',
    );
    await view.load(true);
    assert.deepEqual(
      calls[1].options.body,
      { packageIds: ['base'], refresh: true },
      'explicit refresh preserves the captured selection and requests a fresh device check',
    );
    const streaming = {
      ...view.preview.value.devices[0],
      requiredBytes: 610,
      selectedBytes: 100,
      queueBytes: 500,
      installedPackages: [],
    };
    const payload = {
      ...streaming,
      profile: { id: 'payload', platform: 'ps4', transport: 'payload', freeBytes: 1 },
    };
    assert.equal(view.required(payload), 0);
    assert.equal(
      view.spaceEnough(payload),
      true,
      'PyLoader must not use missing or stale service space',
    );
    assert.equal(
      view.required(streaming),
      610,
      'UI keeps server mixed queue estimate instead of doubling source bytes',
    );
    view.selected.value = ['one'];
    assert.equal(view.ready.value, false);
    await view.install();
    assert.equal(calls.filter((c) => c.url.endsWith('install-batch')).length, 0);
    view.openInstalled(view.preview.value.devices[0]);
    view.draft.value = ['base'];
    await view.applyPanel();
    view.overwrite.value.two = ['base'];
    assert.equal(view.ready.value, true);
    view.preview.value.devices[0].profile.freeBytes = 1;
    assert.equal(view.ready.value, false, 'approved replacements participate in space checks');
    view.preview.value.devices[0].profile.freeBytes = 1000;
    await view.install();
    const post = calls.find((c) => c.url.endsWith('install-batch'));
    assert.deepEqual(post.options.body.overwrite, { one: ['base'] });
    assert.deepEqual(post.options.body.consoleIds, ['one']);
    assert.deepEqual(post.options.body.selection, { packageIds: ['base'] });
    assert.deepEqual(post.options.body.reviewTokens, { one: 'a'.repeat(64) });
    await view.install();
    assert.equal(calls.filter((c) => c.url.endsWith('install-batch')).length, 1);
  } finally {
    globalThis.pfInstallDialogFixture = old;
    rmSync(work, { recursive: true, force: true });
  }
});
