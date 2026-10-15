import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createError } from 'h3';

test('PS4 speed API uses authenticated service streams, gates older/busy services and preserves per-console exclusion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-ps4-speed-')),
    oldEnv = process.env.PACKAGEFLOW_DATA_DIR,
    oldFetch = globalThis.fetch,
    oldError = globalThis.createError;
  process.env.PACKAGEFLOW_DATA_DIR = dir;
  globalThis.createError = createError;
  try {
    const bundle = join(dir, 'api.mjs');
    await build({
      stdin: {
        contents:
          "export * from './server/utils/console-speed';export * from './server/utils/console-speed-lock';export * from './server/utils/console-profiles';export * from './server/utils/ps4-transport-admission';export {ps4SpeedRequest} from './server/utils/ps4-service-installer'",
        resolveDir: resolve('.'),
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: bundle,
      logLevel: 'silent',
    });
    const api = await import(pathToFileURL(bundle).href),
      p = api.saveConsoleProfile({ name: 'Own PS4', ip: '192.168.1.4', platform: 'ps4' })
        .consoles[0],
      key = 'a'.repeat(32);
    writeFileSync(join(dir, 'ps4-service-keys.json'), JSON.stringify({ [p.ip]: key }));
    const ready = {
      service: 'PackegeFlowService',
      protocol: 'speed-test-v1',
      benchmarkApi: 1,
      ready: true,
      busy: false,
      maxBytes: 268435456,
      modes: ['latency', 'upload', 'download', 'disk'],
    };
    let info = ready,
      status = 200,
      badId = false,
      hold = false,
      started,
      abortSeen,
      requests = [];
    const response = (body, headers = {}, s = 200) =>
      new Response(JSON.stringify(body), {
        status: s,
        headers: { 'Content-Type': 'application/json', ...headers },
      });
    globalThis.fetch = async (url, options = {}) => {
      const address = new URL(url);
      assert.equal(address.hostname, p.ip);
      assert.equal(address.port, '12801');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, `Bearer ${key}`);
      assert.equal(
        Object.keys(options.headers).some((k) => k.toLowerCase() === 'origin'),
        false,
      );
      requests.push(address.pathname);
      if (address.pathname === '/benchmark/info') return response(info, {}, status);
      assert.ok(
        ['/benchmark/upload', '/benchmark/download', '/benchmark/disk'].includes(address.pathname),
      );
      const mode = address.pathname.split('/').at(-1),
        n = Number(options.headers['X-PackageFlow-Size']),
        id = options.headers['X-PackageFlow-Request-Id'];
      assert.match(id, /^[0-9a-f-]{36}$/);
      assert.equal(options.headers.Connection, 'close');
      if (hold) {
        started();
        await new Promise((resolve, reject) =>
          options.signal.addEventListener(
            'abort',
            () => {
              abortSeen = true;
              reject(options.signal.reason);
            },
            { once: true },
          ),
        );
      }
      if (mode === 'download') {
        assert.equal(options.method, 'GET');
        assert.equal(options.body, undefined);
        let left = n;
        return new Response(
          new ReadableStream({
            pull(c) {
              if (!left) {
                c.close();
                return;
              }
              const amount = Math.min(left, 1048576);
              left -= amount;
              c.enqueue(new Uint8Array(amount).fill(0x5a));
            },
          }),
          {
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(n),
              'X-PackageFlow-Request-Id': badId ? 'other' : id,
            },
          },
        );
      }
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Type'], 'application/octet-stream');
      assert.equal(options.headers['Content-Length'], String(n));
      assert.equal(options.duplex, 'half');
      let bytes = 0;
      for await (const chunk of options.body) {
        assert.ok(chunk.length <= 1048576);
        assert.equal(chunk[0], 0x5a);
        assert.equal(chunk.at(-1), 0x5a);
        bytes += chunk.length;
      }
      assert.equal(bytes, n);
      return response(
        {
          protocol: 'speed-test-v1',
          mode,
          bytes: n,
          complete: true,
          cleanup: true,
          elapsedMs: 10,
          writeMs: mode === 'disk' ? 4 : 0,
          syncMs: mode === 'disk' ? 1 : 0,
          receivePipeline: mode === 'disk',
        },
        { 'X-PackageFlow-Request-Id': badId ? 'other' : id },
      );
    };
    assert.equal((await api.consoleSpeedInfo(p.id)).ready, true);
    for (const body of [
      { ...ready, service: 'foreign' },
      { ...ready, busy: true },
      { ...ready, ready: false },
      { ...ready, maxBytes: 1 },
    ]) {
      info = body;
      assert.equal((await api.consoleSpeedInfo(p.id)).ready, false);
      await assert.rejects(api.beginConsoleSpeed(p.id, 64, ['disk']), (e) => e.statusCode === 409);
      assert.equal(api.consoleSpeedLocked(p.id), false);
    }
    status = 404;
    assert.match((await api.consoleSpeedInfo(p.id)).message, /обновление службы/);
    status = 200;
    info = ready;
    const qdir = join(dir, 'consoles', p.ip);
    mkdirSync(qdir, { recursive: true });
    writeFileSync(
      join(qdir, 'installation-queue.json'),
      JSON.stringify({ version: 1, psIp: p.ip, status: 'running', items: [] }),
    );
    const before = requests.length;
    await assert.rejects(api.beginConsoleSpeed(p.id, 64, ['disk']), (e) => e.statusCode === 409);
    assert.equal(
      requests.length,
      before,
      'active installation must not be paused or contacted by benchmark',
    );
    rmSync(join(qdir, 'installation-queue.json'));
    const until = async (f) => {
      const deadline = Date.now() + 5000;
      while (!f()) {
        assert.ok(Date.now() < deadline, 'benchmark timeout');
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    const job = await api.beginConsoleSpeed(p.id, 64, ['latency', 'upload', 'download', 'disk']);
    await until(
      () => api.consoleSpeedJob(p.id, job.id).state !== 'running' && !api.consoleSpeedLocked(p.id),
    );
    const finished = api.consoleSpeedJob(p.id, job.id);
    assert.equal(finished.state, 'completed');
    assert.deepEqual(
      finished.results.map((r) => r.mode),
      ['latency', 'upload', 'download', 'disk'],
    );
    assert.equal(finished.results[3].cleanup, true);
    assert.equal(finished.results[3].receivePipeline, true);
    assert.ok(finished.results[2].bytesPerSecond > 0);
    assert.equal(JSON.stringify(finished).includes(key), false);
    badId = true;
    await assert.rejects(
      api.ps4SpeedRequest(p.ip, 'upload', 1048576, new AbortController().signal),
      /идентификатор/,
    );
    badId = false;
    hold = true;
    const entered = new Promise((r) => (started = r)),
      pending = await api.beginConsoleSpeed(p.id, 64, ['disk']);
    await entered;
    assert.throws(
      () => api.assertPs4TransportAdmission(p.ip, 'service'),
      (e) => e.statusCode === 409,
    );
    assert.throws(
      () => api.assertPs4TransportAdmission(p.ip, 'payload'),
      (e) => e.statusCode === 409,
    );
    assert.match(api.ps4TransportConflict(p.ip, 'service'), /тест скорости/);
    assert.doesNotThrow(() => api.assertPs4TransportAdmission('192.168.1.6', 'service'));
    await assert.rejects(api.beginConsoleSpeed(p.id, 64, ['latency']), (e) => e.statusCode === 409);
    api.cancelConsoleSpeed(p.id, pending.id);
    await until(() => !api.consoleSpeedLocked(p.id));
    assert.equal(abortSeen, true);
    assert.equal(api.consoleSpeedJob(p.id, pending.id).state, 'cancelled');
    assert.doesNotThrow(() => api.assertPs4TransportAdmission(p.ip, 'service'));
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.createError = oldError;
    if (oldEnv === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = oldEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});
