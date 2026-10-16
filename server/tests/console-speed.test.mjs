import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = mkdtempSync(join(tmpdir(), 'pf-speed-'));
await build({
  stdin: {
    contents:
      "export {runConsoleSpeed} from './server/utils/console-speed';export * from './server/utils/console-speed-lock'",
    resolveDir: resolve('.'),
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: join(dir, 'speed.mjs'),
  logLevel: 'silent',
});
const api = await import(pathToFileURL(join(dir, 'speed.mjs')).href);
const job = () => ({
  id: 'test',
  consoleId: 'one',
  ip: '192.168.1.5',
  state: 'running',
  size: 1048576,
  startedAt: Date.now(),
  results: [],
});
const receipt = (j, extra = {}) =>
  new Response(
    JSON.stringify({
      protocol: 'speed-test-v1',
      mode: 'disk',
      bytes: j.size,
      complete: true,
      cleanup: true,
      elapsedMs: 10,
      writeMs: 4,
      syncMs: 6,
      ...extra,
    }),
  );
test('direct speed tests validate full responses and separate latency, network and disk', async () => {
  const j = job();
  let calls = 0;
  await api.runConsoleSpeed(
    j,
    ['latency', 'upload', 'download', 'disk'],
    new AbortController().signal,
    {
      request: async () => ({ status: 200, body: { protocol: 'speed-test-v1' } }),
      stream: async (mode) => {
        calls++;
        return mode === 'download'
          ? new Response(Buffer.alloc(j.size), {
              headers: {
                'content-type': 'application/octet-stream',
                'content-length': String(j.size),
              },
            })
          : receipt(j, { mode });
      },
    },
  );
  assert.equal(j.state, 'completed');
  assert.equal(calls, 3);
  assert.equal(j.results.length, 4);
  assert.equal(j.results[3].cleanup, true);
  assert.ok(j.results[1].bytesPerSecond > 0);
});
test('partial data and unconfirmed cleanup never become successful speeds', async () => {
  for (const mode of ['disk', 'download']) {
    const j = job();
    await api.runConsoleSpeed(j, [mode], new AbortController().signal, {
      stream: async () =>
        mode === 'disk'
          ? receipt(j, { cleanup: false })
          : new Response(Buffer.alloc(j.size - 1), {
              headers: {
                'content-type': 'application/octet-stream',
                'content-length': String(j.size),
              },
            }),
    });
    assert.equal(j.state, 'failed');
    assert.equal(j.results.length, 0);
  }
});
test('cancellation and console-scoped locks', async () => {
  const release = api.acquireConsoleSpeedTest('one');
  assert.throws(() => api.acquireConsoleSpeedTest('one'));
  assert.doesNotThrow(() => api.assertNoConsoleSpeedTest('two'));
  release();
  assert.doesNotThrow(() => api.assertNoConsoleSpeedTest('one'));
  const j = job(),
    c = new AbortController();
  c.abort();
  await api.runConsoleSpeed(j, ['disk'], c.signal, {});
  assert.equal(j.state, 'cancelled');
  assert.equal(j.results.length, 0);
});
test('speed info reads the public queue without hidden history', async () => {
  const bundle = join(dir, 'info.mjs');
  await build({
    stdin: {
      contents: "export {consoleSpeedInfo} from './server/utils/console-speed'",
      resolveDir: resolve('.'),
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundle,
    logLevel: 'silent',
    plugins: [
      {
        name: 'public-queue',
        setup(b) {
          b.onLoad({ filter: /[/\\]ps5-installation-queue\.ts$/ }, () => ({
            contents:
              "export const getPs5Queue=()=>({status:'paused',id:'q',items:[{transferProfile:{measuredAt:123,bytes:33554432}}]})",
            loader: 'ts',
          }));
          b.onLoad({ filter: /[/\\]console-profiles\.ts$/ }, () => ({
            contents:
              "export const getConsoleProfile=()=>({platform:'ps5'});export const ps5OperationRequest=async()=>({status:200,body:{protocol:'speed-test-v1',ready:true}});export const ps5SpeedRequest=()=>{};export const ps5ServiceRequest=()=>{}",
            loader: 'ts',
          }));
        },
      },
    ],
  });
  const { consoleSpeedInfo } = await import(pathToFileURL(bundle).href);
  const info = await consoleSpeedInfo('public-queue');
  assert.equal(info.ready, true);
  assert.equal(info.queueStatus, 'paused');
  assert.equal(info.lastTransferProfile.measuredAt, 123);
});
test.after(() => rmSync(dir, { recursive: true, force: true }));
