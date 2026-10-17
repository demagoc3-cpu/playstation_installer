import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';

async function componentHarness(file, fixture, props) {
  const work = mkdtempSync(join(tmpdir(), 'pf-service-control-'));
  const { descriptor } = parse(readFileSync(file, 'utf8'));
  const script = compileScript(descriptor, { id: 'service-control' }).content;
  const contents = `
import {ref,computed,watch} from 'vue';
const fixture=globalThis.pfServiceControlFixture;
const onBeforeUnmount=fn=>fixture.unmount.push(fn);
const onMounted=()=>{};
const useAppLocale=()=>({locale:ref('ru'),t:s=>s});
const localStorage={getItem:()=>null,setItem:()=>{}};
const setTimeout=fn=>{fixture.timer=fn;return 1;};
const clearTimeout=()=>{fixture.timer=undefined;};
const $fetch=(url,options)=>fixture.fetch(url,options);
${script}`;
  globalThis.pfServiceControlFixture = fixture;
  await build({
    stdin: { contents, loader: 'ts', resolveDir: join(process.cwd(), 'app/components') },
    outfile: join(work, 'view.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
    alias: { '#shared': join(process.cwd(), 'shared') },
  });
  const module = createRequire(import.meta.url)(join(work, 'view.cjs'));
  return {
    view: module.default.setup(props, {
      expose() {},
      emit: (...args) => fixture.events.push(args),
    }),
    close() {
      fixture.unmount.forEach((fn) => fn());
      rmSync(work, { recursive: true, force: true });
    },
  };
}
const stopped = {
  consoleId: 'ps5',
  state: 'stopped',
  message: 'Служба остановлена.',
  canStart: true,
  canInstall: false,
  managerAvailable: true,
  savedPayloadKnown: true,
};
function operation(id, state) {
  return {
    id,
    consoleId: 'ps5',
    state,
    version: '1',
    buildId: 'build',
    message: state,
    startedAt: 1,
  };
}

test('service control never starts on mount, deduplicates clicks, polls reads, and emits readiness once', async () => {
  const calls = [],
    fixture = { unmount: [], events: [], timer: undefined };
  let finishPost,
    launchId = '',
    after = stopped;
  fixture.fetch = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') {
      launchId = options.body.requestId;
      return new Promise((resolve) => {
        finishPost = resolve;
      });
    }
    return after;
  };
  const harness = await componentHarness('app/components/Ps5ServiceControl.vue', fixture, {
    consoleId: 'ps5',
    online: false,
  });
  try {
    assert.equal(calls.length, 0, 'opening the UI must not launch or probe every device');
    await harness.view.start('start');
    assert.equal(calls.length, 0, 'launch requires an explicit capability check');
    await harness.view.check();
    const first = harness.view.start('start');
    await harness.view.start('start');
    assert.equal(calls.filter((call) => call.options.method === 'POST').length, 1);
    assert.match(launchId, /^[0-9a-f]{32}$/);
    assert.equal(calls[1].options.body.consoleId, 'ps5');
    assert.equal(calls[1].options.body.action, 'start');
    finishPost({ ...stopped, operation: operation(launchId, 'starting') });
    await first;
    assert.equal(typeof fixture.timer, 'function', 'only active operations schedule read polling');
    after = {
      ...stopped,
      state: 'running',
      canStart: false,
      operation: operation(launchId, 'completed'),
    };
    await harness.view.check();
    await harness.view.check();
    assert.deepEqual(fixture.events, [['ready']]);
    assert.equal(fixture.timer, undefined, 'completed operations stop polling');
    assert.equal(calls.filter((call) => call.options.method === 'POST').length, 1);
    harness.close();
    assert.equal(calls.at(-1).options.signal.aborted, true, 'unmount aborts outstanding reads');
  } finally {
    harness.close();
    delete globalThis.pfServiceControlFixture;
  }
});

test('lost launch replies and unconfirmed states allow only checking, never automatic resubmission', async () => {
  const calls = [],
    fixture = { unmount: [], events: [], timer: undefined };
  let launchId = '',
    after = stopped;
  fixture.fetch = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') {
      launchId = options.body.requestId;
      throw new Error('lost reply');
    }
    return after;
  };
  const harness = await componentHarness('app/components/Ps5ServiceControl.vue', fixture, {
    consoleId: 'ps5',
  });
  try {
    await harness.view.check();
    await harness.view.start('start');
    assert.equal(harness.view.unconfirmed.value, true);
    await harness.view.start('start');
    after = { ...stopped, operation: operation(launchId, 'unconfirmed') };
    await harness.view.check();
    await harness.view.start('install');
    assert.equal(calls.filter((call) => call.options.method === 'POST').length, 1);
    assert.equal(fixture.timer, undefined, 'uncertain state awaits a deliberate read');
    after = {
      ...stopped,
      state: 'running',
      canStart: false,
      operation: operation(launchId, 'completed'),
    };
    await harness.view.check();
    assert.equal(harness.view.unconfirmed.value, false);
    assert.deepEqual(fixture.events, [['ready']]);
  } finally {
    harness.close();
    delete globalThis.pfServiceControlFixture;
  }
});

