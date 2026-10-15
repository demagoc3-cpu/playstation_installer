import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createError } from 'h3';

test('route readiness gates transfers, preserves PS4 and recovers accepted PS5 installs without replay', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-install-ready-'));
  const previousData = process.env.PACKAGEFLOW_DATA_DIR,
    previousFetch = globalThis.fetch,
    previousError = globalThis.createError;
  const data = join(work, 'data');
  mkdirSync(data);
  process.env.PACKAGEFLOW_DATA_DIR = data;
  globalThis.createError = createError;
  try {
    const bundle = join(work, 'test.mjs');
    await build({
      stdin: {
        contents: `export * from './server/utils/console-profiles'; export * from './server/utils/ps5-queue-driver'; export * from './shared/ps5-install-readiness'; export * from './shared/device-eligibility';`,
        resolveDir: resolve('.'),
      },
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const api = await import(pathToFileURL(bundle).href);
    const ps4 = api.saveConsoleProfile({ name: 'PS4', ip: '192.168.1.4', platform: 'ps4' })
      .consoles[0];
    const ps5 = api.saveConsoleProfile({ name: 'PS5', ip: '192.168.1.5', platform: 'ps5' })
      .consoles[1];
    writeFileSync(
      join(data, 'ps4-service-keys.json'),
      JSON.stringify({ [ps4.ip]: 'a'.repeat(32) }),
    );
    writeFileSync(
      join(data, 'ps5-service-keys.json'),
      JSON.stringify({ [ps5.ip]: 'b'.repeat(64) }),
    );
    const source = join(work, 'own.pkg');
    writeFileSync(source, Buffer.alloc(32));
    const indexed = {
      id: 'own',
      title: 'Own package',
      fileName: 'own.pkg',
      platform: 'ps4',
      format: 'pkg',
      size: 32,
      type: 'Игра',
      titleId: 'CUSA95001',
      contentId: 'IV0000-CUSA95001_00-PACKAGEFLOWUI001',
      contentType: 'PS4GD',
      appVersion: '1.00',
      installOrder: 0,
      path: source,
      libraryRoot: work,
      sourceModifiedAt: 1,
      icon: { offset: 0, size: 0 },
      iconSize: 0,
    };
    writeFileSync(
      join(data, 'package-library.json'),
      JSON.stringify({ version: 2, packages: [indexed], deliveries: {} }),
    );
    const ready = {
      service: 'PackageFlowService-PS5',
      schemaVersion: 1,
      route: 'staged-pkg',
      ready: true,
      reason: 'ready',
      formats: ['pkg'],
      platforms: ['ps4', 'ps5'],
      exactVersionReceipt: false,
    };
    let readiness = {
        ...ready,
        ready: false,
        reason: 'installer_unavailable',
        formats: [],
        platforms: [],
      },
      readinessStatus = 200,
      firmware = '0x13600007';
    const calls = [],
      transferred = [];
    let durable = 0,
      transferHash,
      transferId,
      jobStatus = 200;
    const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
    globalThis.fetch = async (url, options = {}) => {
      const address = new URL(url),
        path = address.pathname,
        headers = options.headers;
      calls.push(path);
      if (address.hostname === ps4.ip) {
        assert.equal(address.port, '12801', 'PS4 retains its own API');
        if (path === '/ping')
          return response({ service: 'PackegeFlowService', status: 'ok', version: '0.10.0' });
        if (path === '/system/info')
          return response({ service: 'PackegeFlowService', firmware: { version: '12.50' } });
        if (path === '/storage') return response({ service: 'PackegeFlowService', volumes: [] });
        assert.ok(['/install/capabilities', '/install/session'].includes(path));
        if (path === '/install/session')
          assert.equal(headers.Authorization, `Bearer ${'a'.repeat(32)}`);
        return response({
          service: 'PackegeFlowService',
          installApi: 1,
          ready: true,
          authentication: 'bearer',
          contentTypes: ['PS4GD', 'PS4GP'],
          version: '0.10.0',
        });
      }
      assert.equal(address.hostname, ps5.ip);
      assert.equal(address.port, '8095');
      if (path === '/health')
        return response({
          apiVersion: 'v1',
          firmwareRead: true,
          firmwareRaw: firmware,
          serviceReport: { service: ready.service, platform: 'ps5', consoleVerified: true },
        });
      assert.equal(headers.Authorization, `Bearer ${'b'.repeat(64)}`);
      if (path === '/api/v1/capabilities')
        return response({
          service: ready.service,
          capabilities: { installPs4Pkg: true, installPs5Content: true, backgroundService: false },
        });
      if (path === '/api/v1/system')
        return response({
          service: ready.service,
          storageRead: true,
          freeBytes: 1000000,
          totalBytes: 2000000,
        });
      if (path === '/api/v1/install/readiness') return response(readiness, readinessStatus);
      if (path === '/api/v1/management/status')
        return response({ protocol: 'ps5-management-v1', ready: true, catalog: true });
      if (path === '/api/v1/console/catalog')
        return response({ revision: 'd'.repeat(64), entries: [], next: 0, done: true });
      if (path.startsWith('/api/v1/transfers/')) {
        transferId = headers['X-PackageFlow-Transfer-Id'];
        if (path.endsWith('/begin')) transferHash = headers['X-PackageFlow-Blake3'];
        if (path.endsWith('/chunk')) {
          assert.equal(Number(headers['X-PackageFlow-Offset']), durable);
          transferred.push(Buffer.from(options.body));
          durable += options.body.length;
        }
        return response({
          id: transferId,
          blake3: transferHash,
          size: indexed.size,
          bytesDurable: durable,
          cancelled: false,
          verified: durable === indexed.size,
        });
      }
      if (path === '/api/v1/install/staged') return response({ ok: true }, 202);
      if (path === '/api/v1/install/status') return response({ ok: true, job: '123' });
      if (path === '/api/v1/installer/job') return response({ ok: true, phase: 'done' }, jobStatus);
      assert.fail(`Unexpected route ${path}`);
    };
    let profiles = (await api.probeConsoleProfile(ps4.id)).consoles;
    assert.deepEqual(profiles[0].capabilities.formats, ['pkg']);
    assert.equal(profiles[0].paired, true);
    profiles = (await api.probeConsoleProfile(ps5.id)).consoles;
    assert.equal(
      profiles[1].capabilities.installation.ready,
      false,
      'global flags do not bypass route readiness',
    );
    assert.deepEqual(profiles[1].capabilities.formats, []);
    assert.equal(
      api.deviceInstallReason(profiles[1], [indexed], 64),
      '',
      'qualified PKG admission allows choosing the console while the worker independently waits for readiness',
    );
    const item = {
      ...indexed,
      packageId: indexed.id,
      transferId: 'c'.repeat(32),
      state: 'pending',
      detail: '',
      bytesSent: 0,
      branch: 'own',
      order: 0,
    };
    const driver = api.ps5QueueDriver(ps5.id),
      signal = new AbortController().signal;
    calls.length = 0;
    const waiting = await driver.run(item, signal, (patch) => Object.assign(item, patch));
    assert.equal(waiting.state, 'waiting');
    assert.deepEqual(calls, ['/api/v1/install/readiness']);
    assert.equal(
      item.hash,
      undefined,
      'unavailable installer is detected before reading/hash/transfer',
    );
    for (const invalid of [
      null,
      { ...ready, formats: ['pkg', 'ffpfsc'] },
      { ...ready, platforms: ['ps5'] },
      { ...ready, ready: 'true' },
      { ...ready, exactVersionReceipt: true },
      { ...ready, route: 'image' },
    ]) {
      assert.equal(api.ps5InstallCapabilities(200, invalid, '13.60').installation.ready, false);
    }
    assert.equal(api.ps5InstallCapabilities(200, ready, '12.60').installation.ready, false);
    assert.equal(
      api.ps5InstallCapabilities(200, { ...ready, platforms: ['ps4'] }, '12.60').installPs4,
      true,
    );
    assert.equal(api.ps5InstallCapabilities(200, ready).installation.ready, false);
    readinessStatus = 404;
    profiles = (await api.probeConsoleProfile(ps5.id)).consoles;
    assert.equal(profiles[1].capabilities.installation.reason, 'service_update_required');
    readiness = ready;
    readinessStatus = 200;
    profiles = (await api.probeConsoleProfile(ps5.id)).consoles;
    assert.equal(profiles[1].capabilities.installation.ready, true);
    assert.equal(api.deviceInstallReason(profiles[1], [indexed], 64), '');
    assert.equal(profiles[0].capabilities.installPs4, true, 'PS5 readiness does not affect PS4');
    const running = await driver.run(item, signal, (patch) => Object.assign(item, patch));
    assert.equal(running.state, 'installing');
    assert.equal(item.installDispatched, true);
    assert.deepEqual(Buffer.concat(transferred), Buffer.alloc(32));
    const dispatches = calls.filter((path) => path === '/api/v1/install/staged').length;
    assert.equal(dispatches, 1);
    readinessStatus = 404;
    calls.length = 0;
    await assert.rejects(
      driver.run(item, signal, (patch) => Object.assign(item, patch)),
      /Пакет полностью передан установщику/,
    );
    assert.deepEqual(
      calls,
      ['/api/v1/install/status', '/api/v1/installer/job'],
      'recovery polls receipt even if admission vanished; no transfer/install replay',
    );
    jobStatus = 400;
    await assert.rejects(
      driver.run(item, signal, (patch) => Object.assign(item, patch)),
      /Не удалось прочитать системное задание/,
    );
    assert.equal(
      calls.filter((path) => path === '/api/v1/install/staged').length,
      0,
      'read error never becomes a second install',
    );
    assert.ok(!JSON.stringify(profiles).includes('b'.repeat(64)));
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.createError = previousError;
    if (previousData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = previousData;
    rmSync(work, { recursive: true, force: true });
  }
});
