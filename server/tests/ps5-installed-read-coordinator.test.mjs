import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const work = mkdtempSync(join(tmpdir(), 'pf-ps5-read-coordinator-'));
after(() => rmSync(work, { recursive: true, force: true }));
const bundle = join(work, 'coordinator.mjs');
await build({
  entryPoints: [resolve('server/utils/ps5-installed-read-coordinator.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});
const { readPs5Installed, withPs5InstalledReview } = await import(pathToFileURL(bundle).href);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((done) => setImmediate(done));

test('same-console reads include response parsing in one serial slot and preserve results', async () => {
  const response = deferred(),
    parsed = deferred(),
    events = [];
  let active = 0,
    maximum = 0;
  const first = readPs5Installed('serial', 'background', async () => {
    maximum = Math.max(maximum, ++active);
    events.push('request');
    await response.promise;
    events.push('parse');
    await parsed.promise;
    active--;
    return { installed: false, proof: 'original' };
  });
  const second = readPs5Installed('serial', 'foreground', async () => {
    maximum = Math.max(maximum, ++active);
    events.push('next');
    active--;
    return { installed: true, proof: 'fresh' };
  });
  response.resolve();
  await tick();
  assert.deepEqual(events, ['request', 'parse']);
  parsed.resolve();
  assert.deepEqual(await first, { installed: false, proof: 'original' });
  assert.deepEqual(await second, { installed: true, proof: 'fresh' });
  assert.equal(maximum, 1);
});

test('different consoles read in parallel', async () => {
  const hold = deferred(),
    started = [];
  const read = (id) =>
    readPs5Installed(id, 'background', async () => {
      started.push(id);
      await hold.promise;
      return id;
    });
  const a = read('parallel-a'),
    b = read('parallel-b');
  assert.deepEqual(started, ['parallel-a', 'parallel-b']);
  hold.resolve();
  assert.deepEqual(await Promise.all([a, b]), ['parallel-a', 'parallel-b']);
});

test('foreground reads overtake queued background reads without interrupting the active read', async () => {
  const hold = deferred(),
    events = [];
  const active = readPs5Installed('priority', 'background', async () => {
    events.push('active');
    await hold.promise;
  });
  const background = readPs5Installed('priority', 'background', async () =>
    events.push('background'),
  );
  const foreground = readPs5Installed('priority', 'foreground', async () =>
    events.push('foreground'),
  );
  assert.deepEqual(events, ['active']);
  hold.resolve();
  await Promise.all([active, background, foreground]);
  assert.deepEqual(events, ['active', 'foreground', 'background']);
});

test('review leases all consoles before draining, and holds background across profile probes and reads', async () => {
  const activeHold = deferred(),
    profileHold = deferred(),
    previewHold = deferred(),
    entered = deferred(),
    checked = deferred(),
    events = [];
  const active = readPs5Installed('review-a', 'background', async () => {
    events.push('active');
    await activeHold.promise;
  });
  const preview = withPs5InstalledReview(['review-a', 'review-b', 'review-a'], async () => {
    events.push('profile');
    entered.resolve();
    await profileHold.promise;
    await readPs5Installed('review-a', 'foreground', async () => events.push('foreground'));
    checked.resolve();
    await previewHold.promise;
    events.push('preview-complete');
    return 'preview';
  });
  const bgA = readPs5Installed('review-a', 'background', async () => events.push('background-a'));
  const bgB = readPs5Installed('review-b', 'background', async () => events.push('background-b'));
  await tick();
  assert.deepEqual(events, ['active']);
  activeHold.resolve();
  await entered.promise;
  assert.deepEqual(events, ['active', 'profile']);
  profileHold.resolve();
  await checked.promise;
  assert.deepEqual(events, ['active', 'profile', 'foreground']);
  previewHold.resolve();
  assert.equal(await preview, 'preview');
  await Promise.all([active, bgA, bgB]);
  assert.deepEqual(events, [
    'active',
    'profile',
    'foreground',
    'preview-complete',
    'background-a',
    'background-b',
  ]);
});

test('nested and concurrent reviews allow foreground reads and hold background until the last lease', async () => {
  const outerHold = deferred(),
    concurrentHold = deferred(),
    nestedDone = deferred(),
    concurrentEntered = deferred(),
    events = [];
  const outer = withPs5InstalledReview(['nested'], async () => {
    await withPs5InstalledReview(['nested'], async () => {
      await readPs5Installed('nested', 'foreground', async () => events.push('nested-read'));
    });
    nestedDone.resolve();
    await outerHold.promise;
  });
  const concurrent = withPs5InstalledReview(['nested'], async () => {
    concurrentEntered.resolve();
    await concurrentHold.promise;
  });
  const background = readPs5Installed('nested', 'background', async () =>
    events.push('background'),
  );
  await Promise.all([nestedDone.promise, concurrentEntered.promise]);
  assert.deepEqual(events, ['nested-read']);
  outerHold.resolve();
  await outer;
  await tick();
  assert.deepEqual(events, ['nested-read']);
  concurrentHold.resolve();
  await Promise.all([concurrent, background]);
  assert.deepEqual(events, ['nested-read', 'background']);
});

test('aborting a queued read never calls its transport and does not cancel other reads', async () => {
  const hold = deferred(),
    controller = new AbortController(),
    reason = new Error('cancel queued read'),
    events = [];
  const active = readPs5Installed('queued-abort', 'background', async () => {
    events.push('active');
    await hold.promise;
  });
  const aborted = readPs5Installed(
    'queued-abort',
    'foreground',
    async () => events.push('aborted-transport'),
    controller.signal,
  );
  const rejected = assert.rejects(aborted, (error) => error === reason);
  const next = readPs5Installed('queued-abort', 'background', async () => events.push('next'));
  controller.abort(reason);
  await rejected;
  assert.deepEqual(events, ['active']);
  hold.resolve();
  await Promise.all([active, next]);
  assert.deepEqual(events, ['active', 'next']);
});

test('active caller cancellation keeps its serial slot until its callback settles', async () => {
  const hold = deferred(),
    controller = new AbortController(),
    events = [];
  const active = readPs5Installed(
    'active-abort',
    'background',
    async () => {
      events.push('active');
      await hold.promise;
      controller.signal.throwIfAborted();
    },
    controller.signal,
  );
  const rejected = assert.rejects(active, { name: 'AbortError' });
  const next = readPs5Installed('active-abort', 'foreground', async () => events.push('next'));
  controller.abort();
  await tick();
  assert.deepEqual(events, ['active']);
  hold.resolve();
  await Promise.all([rejected, next]);
  assert.deepEqual(events, ['active', 'next']);
});

test('aborting review acquisition releases all leases and never invokes its callback', async () => {
  const hold = deferred(),
    controller = new AbortController(),
    reason = new Error('cancel acquiring review'),
    events = [];
  const active = readPs5Installed('acquire-a', 'background', async () => hold.promise);
  const preview = withPs5InstalledReview(
    ['acquire-a', 'acquire-b'],
    async () => events.push('aborted-preview'),
    controller.signal,
  );
  const rejected = assert.rejects(preview, (error) => error === reason);
  const bgA = readPs5Installed('acquire-a', 'background', async () => events.push('a'));
  const bgB = readPs5Installed('acquire-b', 'background', async () => events.push('b'));
  controller.abort(reason);
  await rejected;
  await bgB;
  assert.deepEqual(events, ['b']);
  hold.resolve();
  await Promise.all([active, bgA]);
  assert.deepEqual(events, ['b', 'a']);
});

test('a failed background read drains normally and a failed review releases its leases', async () => {
  const hold = deferred(),
    readError = new Error('transport unavailable'),
    previewError = new Error('preview failed'),
    events = [];
  const active = readPs5Installed('errors', 'background', async () => hold.promise);
  const readRejected = assert.rejects(active, (error) => error === readError);
  const preview = withPs5InstalledReview(['errors'], async () => {
    events.push('preview');
    throw previewError;
  });
  const previewRejected = assert.rejects(preview, (error) => error === previewError);
  const background = readPs5Installed('errors', 'background', async () =>
    events.push('background'),
  );
  hold.reject(readError);
  await Promise.all([readRejected, previewRejected, background]);
  assert.deepEqual(events, ['preview', 'background']);
  assert.equal(await readPs5Installed('errors', 'background', async () => 'fresh'), 'fresh');
});

test('pre-aborted reads and reviews do not invoke callbacks or leave leases', async () => {
  const controller = new AbortController(),
    reason = new Error('already cancelled');
  controller.abort(reason);
  const unexpected = async () => assert.fail('cancelled callback ran');
  await assert.rejects(
    readPs5Installed('pre-abort', 'background', unexpected, controller.signal),
    (error) => error === reason,
  );
  await assert.rejects(
    withPs5InstalledReview(['pre-abort'], unexpected, controller.signal),
    (error) => error === reason,
  );
  assert.equal(await readPs5Installed('pre-abort', 'background', async () => 'allowed'), 'allowed');
});
