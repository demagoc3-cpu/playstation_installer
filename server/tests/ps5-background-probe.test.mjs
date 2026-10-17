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
    assert.deepEqual(calls, [], 'nothing automatic contacts a PS5 that is receiving data');
    assert.equal(active.online, true);
    assert.equal(active.paired, true);
    assert.deepEqual(active.capabilities.formats, full.capabilities.formats);
    assert.equal(active.freeBytes, 4096, 'the last snapshot is kept');
    assert.equal(active.transferFreeBytes, 3072);
    assert.equal(
      readFileSync(queuePath, 'utf8'),
      original,
      "status reads cannot change the user's queue",
    );
    calls = [];
    await Promise.all([
      api.refreshConsoleProfile(profile.id, true, true),
      api.refreshConsoleProfile(profile.id, true, true),
    ]);
    assert.deepEqual(calls, [], 'forced background refreshes do not contact it either');
    calls = [];
    await api.refreshConsoleProfile(profile.id);
    assert.ok(
      calls.includes('/api/v1/install/readiness'),
      'an explicit full check stays fresh during a transfer',
    );
    pid++;
    calls = [];
    const replacedQuiet = (await api.probeConsoleProfile(profile.id, true)).consoles[0];
    assert.deepEqual(calls, []);
    assert.equal(
      replacedQuiet.servicePid,
      88,
      'a background check cannot learn about a restart mid-transfer',
    );
    const replaced = (await api.probeConsoleProfile(profile.id)).consoles[0];
    assert.equal(replaced.servicePid, 89, 'an explicit check sees the new service process');
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