test('explicit admission rejection requires a fresh check before a new launch is allowed', async () => {
  const calls = [],
    fixture = { unmount: [], events: [], timer: undefined };
  fixture.fetch = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST')
      throw { data: { message: 'Device queue is busy', data: { dispatched: false } } };
    return stopped;
  };
  const harness = await componentHarness('app/components/Ps5ServiceControl.vue', fixture, {
    consoleId: 'ps5',
  });
  try {
    await harness.view.check();
    await harness.view.start('start');
    assert.equal(harness.view.unconfirmed.value, false);
    assert.equal(
      harness.view.info.value,
      undefined,
      'rejected admission invalidates stale capability checks',
    );
    assert.equal(harness.view.error.value, 'Device queue is busy');
    await harness.view.start('start');
    assert.equal(calls.filter((call) => call.options.method === 'POST').length, 1);
    await harness.view.check();
    await harness.view.start('start');
    const posts = calls.filter((call) => call.options.method === 'POST');
    assert.equal(posts.length, 2, 'an explicit new launch is possible only after a fresh check');
    assert.notEqual(posts[0].options.body.requestId, posts[1].options.body.requestId);
    assert.equal(fixture.timer, undefined, 'admission errors never schedule another launch');
  } finally {
    harness.close();
    delete globalThis.pfServiceControlFixture;
  }
});

test('a fresh running service overrides historical launch failure and refreshes its parent once', async () => {
  const fixture = { unmount: [], events: [], timer: undefined };
  fixture.fetch = async () => ({
    ...stopped,
    state: 'running',
    message: 'Служба PackageFlow работает',
    canStart: false,
    operation: { ...operation('c'.repeat(32), 'failed'), message: 'Old launch failed' },
  });
  const harness = await componentHarness('app/components/Ps5ServiceControl.vue', fixture, {
    consoleId: 'ps5',
    online: false,
  });
  try {
    await harness.view.check();
    await harness.view.check();
    assert.equal(harness.view.status.value, 'Служба PackageFlow работает');
    assert.deepEqual(fixture.events, [['ready']]);
    assert.equal(harness.view.unconfirmed.value, false);
  } finally {
    harness.close();
    delete globalThis.pfServiceControlFixture;
  }
});

test('service readiness refresh preserves multi-device choices and invalidates only changed review tokens', async () => {
  const fixture = { unmount: [], events: [], timer: undefined },
    pkg = { packageId: 'base', canOverwrite: true, canReinstall: false, size: 1 };
  let changed = false;
  fixture.fetch = async (_url, options) => {
    assert.deepEqual(
      options.body,
      { packageIds: ['base'] },
      'service checks retain the chosen package set',
    );
    return {
      selection: { packageIds: ['base'] },
      files: 1,
      size: 1,
      packages: [pkg],
      devices: ['ps4', 'ps5'].map((id) => ({
        profile: { id, platform: id, freeBytes: 1000 },
        eligible: !(changed && id === 'ps4'),
        requiredBytes: 0,
        selectedBytes: 0,
        queueBytes: 0,
        reviewToken: changed && id === 'ps5' ? 'changed' : id,
        installedPackages: [pkg],
        queuedPackages: [],
      })),
    };
  };
  const harness = await componentHarness('app/components/DeviceInstallModal.vue', fixture, {
    selection: { packageIds: ['base'] },
  });
  try {
    await harness.view.load();
    harness.view.selected.value = ['ps4', 'ps5'];
    harness.view.overwrite.value = { ps4: ['base'], ps5: ['base'] };
    harness.view.reviewed.value = { ps4: 'ps4', ps5: 'ps5' };
    harness.view.queueReviewed.value = { ps4: 'ps4', ps5: 'ps5' };
    harness.view.query.value = 'living room';
    changed = true;
    await harness.view.load(true);
    assert.deepEqual(harness.view.selected.value, ['ps4', 'ps5']);
    assert.deepEqual(harness.view.overwrite.value, { ps4: ['base'], ps5: ['base'] });
    assert.deepEqual(harness.view.reviewed.value, { ps4: 'ps4' });
    assert.deepEqual(harness.view.queueReviewed.value, { ps4: 'ps4' });
    assert.equal(harness.view.query.value, 'living room');
    assert.equal(
      harness.view.ready.value,
      false,
      'an unavailable selected device blocks submission rather than being silently dropped',
    );
    assert.equal(
      harness.view.attempted.value,
      false,
      'starting the service does not submit a game installation',
    );
  } finally {
    harness.close();
    delete globalThis.pfServiceControlFixture;
  }
});
