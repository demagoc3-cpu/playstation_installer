import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { blake3 } from '@noble/hashes/blake3.js';
import { ps5ParamFixture } from './fixtures/ps5-param-pkg.mjs';

test('production Folder driver passes real HTTP validation, seals bytes and includes a pending v2 plan once in preview', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-folder-production-')),
    oldData = process.env.PACKAGEFLOW_DATA_DIR,
    oldFetch = globalThis.fetch;
  const data = join(work, 'data');
  mkdirSync(data);
  process.env.PACKAGEFLOW_DATA_DIR = data;
  try {
    const file = join(work, 'api.mjs');
    await build({
      stdin: {
        contents:
          "export * from './server/utils/console-profiles';export * from './server/utils/ps5-queue-driver';export * from './server/utils/ps5-installation-queue';export * from './server/utils/device-installation';",
        resolveDir: resolve('.'),
      },
      outfile: file,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const api = await import(pathToFileURL(file).href),
      profile = api.saveConsoleProfile({ name: 'Fixture', ip: '192.168.1.5', platform: 'ps5' })
        .consoles[0];
    writeFileSync(
      join(data, 'ps5-service-keys.json'),
      JSON.stringify({ [profile.ip]: 'a'.repeat(64) }),
    );
    const root = join(work, 'source');
    mkdirSync(join(root, 'sce_sys'), { recursive: true });
    const param = JSON.stringify(ps5ParamFixture());
    writeFileSync(join(root, 'sce_sys/param.json'), param);
    writeFileSync(join(root, 'eboot.bin'), Buffer.alloc(700000, 9));
    const pkg = {
      id: 'folder',
      title: 'Owned Folder',
      fileName: 'source',
      size: 700000 + Buffer.byteLength(param),
      platform: 'ps5',
      format: 'folder',
      type: 'Игра',
      titleId: 'PPSA95001',
      contentId: 'IV0000-PPSA95001_00-PACKAGEFLOWUI001',
      appVersion: '01.000.001',
      installOrder: 0,
      path: root,
      libraryRoot: work,
      iconSize: 0,
      icon: { offset: 0, size: 0 },
    };
    const other = {
      ...pkg,
      id: 'new',
      title: 'Next',
      format: 'pkg',
      size: 1024,
      platform: 'ps4',
      titleId: 'CUSA95002',
      contentId: 'IV0000-CUSA95002_00-OTHER00000000000',
      appVersion: '01.00',
    };
    writeFileSync(
      join(data, 'package-library.json'),
      JSON.stringify({ version: 2, packages: [pkg, other], deliveries: {} }),
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
      folder: {
        schemaVersion: 1,
        route: 'staged-folder',
        ready: true,
        platforms: ['ps5'],
        streamProtocol: 'folder-stream-v2',
        storageCopies: 1,
        streamingHash: true,
      },
    };
    const transfers = new Map(),
      calls = [];
    let published = false,
      activated = false,
      healthReads = 0,
      invalidAuth = false,
      changedRuntime = false;
    const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
    globalThis.fetch = async (url, opts = {}) => {
      const path = new URL(url).pathname,
        h = opts.headers || {};
      calls.push(path);
      if (path === '/health') {
        healthReads++;
        return response({
          apiVersion: 'v1',
          firmwareRead: true,
          firmwareRaw: '0x13600007',
          ...(activated
            ? {
                pid: changedRuntime && healthReads === 2 ? 98 : 97,
                startedAt: 1792146534,
                backend: 'embedded',
                pkgBackendVersion: '1.4.0-embedded-029',
              }
            : {}),
          serviceReport: {
            service: ready.service,
            platform: 'ps5',
            consoleVerified: true,
            ...(activated
              ? { version: '0.1.29-dev', buildId: 'ps5-service-pkg-context-029c-sse2' }
              : {}),
          },
        });
      }
      assert.equal(h.Authorization, 'Bearer ' + 'a'.repeat(64));
      if (path === '/api/v1/capabilities')
        return response({ service: ready.service, capabilities: {} }, invalidAuth ? 401 : 200);
      if (path === '/api/v1/system')
        return response({
          service: ready.service,
          storageRead: true,
          freeBytes: 10 * 1024 ** 3,
          totalBytes: 20 * 1024 ** 3,
        });
      if (path === '/api/v1/install/readiness') return response(ready);
      if (path === '/api/v1/management/status')
        return response({ protocol: 'ps5-management-v1', ready: true, catalog: true });
      if (path === '/api/v1/console/catalog')
        return response({ revision: 'd'.repeat(64), entries: [], next: 0, done: true });
      const id = h['X-PackageFlow-Transfer-Id'];
      let t = transfers.get(id);
      if (path === '/api/v1/transfers/begin') {
        const stream = h['X-PackageFlow-Stream'] === 'folder-stream-v2';
        t = {
          id,
          size: Number(h['X-PackageFlow-Size']),
          blake3: h['X-PackageFlow-Blake3'],
          sourceIdentity: stream ? h['X-PackageFlow-Blake3'] : '',
          hashPending: stream,
          bytesDurable: 0,
          verified: false,
          cancelled: false,
          chunkMax: 262144,
          data: Buffer.alloc(0),
        };
        transfers.set(id, t);
      } else if (path === '/api/v1/transfers/chunk') {
        assert.equal(Number(h['X-PackageFlow-Offset']), t.bytesDurable);
        t.data = Buffer.concat([t.data, Buffer.from(opts.body)]);
        t.bytesDurable = t.data.length;
      } else if (path === '/api/v1/transfers/commit') {
        if (t.hashPending) {
          assert.equal(h['X-PackageFlow-Stream'], 'folder-stream-v2');
          assert.equal(h['X-PackageFlow-Blake3'], Buffer.from(blake3(t.data)).toString('hex'));
          t.blake3 = h['X-PackageFlow-Blake3'];
          t.hashPending = false;
        }
        t.verified = true;
      } else if (path === '/api/v1/folder/commit') {
        assert.ok([...transfers.values()].every((v) => v.verified));
        published = true;
        return response({}, 202);
      } else assert.fail(path);
      const { data: _, ...receipt } = t;
      return response(receipt);
    };
    await api.probeConsoleProfile(profile.id);
    const item = {
      ...pkg,
      packageId: pkg.id,
      order: 0,
      branch: 'ps5:' + pkg.titleId,
      transferId: 'c'.repeat(32),
      bytesSent: 0,
      state: 'pending',
      detail: '',
    };
    const driver = api.ps5QueueDriver(profile.id),
      signal = new AbortController().signal;
    assert.equal(
      (await driver.run(item, signal, (p) => Object.assign(item, p))).state,
      'installing',
    );
    assert.equal(published, true);
    assert.equal(item.bytesSent, pkg.size);
    const planPath = join(data, 'consoles', profile.id, item.transferId + '.folder-plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    assert.equal(plan.version, 2);
    // Restart snapshot before installer dispatch; read-only preview must not wake it.
    writeFileSync(
      join(data, 'consoles', profile.id, 'ps5-installation-queue.json'),
      JSON.stringify({
        version: 1,
        consoleId: profile.id,
        psIp: profile.ip,
        transport: 'service',
        id: 'queue',
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
        message: '',
        items: [{ ...item, installDispatched: false, state: 'sending' }],
        history: [],
      }),
    );
    const publicQueue = api.getPs5Queue(profile.id);
    assert.equal(publicQueue.items[0].transferId, undefined);
    assert.equal(api.getPs5PendingSpaceItems(profile.id)[0].legacyFolder, false);
    const n = calls.length,
      preview = await api.previewDeviceInstall({ packageIds: ['new'] }, [profile.id]),
      d = preview.devices[0];
    assert.equal(d.requiredBytes, pkg.size + 512 * 1024 * 1024 + 2 * other.size);
    assert.equal(d.queueBytes, pkg.size);
    assert.equal(d.selectedBytes, other.size);
    assert.equal(d.eligible, true);
    assert.ok(
      !calls.slice(n).some((path) => path.startsWith('/api/v1/transfers/')),
      'preview is read-only',
    );
    plan.version = 1;
    writeFileSync(planPath, JSON.stringify(plan));
    assert.equal(api.getPs5PendingSpaceItems(profile.id)[0].legacyFolder, true);
    const before = calls.length;
    await assert.rejects(
      api.ps5OperationRequest(profile.id, '/api/v1/transfers/begin', {
        'X-PackageFlow-Unknown': 'x',
      }),
      api.Ps5OperationValidationError,
    );
    assert.equal(calls.length, before, 'unknown headers remain blocked locally');
    writeFileSync(
      join(data, 'consoles', profile.id, 'ps5-qualified-routes.json'),
      JSON.stringify({
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
      }),
    );
    activated = true;
    const activeItem = {
      ...pkg,
      packageId: pkg.id,
      order: 0,
      branch: 'ps5:' + pkg.titleId,
      transferId: 'd'.repeat(32),
      bytesSent: 0,
      state: 'pending',
      detail: '',
    };
    for (const issue of ['auth', 'runtime']) {
      invalidAuth = issue === 'auth';
      changedRuntime = issue === 'runtime';
      healthReads = 0;
      calls.length = 0;
      assert.equal(
        (await driver.run(activeItem, signal, (p) => Object.assign(activeItem, p))).state,
        'waiting',
      );
      assert.equal(activeItem.hash, undefined);
      assert.equal(activeItem.bytesSent, 0);
      assert.ok(!calls.includes('/api/v1/install/readiness'));
      assert.ok(!calls.some((path) => path.startsWith('/api/v1/transfers/')));
    }
    invalidAuth = changedRuntime = false;
    const fixtureFetch = globalThis.fetch,
      profileFile = join(data, 'console-profiles.json'),
      savedProfiles = readFileSync(profileFile, 'utf8');
    calls.length = 0;
    globalThis.fetch = async (url, options) => {
      const reply = await fixtureFetch(url, options);
      if (new URL(url).pathname === '/health') {
        const changed = JSON.parse(savedProfiles);
        changed.consoles.find((p) => p.id === profile.id).platform = 'ps4';
        writeFileSync(profileFile, JSON.stringify(changed));
      }
      return reply;
    };
    try {
      const denied = await api.readPs5ActivatedRouteCapabilities(profile.id, signal);
      assert.deepEqual(denied.formats, []);
      assert.deepEqual(
        calls,
        ['/health'],
        'a changed platform cannot continue activated readiness',
      );
    } finally {
      writeFileSync(profileFile, savedProfiles);
      globalThis.fetch = fixtureFetch;
    }
    calls.length = 0;
    globalThis.fetch = async (url, options) => {
      const reply = await fixtureFetch(url, options);
      if (new URL(url).pathname !== '/health') return reply;
      const health = await reply.json();
      health.serviceReport.buildId = 'another-healthy-build';
      return new Response(JSON.stringify(health), { status: 200 });
    };
    try {
      assert.equal(
        await api.readPs5ActivatedRouteCapabilities(profile.id, signal),
        undefined,
        'a healthy different build retains its existing full readiness path',
      );
      assert.deepEqual(calls, ['/health']);
    } finally {
      globalThis.fetch = fixtureFetch;
    }
    const controller = new AbortController();
    let notifyBlocked;
    const blocked = new Promise((resolve) => {
      notifyBlocked = resolve;
    });
    calls.length = 0;
    globalThis.fetch = async (url, options) => {
      if (new URL(url).pathname !== '/health') return fixtureFetch(url, options);
      calls.push('/health');
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        });
        notifyBlocked();
      });
    };
    const abortedRun = driver.run(activeItem, controller.signal, (p) =>
      Object.assign(activeItem, p),
    );
    await blocked;
    let deadline;
    const timelyAbort = new Promise((_resolve, reject) => {
      deadline = setTimeout(() => reject(Error('Activated route ignored caller abort')), 500);
    });
    controller.abort();
    try {
      await assert.rejects(Promise.race([abortedRun, timelyAbort]), { name: 'AbortError' });
      assert.equal(activeItem.hash, undefined);
      assert.equal(activeItem.bytesSent, 0);
      assert.deepEqual(calls, ['/health'], 'aborted activation never starts a transfer');
    } finally {
      clearTimeout(deadline);
      globalThis.fetch = fixtureFetch;
    }
    healthReads = 0;
    calls.length = 0;
    assert.equal(
      (await driver.run(activeItem, signal, (p) => Object.assign(activeItem, p))).state,
      'installing',
    );
    assert.equal(activeItem.bytesSent, pkg.size);
    assert.ok(calls.includes('/api/v1/capabilities'));
    assert.ok(!calls.includes('/api/v1/install/readiness'));
    assert.ok(calls.includes('/api/v1/folder/commit'));
  } finally {
    globalThis.fetch = oldFetch;
    if (oldData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = oldData;
    rmSync(work, { recursive: true, force: true });
  }
});
