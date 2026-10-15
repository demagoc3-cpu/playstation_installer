import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createApp, createError, defineEventHandler, readBody, toWebHandler } from 'h3';

test('explicit picker refresh bypasses recent offline cache and refreshes space without disturbing active transfers', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-preview-refresh-')),
    previousData = process.env.PACKAGEFLOW_DATA_DIR,
    oldFetch = globalThis.fetch,
    globals = Object.fromEntries(
      ['defineEventHandler', 'readBody', 'createError'].map((key) => [key, globalThis[key]]),
    );
  process.env.PACKAGEFLOW_DATA_DIR = join(work, 'data');
  mkdirSync(process.env.PACKAGEFLOW_DATA_DIR);
  Object.assign(globalThis, { defineEventHandler, readBody, createError });
  try {
    const output = join(work, 'preview.mjs');
    await build({
      stdin: {
        contents: `export { default as previewHandler } from './server/api/consoles/install-preview.post';
          export * from './server/utils/console-profiles';
          export { ps5BlankQueue } from './server/utils/ps5-queue-core';`,
        resolveDir: resolve('.'),
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: output,
      logLevel: 'silent',
    });
    const api = await import(pathToFileURL(output).href),
      profile = api.saveConsoleProfile({ name: 'Own PS5', ip: '192.168.1.5', platform: 'ps5' })
        .consoles[0],
      data = process.env.PACKAGEFLOW_DATA_DIR,
      source = join(work, 'source.pkg'),
      pkg = {
        id: 'own-base',
        platform: 'ps5',
        format: 'pkg',
        title: 'Own package',
        titleId: 'PPSA95001',
        contentId: 'IV0000-PPSA95001_00-PACKAGEFLOWUI001',
        contentType: 'PS5GD',
        appVersion: '01.000.001',
        requiredFirmware: '3.00',
        size: 1024,
        type: 'Игра',
        installOrder: 0,
        fileName: 'source.pkg',
        path: source,
        libraryRoot: work,
        sourceModifiedAt: 1,
        iconSize: 0,
        icon: { offset: 0, size: 0 },
      };
    writeFileSync(source, Buffer.alloc(pkg.size));
    writeFileSync(
      join(data, 'package-library.json'),
      JSON.stringify({ version: 2, packages: [pkg], deliveries: {} }),
    );
    writeFileSync(
      join(data, 'ps5-service-keys.json'),
      JSON.stringify({ [profile.ip]: 'b'.repeat(64) }),
    );
    let offline = true,
      freeBytes = 2 ** 30,
      calls = [];
    globalThis.fetch = async (url, options) => {
      const path = new URL(url).pathname;
      calls.push(path);
      assert.equal(options.method, 'GET', 'preview never dispatches a console mutation');
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (offline) throw new Error('fixture disconnected');
      const body =
        path === '/health'
          ? {
              apiVersion: 'v1',
              pid: 88,
              firmwareRead: true,
              firmwareRaw: '0x13600007',
              serviceReport: {
                service: 'PackageFlowService-PS5',
                platform: 'ps5',
                consoleVerified: true,
                version: '0.1.27-dev',
                buildId: 'same-process',
              },
            }
          : path === '/api/v1/capabilities'
            ? { service: 'PackageFlowService-PS5', capabilities: {} }
            : path === '/api/v1/install/readiness'
              ? {
                  service: 'PackageFlowService-PS5',
                  schemaVersion: 1,
                  route: 'staged-pkg',
                  exactVersionReceipt: false,
                  ready: true,
                  reason: 'ready',
                  formats: ['pkg'],
                  platforms: ['ps4', 'ps5'],
                }
              : path === '/api/v1/system'
                ? {
                    service: 'PackageFlowService-PS5',
                    storageRead: true,
                    freeBytes,
                    totalBytes: 8 * 2 ** 30,
                  }
                : path === '/api/v1/management/status'
                  ? { protocol: 'ps5-management-v1', ready: true, catalog: true }
                  : path === '/api/v1/console/catalog'
                    ? { revision: 'c'.repeat(64), total: 0, entries: [], next: 0, done: true }
                    : assert.fail(`unexpected route ${path}`);
      return new Response(JSON.stringify(body));
    };
    await api.probeConsoleProfile(profile.id, true);
    const app = createApp();
    app.use('/api/consoles/install-preview', api.previewHandler);
    const handle = toWebHandler(app),
      request = async (extra = {}) => {
        const response = await handle(
          new Request('http://localhost/api/consoles/install-preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
            body: JSON.stringify({ packageIds: [pkg.id], ...extra }),
          }),
        );
        return { status: response.status, body: await response.json() };
      };
    offline = false;
    calls = [];
    const cached = await request();
    assert.equal(cached.status, 200);
    assert.equal(cached.body.devices[0].profile.online, false);
    assert.equal(cached.body.devices[0].reason, 'Нет связи с приставкой');
    assert.deepEqual(calls, [], 'normal preview keeps the recent offline cache');
    await request({ refresh: false });
    assert.deepEqual(calls, [], 'explicit false keeps the normal cache');
    const fresh = await request({ refresh: true }),
      device = fresh.body.devices[0];
    assert.equal(fresh.status, 200);
    assert.equal(device.profile.online, true);
    assert.equal(device.profile.paired, true);
    assert.equal(device.profile.freeBytes, freeBytes);
    assert.equal(device.eligible, true);
    assert.deepEqual(fresh.body.selection.packageIds, [pkg.id]);
    assert.ok(
      calls.includes('/api/v1/install/readiness'),
      'idle refresh obtains current readiness',
    );
    const validCalls = calls.length;
    for (const refresh of ['true', 1, null, {}, []]) {
      assert.equal((await request({ refresh })).status, 400, 'refresh accepts only a boolean');
    }
    assert.equal(calls.length, validCalls, 'invalid refresh modes never contact a console');
    const queueDir = join(data, 'consoles', profile.id);
    mkdirSync(queueDir, { recursive: true });
    const queuePath = join(queueDir, 'ps5-installation-queue.json'),
      queue = api.ps5BlankQueue(profile.id, profile.ip);
    queue.status = 'running';
    queue.items = [
      {
        packageId: 'another-package',
        title: 'Another package',
        fileName: 'another.pkg',
        titleId: 'PPSA95002',
        type: 'Игра',
        platform: 'ps5',
        format: 'pkg',
        branch: 'ps5:PPSA95002',
        order: 0,
        transferId: 'd'.repeat(32),
        state: 'sending',
        detail: 'Sending',
        size: 8192,
        bytesSent: 4096,
      },
    ];
    writeFileSync(queuePath, JSON.stringify(queue));
    const original = readFileSync(queuePath, 'utf8');
    freeBytes *= 2;
    calls = [];
    const [left, right] = await Promise.all([
      request({ refresh: true }),
      request({ refresh: true }),
    ]);
    for (const result of [left, right]) {
      assert.equal(result.status, 200);
      const active = result.body.devices[0];
      assert.equal(active.profile.online, true);
      assert.equal(active.profile.freeBytes, freeBytes, 'explicit refresh updates available space');
      assert.equal(active.profile.capabilitiesDeferred, true);
      assert.deepEqual(active.profile.capabilities.formats, ['pkg']);
      assert.equal(
        active.reviewToken,
        device.reviewToken,
        'an unchanged review keeps its identity',
      );
    }
    assert.equal(
      calls.filter((path) => path === '/health').length,
      1,
      'concurrent force refreshes share the in-flight probe',
    );
    assert.equal(calls.filter((path) => path === '/api/v1/system').length, 1);
    assert.ok(
      !calls.includes('/api/v1/install/readiness'),
      'active transfer keeps background probing without synchronous installer hello',
    );
    assert.equal(
      readFileSync(queuePath, 'utf8'),
      original,
      'preview never changes the active queue',
    );
    calls = [];
    await request();
    assert.ok(
      !calls.includes('/health') && !calls.includes('/api/v1/system'),
      'normal preview still reuses a recent successful snapshot',
    );
  } finally {
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries(globals)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
    if (previousData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = previousData;
    rmSync(work, { recursive: true, force: true });
  }
});
