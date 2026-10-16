import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

test('background checks never block a sending PS5 on installer hello; explicit checks stay fresh and readiness cannot cross process generations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-background-probe-'));
  const oldData = process.env.PACKAGEFLOW_DATA_DIR,
    oldFetch = globalThis.fetch;
  process.env.PACKAGEFLOW_DATA_DIR = dir;
  try {
    const output = join(dir, 'probe.mjs');
    await build({
      stdin: {
        contents: "export * from './server/utils/console-profiles'",
        resolveDir: resolve('.'),
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: output,
      logLevel: 'silent',
    });
    const api = await import(pathToFileURL(output).href);
    const profile = api.saveConsoleProfile({
      name: 'Own fixture',
      ip: '192.168.1.5',
      platform: 'ps5',
    }).consoles[0];
    writeFileSync(
      join(dir, 'ps5-service-keys.json'),
      JSON.stringify({ [profile.ip]: 'b'.repeat(64) }),
    );
    let pid = 88,
      buildId = 'own-fixture',
      calls = [];
    globalThis.fetch = async (url, options) => {
      const path = new URL(url).pathname;
      calls.push(path);
      assert.equal(options.method, 'GET', 'a status refresh never mutates the console');
      await new Promise((resolve) => setTimeout(resolve, 2));
      const body =
        path === '/health'
          ? {
              apiVersion: 'v1',
              pid,
              firmwareRead: true,
              firmwareRaw: '0x13600007',
              serviceReport: {
                service: 'PackageFlowService-PS5',
                platform: 'ps5',
                consoleVerified: true,
                version: '0.1.26-dev',
                buildId,
              },
            }
          : path === '/api/v1/capabilities'
            ? { service: 'PackageFlowService-PS5', capabilities: { backgroundService: true } }
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
                    freeBytes: 4096,
                    totalBytes: 8192,
                    transferStorageRead: true,
                    transferFreeBytes: 3072,
                  }
                : assert.fail(`unexpected route ${path}`);
      return new Response(JSON.stringify(body));
    };
    const full = (await api.probeConsoleProfile(profile.id)).consoles[0];
    assert.ok(full.capabilities.formats.includes('pkg'));
    assert.equal(full.servicePid, 88);
    assert.equal(full.serviceBuild, 'own-fixture');
    assert.equal(full.freeBytes, 4096);
    assert.equal(full.totalBytes, 8192);
    assert.equal(full.transferFreeBytes, 3072);
    const queueDir = join(dir, 'consoles', profile.id);
    mkdirSync(queueDir, { recursive: true });
    const queuePath = join(queueDir, 'ps5-installation-queue.json');
    const queue = { status: 'running', items: [{ state: 'sending', size: 8192, bytesSent: 4096 }] };
    writeFileSync(queuePath, JSON.stringify(queue));
    const original = readFileSync(queuePath, 'utf8');
    calls = [];
    const active = (await api.probeConsoleProfile(profile.id, true)).consoles[0];
    assert.deepEqual(calls, ['/health', '/api/v1/capabilities', '/api/v1/system']);
    assert.equal(active.online, true);
    assert.equal(active.paired, true);
    assert.equal(active.capabilitiesDeferred, true);
    assert.deepEqual(active.capabilities.formats, full.capabilities.formats);
    assert.equal(
      readFileSync(queuePath, 'utf8'),
      original,
      "status reads cannot change the user's queue",
    );
    calls = [];
    await api.refreshConsoleProfile(profile.id);
    assert.ok(
      calls.includes('/api/v1/install/readiness'),
      'an explicit full check cannot reuse deferred readiness',
    );
    pid++;
    calls = [];
    const replaced = (await api.probeConsoleProfile(profile.id, true)).consoles[0];
    assert.equal(replaced.paired, true);
    assert.deepEqual(replaced.capabilities.formats, []);
    assert.ok(!calls.includes('/api/v1/install/readiness'));
    await api.probeConsoleProfile(profile.id);
    buildId = 'different-build-same-pid';
    assert.deepEqual(
      (await api.probeConsoleProfile(profile.id, true)).consoles[0].capabilities.formats,
      [],
    );
    calls = [];
    await Promise.all([
      api.refreshConsoleProfile(profile.id, true, true),
      api.refreshConsoleProfile(profile.id, true, true),
    ]);
    assert.equal(
      calls.filter((path) => path === '/health').length,
      1,
      'duplicate background callers share one probe',
    );
    queue.status = 'cancelled';
    writeFileSync(queuePath, JSON.stringify(queue));
    calls = [];
    const idle = (await api.probeConsoleProfile(profile.id, true)).consoles[0];
    assert.ok(calls.includes('/api/v1/install/readiness'));
    assert.ok(idle.capabilities.formats.includes('pkg'));
    assert.equal(idle.capabilitiesDeferred, false);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = oldData;
    rmSync(dir, { recursive: true, force: true });
  }
});
