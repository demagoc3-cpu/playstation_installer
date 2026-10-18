import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { streamedBody } from './fixtures/streamed-body.mjs';
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
      firmware = '0x13600007',
      knownEmbedded = false,
      healthReads = 0,
      healthStatus = 200,
      healthPidMissing = false,
      restartedField,
      hello = {
        ok: true,
        version: '1.4.0',
        fw: '13',
        state: 'ready',
        init_rc: 0,
        escalated: true,
      };
    const calls = [],
      transferred = [];
    let durable = 0,
      transferHash,
      transferId,
      jobStatus = 200;
    const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
    globalThis.fetch = async (url, options = {}) => {
      options = await streamedBody(options);
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
      if (path === '/health') {
        healthReads++;
        return response(
          {
            apiVersion: 'v1',
            firmwareRead: true,
            firmwareRaw: firmware,
            ...(knownEmbedded
              ? {
                  pid: healthPidMissing
                    ? undefined
                    : restartedField === 'pid' && healthReads === 2
                      ? 98
                      : 97,
                  startedAt:
                    restartedField === 'startedAt' && healthReads === 2 ? 1792146535 : 1792146534,
                  backend: 'embedded',
                  pkgBackendVersion: '1.4.0-embedded-029',
                }
              : {}),
            serviceReport: {
              service: ready.service,
              platform: 'ps5',
              consoleVerified: true,
              ...(knownEmbedded
                ? { version: '0.1.29-dev', buildId: 'ps5-service-pkg-context-029c-sse2' }
                : {}),
            },
          },
          healthStatus,
        );
      }
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
      if (path === '/api/v1/installer/status') return response(hello);
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
    assert.deepEqual(calls, ['/health', '/api/v1/install/readiness']);
    assert.equal(
      item.hash,
      undefined,
      'unavailable installer is detected before reading/hash/transfer',
    );
    readiness = {
      ...ready,
      ready: false,
      reason: 'embedded_backend_not_verified',
      formats: [],
      platforms: [],
      folder: {
        schemaVersion: 1,
        route: 'staged-folder',
        ready: true,
        platforms: ['ps5'],
        verificationWindow: 2,
        streamProtocol: 'folder-stream-v2',
        storageCopies: 1,
        streamingHash: true,
      },
      images: {
        schemaVersion: 1,
        route: 'staged-image',
        ready: true,
        reason: 'ready',
        protocol: 'image-registration-v1',
        backend: 'ShadowMountPlus-1.7beta3',
        registrationReceipt: true,
        platforms: ['ps5'],
        formats: ['ufs2', 'exfat', 'pfs', 'ffpfsc'],
      },
    };
    profiles = (await api.probeConsoleProfile(ps5.id)).consoles;
    const embedded = profiles[1].capabilities;
    assert.equal(embedded.installation.reason, 'embedded_backend_not_verified');
    assert.equal(
      embedded.installation.ready,
      false,
      'legacy daemon capability flags cannot qualify the embedded PKG backend',
    );
    assert.equal(embedded.installPs4, false, 'PS4 PKG on PS5 also waits for the embedded backend');
    assert.equal(
      embedded.installPs5,
      true,
      'independent Folder/image installation remains available',
    );
    assert.equal(embedded.folder.ready, true);
    assert.equal(embedded.images.ready, true);
    assert.deepEqual(embedded.formats, ['folder', 'ufs2', 'exfat', 'pfs', 'ffpfsc']);
    assert.equal(
      api.ps5PkgInstallMessage(embedded),
      'Встроенная установка PKG ещё не проверена на этой PS5',
    );
    calls.length = 0;
    const embeddedWaiting = await driver.run(item, signal, (patch) => Object.assign(item, patch));
    assert.equal(embeddedWaiting.state, 'waiting');
    assert.equal(embeddedWaiting.detail, 'Встроенная установка PKG ещё не проверена на этой PS5');
    assert.deepEqual(
      calls,
      ['/health', '/api/v1/install/readiness'],
      'unverified embedded PKG never hashes, transfers or installs',
    );
    assert.equal(item.hash, undefined);
    assert.equal(item.bytesSent, 0);
    assert.equal(item.installDispatched, undefined);
    knownEmbedded = true;
    const readyHello = { ...hello };
    for (const invalidHello of [
      { ...readyHello, state: 'unverified' },
      { ...readyHello, ok: 'true' },
      { ...readyHello, init_rc: -1 },
      { ...readyHello, escalated: false },
      { ...readyHello, version: '1.4.1' },
    ]) {
      hello = invalidHello;
      healthReads = 0;
      calls.length = 0;
      const denied = await driver.run(item, signal, (patch) => Object.assign(item, patch));
      assert.equal(denied.state, 'waiting');
      assert.notEqual(denied.detail, 'Установщик PS5 не запущен или недоступен');
      assert.ok(calls.includes('/api/v1/installer/status'));
      assert.ok(!calls.includes('/api/v1/install/readiness'));
      assert.ok(!calls.some((path) => path.startsWith('/api/v1/transfers/')));
      assert.equal(item.hash, undefined, 'invalid live hello is rejected before source hashing');
      assert.equal(item.installDispatched, undefined);
    }
    hello = readyHello;
    for (const field of ['pid', 'startedAt']) {
      restartedField = field;
      healthReads = 0;
      calls.length = 0;
      const denied = await driver.run(item, signal, (patch) => Object.assign(item, patch));
      assert.equal(denied.state, 'waiting');
      assert.deepEqual(calls, ['/health', '/api/v1/installer/status', '/health']);
      assert.equal(item.hash, undefined, `a changed ${field} cannot authorize source hashing`);
      assert.equal(item.bytesSent, 0);
      assert.equal(item.installDispatched, undefined);
    }
    restartedField = undefined;
    for (const invalidHealth of ['missing-pid', 'http-500']) {
      healthPidMissing = invalidHealth === 'missing-pid';
      healthStatus = invalidHealth === 'http-500' ? 500 : 200;
      calls.length = 0;
      const denied = await api.readPs5PkgInstallCapabilities(ps5.id, signal);
      assert.equal(denied.installation.ready, false);
      assert.deepEqual(calls, ['/health'], `${invalidHealth} never falls back to full readiness`);
    }
    healthPidMissing = false;
    healthStatus = 200;
    knownEmbedded = false;
    for (const invalid of [
      null,
      { ...ready, formats: ['pkg', 'ffpfsc'] },
      { ...ready, platforms: [] },
      { ...ready, platforms: ['ps3'] },
      { ...ready, platforms: ['ps5', 'ps4'] },
      { ...ready, ready: 'true' },
      { ...ready, exactVersionReceipt: true },
      { ...ready, route: 'image' },
    ]) {
      assert.equal(api.ps5InstallCapabilities(200, invalid, '13.60').installation.ready, false);
    }
    // Firmware does not gate a route: the running service reports it.
    assert.equal(api.ps5InstallCapabilities(200, ready, '12.60').installation.ready, true);
    assert.equal(
      api.ps5InstallCapabilities(200, { ...ready, platforms: ['ps4'] }, '12.60').installPs4,
      true,
    );
    const fw1220 = api.ps5InstallCapabilities(200, { ...ready, platforms: ['ps5'] }, '12.20');
    assert.equal(fw1220.installation.ready, true);
    assert.equal(fw1220.installPs5, true);
    assert.equal(fw1220.installPs4, false, 'only the platforms the service reports');
    assert.equal(api.ps5InstallCapabilities(200, ready).installation.ready, true);
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
    knownEmbedded = true;
    healthReads = 0;
    calls.length = 0;
    durable = 0;
    transferred.length = 0;
    const embeddedItem = {
      ...indexed,
      packageId: indexed.id,
      transferId: 'e'.repeat(32),
      state: 'pending',
      detail: '',
      bytesSent: 0,
      branch: 'own',
      order: 0,
    };
    const embeddedRunning = await driver.run(embeddedItem, signal, (patch) =>
      Object.assign(embeddedItem, patch),
    );
    assert.equal(embeddedRunning.state, 'installing');
    assert.equal(embeddedItem.installDispatched, true);
    assert.deepEqual(calls.slice(0, 3), ['/health', '/api/v1/installer/status', '/health']);
    assert.ok(
      !calls.includes('/api/v1/install/readiness'),
      'known PKG does not query SMP readiness',
    );
    assert.equal(calls.filter((path) => path === '/api/v1/install/staged').length, 1);
    assert.deepEqual(Buffer.concat(transferred), Buffer.alloc(32));
    hello = { ...readyHello, state: 'unverified' };
    jobStatus = 200;
    calls.length = 0;
    await assert.rejects(
      driver.run(embeddedItem, signal, (patch) => Object.assign(embeddedItem, patch)),
      /Пакет полностью передан установщику/,
    );
    assert.deepEqual(
      calls,
      ['/api/v1/install/status', '/api/v1/installer/job'],
      'an accepted embedded job is reconciled without hello, readiness or install replay',
    );
    hello = readyHello;
    const fixtureFetch = globalThis.fetch,
      profilePath = join(data, 'console-profiles.json'),
      originalProfiles = readFileSync(profilePath, 'utf8'),
      keysPath = join(data, 'ps5-service-keys.json'),
      originalKeys = readFileSync(keysPath, 'utf8'),
      changedIp = '192.168.1.6',
      changedProfiles = JSON.parse(originalProfiles);
    changedProfiles.consoles.find((profile) => profile.id === ps5.id).ip = changedIp;
    writeFileSync(
      keysPath,
      JSON.stringify({ ...JSON.parse(originalKeys), [changedIp]: 'b'.repeat(64) }),
    );
    const identicalHealth = await (await fixtureFetch(`http://${ps5.ip}:8095/health`)).json();
    for (const changeDuring of ['/health', '/api/v1/installer/status']) {
      const contacted = [];
      globalThis.fetch = async (url, options) => {
        const address = new URL(url);
        contacted.push(address.hostname);
        if (address.hostname === changedIp)
          return response(address.pathname === '/health' ? identicalHealth : readyHello);
        const reply = await fixtureFetch(url, options);
        if (address.pathname === changeDuring)
          writeFileSync(profilePath, JSON.stringify(changedProfiles));
        return reply;
      };
      try {
        const denied = await api.readPs5PkgInstallCapabilities(ps5.id, signal);
        assert.equal(denied.installation.ready, false);
        assert.ok(contacted.length > 0);
        assert.ok(
          contacted.every((host) => host === ps5.ip),
          'identical PID/start/build/firmware on another IP must never continue the probe there',
        );
      } finally {
        writeFileSync(profilePath, originalProfiles);
      }
    }
    writeFileSync(keysPath, originalKeys);
    for (const blockedHealth of [1, 2]) {
      let healthCount = 0,
        notifyBlocked;
      const blocked = new Promise((resolve) => {
          notifyBlocked = resolve;
        }),
        controller = new AbortController();
      globalThis.fetch = async (url, options) => {
        if (new URL(url).pathname === '/health' && ++healthCount === blockedHealth)
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), {
              once: true,
            });
            notifyBlocked();
          });
        return fixtureFetch(url, options);
      };
      const pending = api.readPs5PkgInstallCapabilities(ps5.id, controller.signal);
      await blocked;
      let deadline;
      const immediateAbort = new Promise((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(Error('Caller abort waited for the health deadline')),
          500,
        );
      });
      controller.abort();
      try {
        await assert.rejects(Promise.race([pending, immediateAbort]), { name: 'AbortError' });
      } finally {
        clearTimeout(deadline);
      }
    }
    globalThis.fetch = fixtureFetch;
    assert.ok(!JSON.stringify(profiles).includes('b'.repeat(64)));
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.createError = previousError;
    if (previousData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = previousData;
    rmSync(work, { recursive: true, force: true });
  }
});
