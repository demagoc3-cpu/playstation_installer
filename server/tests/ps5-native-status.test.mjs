import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createError } from 'h3';

test('native status refreshes an expired console without a WEB tab and coalesces probes', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-native-status-'));
  const previousData = process.env.PACKAGEFLOW_DATA_DIR,
    previousNow = Date.now;
  const names = ['fetch', 'createError', 'defineEventHandler', 'getQuery', 'setHeader'];
  const previous = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  let time = previousNow(),
    consoleId,
    healthy = true,
    healthReads = 0;
  process.env.PACKAGEFLOW_DATA_DIR = join(work, 'data');
  mkdirSync(process.env.PACKAGEFLOW_DATA_DIR);
  Date.now = () => time;
  globalThis.createError = createError;
  globalThis.defineEventHandler = (handler) => handler;
  globalThis.getQuery = () => ({ consoleId });
  globalThis.setHeader = () => {};
  try {
    const bundle = join(work, 'integration.mjs');
    await build({
      stdin: {
        contents: `export { default as status } from './server/api/catalog/v2/status.get'; export * from './server/utils/console-profiles';`,
        resolveDir: resolve('.'),
      },
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const api = await import(pathToFileURL(bundle).href);
    const profile = api.saveConsoleProfile({ name: 'PS5', ip: '192.168.1.5', platform: 'ps5' })
      .consoles[0];
    consoleId = profile.id;
    globalThis.fetch = async (url, options) => {
      if (!healthy) throw new Error('Disconnected test console');
      const path = new URL(url).pathname;
      const response = (body) => new Response(JSON.stringify(body));
      if (path === '/health') {
        healthReads++;
        return response({
          apiVersion: 'v1',
          pairingMode: 'automatic',
          firmwareRead: true,
          firmwareRaw: '0x13600007',
          serviceReport: {
            service: 'PackageFlowService-PS5',
            platform: 'ps5',
            consoleVerified: true,
            version: '0.1.3-dev',
          },
        });
      }
      if (path === '/api/v1/pair')
        return response({ apiVersion: 'v1', pairingMode: 'automatic', token: 'b'.repeat(64) });
      assert.equal(options.headers.Authorization, `Bearer ${'b'.repeat(64)}`);
      if (path === '/api/v1/system')
        return response({
          service: 'PackageFlowService-PS5',
          storageRead: true,
          freeBytes: 8000000,
          totalBytes: 10000000,
        });
      return response({
        service: 'PackageFlowService-PS5',
        capabilities: { installPs4Pkg: false, installPs5Content: false },
      });
    };
    await api.pairConsoleProfile(profile.id, 'http://192.168.1.2:3000');
    time += 61000;
    assert.equal(api.getConsoleProfiles().consoles[0].online, false);
    const before = healthReads;
    const results = await Promise.all(Array.from({ length: 8 }, () => api.status({})));
    assert.ok(
      results.every((result) => result.online && result.paired && result.firmware === '13.60'),
    );
    assert.equal(healthReads, before + 1, 'simultaneous native polls share one console probe');
    await api.status({});
    assert.equal(healthReads, before + 1, 'fresh snapshot avoids network traffic');
    healthy = false;
    time += 16000;
    assert.equal((await api.status({})).online, false, 'a disconnected console is not kept online');
  } finally {
    Date.now = previousNow;
    for (const name of names) {
      if (previous[name] === undefined) delete globalThis[name];
      else globalThis[name] = previous[name];
    }
    if (previousData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = previousData;
    rmSync(work, { recursive: true, force: true });
  }
});

test('known embedded status stays basic while native catalog learns full formats once per process and cache window', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-native-embedded-'));
  const oldData = process.env.PACKAGEFLOW_DATA_DIR,
    oldNow = Date.now;
  const names = ['fetch', 'createError', 'defineEventHandler', 'getQuery', 'setHeader'];
  const previous = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  process.env.PACKAGEFLOW_DATA_DIR = join(work, 'data');
  mkdirSync(process.env.PACKAGEFLOW_DATA_DIR);
  let time = oldNow(),
    consoleId,
    pid = 97,
    startedAt = 1792146534,
    fullCalls = 0,
    helloCalls = 0,
    consoleRequests = 0;
  let fullReady = true,
    pairAccepted = true,
    storageRead = true,
    heldHello,
    helloState = 'ready';
  Date.now = () => time;
  globalThis.createError = createError;
  globalThis.defineEventHandler = (handler) => handler;
  globalThis.getQuery = () => ({ consoleId });
  globalThis.setHeader = () => {};
  try {
    const bundle = join(work, 'native.mjs');
    await build({
      stdin: {
        contents: `export {default as status} from './server/api/catalog/v2/status.get'; export {default as index} from './server/api/catalog/v2/index.get'; export * from './server/utils/console-profiles'; export {ps5PkgQueueSupported} from './shared/device-eligibility';`,
        resolveDir: resolve('.'),
      },
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const api = await import(pathToFileURL(bundle).href);
    const profile = api.saveConsoleProfile({ name: 'PS5', ip: '192.168.1.5', platform: 'ps5' })
      .consoles[0];
    consoleId = profile.id;
    writeFileSync(
      join(process.env.PACKAGEFLOW_DATA_DIR, 'ps5-service-keys.json'),
      JSON.stringify({ [profile.ip]: 'b'.repeat(64) }),
    );
    writeFileSync(
      join(process.env.PACKAGEFLOW_DATA_DIR, 'package-library.json'),
      JSON.stringify({ version: 2, packages: [], deliveries: {} }),
    );
    const full = () => ({
      service: 'PackageFlowService-PS5',
      schemaVersion: 1,
      route: 'staged-pkg',
      exactVersionReceipt: false,
      ready: true,
      reason: 'ready',
      formats: ['pkg'],
      platforms: ['ps4', 'ps5'],
      folder: {
        schemaVersion: 1,
        route: 'staged-folder',
        ready: fullReady,
        platforms: fullReady ? ['ps5'] : [],
        streamProtocol: 'folder-stream-v2',
        storageCopies: 1,
        streamingHash: true,
      },
      images: {
        schemaVersion: 1,
        route: 'staged-image',
        ready: fullReady,
        reason: fullReady ? 'ready' : 'backend_not_verified_or_unavailable',
        protocol: 'image-registration-v1',
        backend: 'ShadowMountPlus-1.7beta3',
        registrationReceipt: fullReady,
        platforms: fullReady ? ['ps5'] : [],
        formats: fullReady ? ['ufs2', 'exfat', 'pfs', 'ffpfsc'] : [],
      },
    });
    globalThis.fetch = async (url, options) => {
      consoleRequests++;
      const path = new URL(url).pathname;
      assert.equal(options.method, 'GET');
      let body,
        status = 200;
      if (path === '/health')
        body = {
          apiVersion: 'v1',
          pid,
          startedAt,
          firmwareRead: true,
          firmwareRaw: '0x13600007',
          backend: 'embedded',
          pkgBackendVersion: '1.4.0-embedded-029',
          serviceReport: {
            service: 'PackageFlowService-PS5',
            platform: 'ps5',
            consoleVerified: true,
            version: '0.1.29-dev',
            buildId: 'ps5-service-pkg-context-029c-sse2',
          },
        };
      else {
        assert.equal(options.headers.Authorization, 'Bearer ' + 'b'.repeat(64));
        if (path === '/api/v1/capabilities') {
          if (!pairAccepted) status = 401;
          body = {
            service: 'PackageFlowService-PS5',
            capabilities: { installPs4Pkg: false, installPs5Content: false },
          };
        } else if (path === '/api/v1/installer/status') {
          helloCalls++;
          if (helloState === 'unavailable') status = 503;
          if (heldHello) {
            const hold = heldHello;
            heldHello = undefined;
            hold.enter();
            await hold.gate;
          }
          body = {
            ok: true,
            version: '1.4.0',
            fw: '13',
            state: helloState,
            init_rc: 0,
            escalated: true,
          };
        } else if (path === '/api/v1/system')
          body = {
            service: 'PackageFlowService-PS5',
            storageRead,
            freeBytes: 8000000,
            totalBytes: 10000000,
          };
        else {
          assert.equal(path, '/api/v1/install/readiness');
          fullCalls++;
          body = full();
        }
      }
      return new Response(JSON.stringify(body), { status });
    };
    const cold = await api.status({});
    assert.equal(cold.online, true);
    assert.equal(cold.paired, true);
    assert.deepEqual(cold.capabilities.formats, ['pkg']);
    assert.equal(fullCalls, 0, 'cold status never asks SMP for Folder/image readiness');
    assert.equal(helloCalls, 1);
    let catalog = await api.index({});
    assert.deepEqual(catalog.capabilities.formats, [
      'pkg',
      'folder',
      'ufs2',
      'exfat',
      'pfs',
      'ffpfsc',
    ]);
    assert.equal(
      fullCalls,
      1,
      'cold native catalog obtains real routes before the 044 client format gate',
    );
    await Promise.all(Array.from({ length: 8 }, () => api.index({})));
    assert.equal(fullCalls, 1, 'pagination shares the completed full check');
    time += 16000;
    assert.ok(
      (await api.status({})).capabilities.formats.includes('folder'),
      'same-process basic polling retains confirmed formats',
    );
    assert.equal(fullCalls, 1);
    await Promise.all(Array.from({ length: 8 }, () => api.index({})));
    assert.equal(fullCalls, 2, 'only one full refresh runs after its completed cache expires');
    fullReady = false;
    time += 16000;
    await api.status({});
    catalog = await api.index({});
    assert.deepEqual(
      catalog.capabilities.formats,
      ['pkg'],
      'a complete negative Folder/image check is not invented support',
    );
    await api.index({});
    assert.equal(
      fullCalls,
      3,
      'a negative completed check also avoids repeated synchronous probing',
    );
    const queueDir = join(process.env.PACKAGEFLOW_DATA_DIR, 'consoles', profile.id);
    mkdirSync(queueDir, { recursive: true });
    const queuePath = join(queueDir, 'ps5-installation-queue.json');
    writeFileSync(
      queuePath,
      JSON.stringify({ status: 'running', items: [{ state: 'sending', size: 10, bytesSent: 1 }] }),
    );
    const beforeHello = helloCalls,
      beforeRequests = consoleRequests;
    time += 16000;
    await api.status({});
    await api.index({});
    assert.equal(
      helloCalls,
      beforeHello,
      'background and catalog never compete with an active transfer via hello',
    );
    assert.equal(fullCalls, 3, 'native catalog defers SMP during data transfer');
    assert.equal(
      consoleRequests,
      beforeRequests,
      'automatic status and catalog reads send nothing to a PS5 receiving data, not even /health',
    );
    pid++;
    time += 16000;
    await api.status({});
    assert.equal(consoleRequests, beforeRequests, 'still nothing while the transfer runs');
    // A restarted service ends the transfer; the first automatic check after it
    // sees the new process, which cannot inherit the earlier readiness.
    writeFileSync(
      queuePath,
      JSON.stringify({ status: 'failed', items: [{ state: 'failed', size: 10, bytesSent: 1 }] }),
    );
    time += 16000;
    const afterTransfer = await api.status({});
    assert.equal(
      helloCalls,
      beforeHello + 1,
      'a replacement process cannot inherit readiness: it is proven again by its own hello',
    );
    assert.deepEqual(afterTransfer.capabilities.formats, ['pkg']);
    writeFileSync(queuePath, JSON.stringify({ status: 'cancelled', items: [] }));
    fullReady = true;
    catalog = await api.index({});
    assert.ok(
      catalog.capabilities.formats.includes('folder'),
      'a later explicit catalog restores reachable Folder/image review',
    );
    assert.equal(fullCalls, 4);
    startedAt++;
    time += 16000;
    assert.deepEqual(
      (await api.status({})).capabilities.formats,
      ['pkg'],
      'same PID with another start time loses full readiness',
    );
    assert.ok((await api.index({})).capabilities.formats.includes('folder'));
    assert.equal(fullCalls, 5);
    for (const background of [true, false]) {
      let enter, release;
      const entered = new Promise((resolve) => (enter = resolve));
      const gate = new Promise((resolve) => (release = resolve));
      heldHello = { enter, gate };
      const before = fullCalls;
      const partial = api.probeConsoleProfile(profile.id, background, 'pkg');
      await entered;
      const complete = api.probeConsoleProfile(profile.id, false, 'full');
      release();
      await partial;
      const completeProfile = (await complete).consoles.find((p) => p.id === profile.id);
      assert.equal(fullCalls, before + 1, 'foreground full cannot reuse a background/PKG flight');
      assert.ok(completeProfile.capabilities.formats.includes('folder'));
      assert.equal(completeProfile.capabilitiesDeferred, false);
    }
    pairAccepted = false;
    const beforePairing = helloCalls;
    const unpaired = (await api.probeConsoleProfile(profile.id, false, 'pkg')).consoles.find(
      (p) => p.id === profile.id,
    );
    assert.equal(unpaired.online, true);
    assert.equal(
      unpaired.paired,
      false,
      'saved credentials do not stand in for current authentication',
    );
    assert.equal(helloCalls, beforePairing);
    assert.equal(unpaired.freeBytes, undefined);
    pairAccepted = true;
    storageRead = false;
    const noStorage = (await api.probeConsoleProfile(profile.id, false, 'pkg')).consoles.find(
      (p) => p.id === profile.id,
    );
    assert.equal(noStorage.paired, true);
    assert.equal(
      noStorage.freeBytes,
      undefined,
      'fresh failed storage cannot inherit old free space',
    );
    storageRead = true;
    helloState = 'unverified';
    const unverified = (await api.probeConsoleProfile(profile.id, false, 'pkg')).consoles.find(
      (p) => p.id === profile.id,
    );
    assert.equal(unverified.capabilities.installation.reason, 'embedded_backend_not_verified');
    assert.equal(
      api.ps5PkgQueueSupported(unverified, { platform: 'ps5', format: 'pkg' }),
      false,
      'known unverified hello cannot use the legacy installer-unavailable intent exception',
    );
    assert.equal(JSON.stringify(api.getConsoleProfiles()).includes('runtimeIdentity'), false);
    assert.equal(JSON.stringify(api.getConsoleProfiles()).includes('fullCheckedAt'), false);

    fullReady = false;
    const routeFile = join(
      process.env.PACKAGEFLOW_DATA_DIR,
      'consoles',
      profile.id,
      'ps5-qualified-routes.json',
    );
    mkdirSync(join(process.env.PACKAGEFLOW_DATA_DIR, 'consoles', profile.id), {
      recursive: true,
    });
    const activation = {
      schemaVersion: 1,
      consoleId: profile.id,
      ip: profile.ip,
      firmware: '13.60',
      serviceBuild: 'ps5-service-pkg-context-029c-sse2',
      serviceVersion: '0.1.29-dev',
      userEnabledFormats: ['folder', 'ufs2', 'exfat', 'pfs', 'ffpfsc'],
      folderProtocol: 'folder-stream-v2',
      imageProtocol: 'image-registration-v1',
      imageBackend: 'ShadowMountPlus-1.7beta3',
      qualification: {
        folderReceiptId: 'a'.repeat(32),
        streamReceiptId: 'b'.repeat(32),
        imageMarkerSha256: 'c'.repeat(64),
      },
    };
    writeFileSync(routeFile, JSON.stringify(activation), { mode: 0o600 });
    const beforeActivation = fullCalls;
    const activated = (await api.probeConsoleProfile(profile.id)).consoles.find(
      (item) => item.id === profile.id,
    );
    assert.deepEqual(activated.capabilities.formats, activation.userEnabledFormats);
    assert.equal(activated.capabilities.installation.ready, false);
    assert.equal(activated.capabilities.folder.storageCopies, 1);
    assert.equal(activated.capabilities.images.ready, true);
    assert.equal(activated.capabilitiesDeferred, false);
    assert.equal(activated.freeBytes, 8000000);
    assert.equal(fullCalls, beforeActivation, 'explicit activation does not run a mount scan');
    time += 16000;
    const activatedCatalog = (await api.index({})).capabilities;
    assert.deepEqual(activatedCatalog.formats, activation.userEnabledFormats);
    assert.equal(activatedCatalog.install, true);
    assert.equal(activatedCatalog.installation, undefined);
    assert.equal(fullCalls, beforeActivation, 'native full capabilities stay enabled without SMP');

    helloState = 'unavailable';
    const independent = (await api.probeConsoleProfile(profile.id)).consoles.find(
      (item) => item.id === profile.id,
    );
    assert.deepEqual(independent.capabilities.formats, activation.userEnabledFormats);
    assert.equal(independent.capabilities.installation.ready, false);
    assert.equal(fullCalls, beforeActivation, 'content routes do not depend on a PKG hello');
    const independentCatalog = (await api.index({})).capabilities;
    assert.equal(independentCatalog.install, true);
    assert.equal(independentCatalog.formats.includes('pkg'), false);
    assert.equal(independentCatalog.installation, undefined);
    assert.equal(
      independentCatalog.install && independentCatalog.installation?.ready !== false,
      true,
      'native 044 global gate permits content review without advertising PKG readiness',
    );
    assert.equal((await api.status({})).capabilities.installation.ready, false);
    helloState = 'ready';
    for (const altered of [
      { consoleId: 'another-console' },
      { ip: '192.168.1.6' },
      { firmware: '12.60' },
      { serviceBuild: 'another-build' },
      { imageProtocol: 'another-protocol' },
      { userEnabledFormats: ['pkg'] },
      { userEnabledFormats: ['ffpfsc'] },
      { qualification: { ...activation.qualification, imageMarkerSha256: 'bad' } },
    ]) {
      writeFileSync(routeFile, JSON.stringify({ ...activation, ...altered }));
      const rejected = (await api.probeConsoleProfile(profile.id)).consoles.find(
        (item) => item.id === profile.id,
      );
      assert.deepEqual(rejected.capabilities.formats, ['pkg']);
    }
    writeFileSync(routeFile, JSON.stringify(activation));
    pairAccepted = false;
    const deniedActivation = (await api.probeConsoleProfile(profile.id)).consoles.find(
      (item) => item.id === profile.id,
    );
    assert.equal(deniedActivation.paired, false);
    assert.deepEqual(deniedActivation.capabilities.formats, []);
    assert.equal(deniedActivation.freeBytes, undefined);
  } finally {
    Date.now = oldNow;
    for (const name of names) {
      if (previous[name] === undefined) delete globalThis[name];
      else globalThis[name] = previous[name];
    }
    if (oldData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = oldData;
    rmSync(work, { recursive: true, force: true });
  }
});