test('PS5 direct, background and foreground probes share one flight, escalate in order and keep other devices independent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-probe-flight-'));
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
    const first = api.saveConsoleProfile({
      name: 'First',
      ip: '192.168.1.5',
      platform: 'ps5',
    }).consoles[0];
    const second = api.saveConsoleProfile({
      name: 'Second',
      ip: '192.168.1.6',
      platform: 'ps5',
    }).consoles[1];
    writeFileSync(
      join(dir, 'ps5-service-keys.json'),
      JSON.stringify({
        [first.ip]: 'a'.repeat(64),
        [second.ip]: 'b'.repeat(64),
        '192.168.1.7': 'c'.repeat(64),
      }),
    );
    const ready = {
      service: 'PackageFlowService-PS5',
      schemaVersion: 1,
      route: 'staged-pkg',
      exactVersionReceipt: false,
      ready: true,
      reason: 'ready',
      formats: ['pkg'],
      platforms: ['ps4', 'ps5'],
    };
    const healthCalls = new Map();
    let blockReadiness = true,
      failReadiness = false,
      releaseReadiness,
      enteredReadiness;
    const readinessGate = new Promise((resolve) => (releaseReadiness = resolve));
    const readinessEntered = new Promise((resolve) => (enteredReadiness = resolve));
    const healthHolds = new Map();
    const holdHealth = (ip, fail = false) => {
      let release, enter;
      const gate = new Promise((resolve) => (release = resolve));
      const entered = new Promise((resolve) => (enter = resolve));
      healthHolds.set(ip, { gate, enter, fail });
      return { entered, release };
    };
    globalThis.fetch = async (url, options) => {
      const { hostname: ip, pathname: path } = new URL(url);
      assert.equal(options.method, 'GET');
      if (path === '/health') {
        healthCalls.set(ip, (healthCalls.get(ip) || 0) + 1);
        const hold = healthHolds.get(ip);
        if (hold) {
          healthHolds.delete(ip);
          hold.enter();
          await hold.gate;
          if (hold.fail) throw Error('older health timed out');
        }
        return new Response(
          JSON.stringify({
            apiVersion: 'v1',
            pid: ip === second.ip ? 102 : 101,
            firmwareRead: true,
            firmwareRaw: '0x13600007',
            serviceReport: {
              service: ready.service,
              platform: 'ps5',
              consoleVerified: true,
              buildId: 'own-unified-fixture',
              capabilities: { installPs4Pkg: false, installPs5Content: false },
            },
          }),
        );
      }
      if (path === '/api/v1/capabilities')
        return new Response(
          JSON.stringify({
            service: ready.service,
            capabilities: { installPs4Pkg: false, installPs5Content: false },
          }),
        );
      if (path === '/api/v1/install/readiness') {
        if (ip === first.ip && blockReadiness) {
          blockReadiness = false;
          enteredReadiness();
          await readinessGate;
        }
        if (failReadiness) throw Error('readiness timed out');
        return new Response(JSON.stringify(ready));
      }
      assert.equal(path, '/api/v1/system');
      return new Response(
        JSON.stringify({
          service: ready.service,
          storageRead: true,
          freeBytes: 4096,
          totalBytes: 8192,
        }),
      );
    };
    const background = api.probeConsoleProfile(first.id, true);
    await readinessEntered;
    const full = api.probeConsoleProfile(first.id),
      joinedBackground = api.refreshConsoleProfile(first.id, true, true),
      joinedFull = api.refreshConsoleProfile(first.id, true),
      joinedDirect = api.probeConsoleProfile(first.id);
    const other = (await api.probeConsoleProfile(second.id)).consoles.find(
      (p) => p.id === second.id,
    );
    assert.equal(other.online, true, 'another PS5 does not wait for the first device');
    assert.equal(healthCalls.get(first.ip), 1, 'foreground waits for the current PS5 request');
    releaseReadiness();
    await Promise.all([background, full, joinedBackground, joinedFull, joinedDirect]);
    assert.equal(healthCalls.get(first.ip), 2, 'one background and one fresh foreground flight');
    const current = api.getConsoleProfiles().consoles.find((p) => p.id === first.id);
    assert.equal(current.online, true);
    assert.equal(current.capabilities.installation.ready, true);
    assert.deepEqual(
      current.capabilities.formats,
      ['pkg'],
      'static legacy flags cannot deny readiness',
    );
    failReadiness = true;
    const waiting = (await api.probeConsoleProfile(first.id)).consoles.find(
      (p) => p.id === first.id,
    );
    assert.equal(waiting.online, true, 'failed readiness is not a failed health response');
    assert.equal(waiting.paired, true);
    assert.equal(waiting.capabilities.installation.ready, false);
    assert.equal(waiting.capabilities.installation.reason, 'readiness_unavailable');
    failReadiness = false;

    // A profile file can be reloaded by another desktop session while a probe is
    // outstanding. Returning to its original address must not revive that probe.
    const changeAddress = (ip) => {
      const file = join(dir, 'console-profiles.json');
      const stored = JSON.parse(readFileSync(file, 'utf8'));
      stored.consoles.find((p) => p.id === first.id).ip = ip;
      writeFileSync(file, JSON.stringify(stored));
    };
    const oldHold = holdHealth(first.ip, true);
    const old = api.probeConsoleProfile(first.id);
    await oldHold.entered;
    changeAddress('192.168.1.7');
    await api.probeConsoleProfile(first.id);
    changeAddress(first.ip);
    await api.probeConsoleProfile(first.id);
    oldHold.release();
    await old;
    assert.equal(
      api.getConsoleProfiles().consoles.find((p) => p.id === first.id).online,
      true,
      'an older failed probe cannot overwrite the newer successful generation',
    );
    const queuedOldHold = holdHealth(first.ip, true),
      newHold = holdHealth('192.168.1.7');
    const beforeQueued = healthCalls.get(first.ip);
    const oldBackground = api.probeConsoleProfile(first.id, true);
    await queuedOldHold.entered;
    const queuedForeground = api.probeConsoleProfile(first.id);
    changeAddress('192.168.1.7');
    const newAddress = api.probeConsoleProfile(first.id);
    await newHold.entered;
    queuedOldHold.release();
    await Promise.all([oldBackground, queuedForeground]);
    assert.equal(
      healthCalls.get(first.ip),
      beforeQueued + 1,
      'a queued foreground probe for the old address never contacts that address again',
    );
    newHold.release();
    await newAddress;
    const updated = api.getConsoleProfiles().consoles.find((p) => p.id === first.id);
    assert.equal(updated.ip, '192.168.1.7');
    assert.equal(updated.online, true, 'a stale queued probe cannot invalidate the new address');
    assert.equal(updated.capabilities.installation.ready, true);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = oldData;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('while a PS5 receives data, background refreshes never contact it; afterwards the 15 s interval resumes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-sending-interval-'));
  const oldData = process.env.PACKAGEFLOW_DATA_DIR,
    oldFetch = globalThis.fetch,
    realNow = Date.now;
  process.env.PACKAGEFLOW_DATA_DIR = dir;
  let offset = 0;
  Date.now = () => realNow() + offset;
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
    const profile = api.saveConsoleProfile({ name: 'Own', ip: '192.168.1.8', platform: 'ps5' })
      .consoles[0];
    writeFileSync(
      join(dir, 'ps5-service-keys.json'),
      JSON.stringify({ [profile.ip]: 'd'.repeat(64) }),
    );
    let calls = [];
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      calls.push(path);
      const body =
        path === '/health'
          ? {
              apiVersion: 'v1',
              pid: 7,
              firmwareRead: true,
              firmwareRaw: '0x13600007',
              serviceReport: {
                service: 'PackageFlowService-PS5',
                platform: 'ps5',
                consoleVerified: true,
                version: '0.1.26-dev',
                buildId: 'own-interval',
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
              : {
                  service: 'PackageFlowService-PS5',
                  storageRead: true,
                  freeBytes: 1,
                  totalBytes: 2,
                };
      return new Response(JSON.stringify(body));
    };
    await api.refreshConsoleProfile(profile.id, false, true);
    const queueDir = join(dir, 'consoles', profile.id);
    mkdirSync(queueDir, { recursive: true });
    const queuePath = join(queueDir, 'ps5-installation-queue.json');
    writeFileSync(
      queuePath,
      JSON.stringify({ status: 'running', items: [{ state: 'sending', size: 8, bytesSent: 4 }] }),
    );
    calls = [];
    for (const step of [20000, 41000, 600000]) {
      offset += step;
      await api.refreshConsoleProfile(profile.id, false, true);
    }
    assert.deepEqual(calls, [], 'no request during a long transfer, not even /health');
    writeFileSync(
      queuePath,
      JSON.stringify({
        status: 'completed',
        items: [{ state: 'installed', size: 8, bytesSent: 8 }],
      }),
    );
    calls = [];
    offset += 16000;
    await api.refreshConsoleProfile(profile.id, false, true);
    assert.ok(
      calls.includes('/api/v1/system'),
      'without a transfer the 15 s background interval is unchanged',
    );
  } finally {
    Date.now = realNow;
    globalThis.fetch = oldFetch;
    if (oldData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = oldData;
    rmSync(dir, { recursive: true, force: true });
  }
});
