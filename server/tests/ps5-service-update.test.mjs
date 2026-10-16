import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';

test('PS5 update closes only an acknowledged idle service; exact receipt and no replay', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-ps5-update-'));
  try {
    const bundle = join(work, 'driver.mjs');
    await build({
      entryPoints: [resolve('server/utils/ps5-service-update-driver.ts')],
      outfile: bundle,
      bundle: true,
      format: 'esm',
      platform: 'node',
      logLevel: 'silent',
    });
    const { runPs5ServiceUpdate, ps5ServiceUpdateReceipt, ps5ServiceUpdateAvailable } =
      await import(pathToFileURL(bundle).href);
    const health = (pid, version = '0.1.3-dev', buildId = '') => ({
      status: 200,
      body: {
        apiVersion: 'v1',
        pid,
        serviceReport: {
          service: 'PackageFlowService-PS5',
          platform: 'ps5',
          consoleVerified: true,
          version,
          buildId,
        },
      },
    });
    async function scenario(options = {}) {
      const flow = {
        id: 'a'.repeat(32),
        consoleId: 'device-one',
        ip: '192.168.0.127',
        version: '0.1.4-dev',
        buildId: 'ps5-service-web-update-001',
        sha256: 'b'.repeat(64),
        state: 'preparing',
        message: '',
        startedAt: 1,
      };
      const calls = [],
        states = [];
      let shutdown = false,
        transferred = false,
        pauses = 0,
        activities = 0,
        prepared = false;
      const driver = {
        idle: () => options.busy !== true,
        save: (value) => states.push(value.state),
        pause: async () => {
          pauses++;
        },
        request: async (path, headers) => {
          calls.push(path);
          if (path === '/api/v1/status')
            return health(
              shutdown ? 172 : 170,
              options.newer
                ? '0.1.5-dev'
                : shutdown || options.already
                  ? flow.version
                  : '0.1.3-dev',
              shutdown || options.already
                ? options.wrongBuild
                  ? 'wrong-build'
                  : flow.buildId
                : '',
            );
          if (path === '/api/v1/operations/status')
            return { status: 200, body: { running: options.operationBusy === true } };
          if (path === '/api/v1/console/activity') {
            activities++;
            if (options.unknownActivity) return { status: 503, body: { complete: false } };
            if (options.malformedActivity)
              return {
                status: 200,
                body: { complete: true, running: false, appId: 24, titleId: '' },
              };
            const running =
              (options.raceActivity && activities > 1) || (!options.uiClosed && activities === 1);
            return {
              status: 200,
              body: {
                complete: true,
                running: !!running,
                appId: running ? 24 : 0,
                titleId: running ? (options.otherGame ? 'PPSA04288' : 'PPSA95001') : '',
              },
            };
          }
          if (path === '/api/v1/update/prepare') {
            prepared = true;
            assert.equal(headers['X-PackageFlow-Update-Id'], flow.id);
            return {
              status: options.oldApi ? 404 : 200,
              body: {
                requestId: options.wrongId ? 'c'.repeat(32) : flow.id,
                requested: true,
                ready: options.noAck !== true,
              },
            };
          }
          if (path === '/api/v1/update/status')
            return {
              status: 200,
              body: {
                service: options.foreignUpdateStatus ? 'other' : 'PackageFlowService-PS5',
                requestId: flow.id,
                requested: prepared || options.pendingUpdate === true,
                ready: false,
              },
            };
          if (path === '/api/v1/shutdown') {
            shutdown = true;
            if (options.lostShutdown) throw new Error('lost shutdown reply');
            return { status: 200, body: { ok: true, scope: 'packageflow-process' } };
          }
          throw new Error(`unexpected ${path}`);
        },
        health: async () => {
          calls.push('health');
          if (options.oldStillAlive) return health(170);
          if (options.foreign) return { status: 503, body: {} };
          throw Object.assign(new Error(options.healthTimeout ? 'ETIMEDOUT' : 'ECONNREFUSED'), {
            code: options.healthTimeout ? 'ETIMEDOUT' : 'ECONNREFUSED',
          });
        },
        connect: async () => {
          calls.push('connect');
          if (options.noLoader) throw new Error('loader unavailable');
          return {
            close: () => calls.push('close'),
            send: async (bytes) => {
              assert.deepEqual([...bytes], [1, 2, 3]);
              transferred = true;
              calls.push('send');
              if (options.lostUpload) throw new Error('upload reply lost');
            },
          };
        },
      };
      await runPs5ServiceUpdate(flow, new Uint8Array([1, 2, 3]), driver);
      assert.ok(calls.filter((p) => p === '/api/v1/shutdown').length <= 1);
      assert.ok(calls.filter((p) => p === 'send').length <= 1);
      return { flow, calls, states, transferred, pauses };
    }
    const good = await scenario();
    assert.equal(good.flow.state, 'completed');
    assert.ok(good.calls.indexOf('connect') < good.calls.indexOf('/api/v1/shutdown'));
    assert.deepEqual(good.states, ['preparing', 'stopping', 'sending', 'verifying', 'completed']);
    assert.equal(
      ps5ServiceUpdateReceipt(good.flow, health(172, good.flow.version, good.flow.buildId)),
      true,
    );
    assert.equal(
      ps5ServiceUpdateReceipt(good.flow, health(170, good.flow.version, good.flow.buildId)),
      false,
      'old PID is not an update receipt',
    );
    assert.equal(
      ps5ServiceUpdateReceipt(good.flow, health(172, good.flow.version, 'other-build')),
      false,
    );
    assert.equal(
      ps5ServiceUpdateReceipt(
        { ...good.flow, previousPid: undefined },
        health(172, good.flow.version, good.flow.buildId),
      ),
      false,
    );
    assert.equal(ps5ServiceUpdateAvailable(good.flow, health(170, '0.1.3-dev', 'old-build')), true);
    assert.equal(
      ps5ServiceUpdateAvailable(good.flow, health(170, good.flow.version, 'old-build')),
      true,
      'different builds update even at the same version',
    );
    assert.equal(
      ps5ServiceUpdateAvailable(good.flow, health(170, good.flow.version, good.flow.buildId)),
      false,
    );
    assert.equal(
      ps5ServiceUpdateAvailable(good.flow, health(170, '0.1.5-dev', 'newer-build')),
      false,
    );
    assert.equal(
      ps5ServiceUpdateAvailable(good.flow, health(170, good.flow.version, '')),
      false,
      'an unknown same-version build is not proof of an update',
    );
    assert.equal(ps5ServiceUpdateAvailable(good.flow, { status: 401, body: {} }), false);
    for (const option of [
      'busy',
      'operationBusy',
      'oldApi',
      'noAck',
      'wrongId',
      'noLoader',
      'newer',
      'unknownActivity',
      'malformedActivity',
      'otherGame',
      'pendingUpdate',
      'foreignUpdateStatus',
      'raceActivity',
    ]) {
      const r = await scenario({ [option]: true });
      assert.equal(r.flow.state, 'failed', option);
      assert.ok(!r.calls.includes('/api/v1/shutdown'), option);
      assert.equal(r.transferred, false);
    }
    for (const option of ['foreign', 'oldStillAlive', 'lostShutdown', 'healthTimeout']) {
      const r = await scenario({ [option]: true });
      assert.equal(r.flow.state, 'unconfirmed', option);
      assert.equal(r.transferred, false);
    }
    assert.equal((await scenario({ lostUpload: true })).flow.state, 'unconfirmed');
    assert.equal(
      (await scenario({ wrongBuild: true })).flow.state,
      'unconfirmed',
      'a different build never confirms the update',
    );
    const same = await scenario({ already: true });
    assert.equal(same.flow.state, 'completed');
    assert.ok(!same.calls.includes('connect'), 'same authenticated build needs no replacement');
    const closed = await scenario({ uiClosed: true });
    assert.equal(
      closed.flow.state,
      'completed',
      'a closed UI cannot acknowledge preparation, but authenticated idle proof allows the update',
    );
    assert.equal(closed.calls.includes('/api/v1/update/prepare'), false);
    assert.equal(
      closed.calls.filter((path) => path === '/api/v1/console/activity').length,
      2,
      'activity is checked again before shutdown',
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('refresh reconciles a lost PS5 update receipt without shutdown or payload replay', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-update-receipt-')),
    previous = process.env.PACKAGEFLOW_DATA_DIR,
    fetchBefore = globalThis.fetch;
  process.env.PACKAGEFLOW_DATA_DIR = work;
  try {
    const id = '11111111-1111-1111-1111-111111111111',
      ip = '192.168.0.127';
    writeFileSync(
      join(work, 'console-profiles.json'),
      JSON.stringify({
        version: 1,
        activeId: id,
        consoles: [
          {
            id,
            ip,
            name: 'Test PS5',
            platform: 'ps5',
            verified: true,
            version: '0.1.3-dev',
            firmware: '13.60',
          },
        ],
      }),
    );
    writeFileSync(join(work, 'ps5-service-keys.json'), JSON.stringify({ [ip]: 'a'.repeat(64) }));
    mkdirSync(join(work, 'ps5-service-updates'));
    const flowFile = join(work, 'ps5-service-updates', `${id}.json`);
    const flow = {
      id: 'b'.repeat(32),
      consoleId: id,
      ip,
      version: '0.1.4-dev',
      buildId: 'ps5-service-web-update-001',
      sha256: 'c'.repeat(64),
      state: 'unconfirmed',
      message: '',
      previousPid: 170,
      startedAt: 1,
    };
    writeFileSync(flowFile, JSON.stringify(flow));
    const bundle = join(work, 'receipt.mjs');
    await build({
      entryPoints: [resolve('server/utils/ps5-service-updates.ts')],
      outfile: bundle,
      bundle: true,
      format: 'esm',
      platform: 'node',
      logLevel: 'silent',
    });
    let pid = 170,
      calls = 0;
    globalThis.fetch = async (url, options) => {
      assert.equal(url, `http://${ip}:8095/api/v1/status`);
      assert.equal(options.method, 'GET');
      calls++;
      return new Response(
        JSON.stringify({
          apiVersion: 'v1',
          pid,
          serviceReport: {
            service: 'PackageFlowService-PS5',
            platform: 'ps5',
            consoleVerified: true,
            version: flow.version,
            buildId: flow.buildId,
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    };
    const { ps5ServiceUpdateInfo } = await import(pathToFileURL(bundle).href);
    assert.equal((await ps5ServiceUpdateInfo(id)).flow.state, 'unconfirmed');
    pid = 172;
    assert.equal((await ps5ServiceUpdateInfo(id)).flow.state, 'completed');
    assert.equal(JSON.parse(readFileSync(flowFile, 'utf8')).state, 'completed');
    await ps5ServiceUpdateInfo(id);
    assert.equal(
      calls,
      3,
      'refresh reads only authenticated current status and never replays update mutations',
    );
  } finally {
    globalThis.fetch = fetchBefore;
    if (previous === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = previous;
    rmSync(work, { recursive: true, force: true });
  }
});

test('ELF updates use the installed bundle, compare authenticated build IDs, and never fall back from a damaged bundle', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-update-bundle-')),
    previous = process.env.PACKAGEFLOW_DATA_DIR;
  process.env.PACKAGEFLOW_DATA_DIR = work;
  const id = '11111111-1111-1111-1111-111111111111',
    ip = '192.168.0.127';
  const elf = Buffer.alloc(8192);
  Buffer.from('7f454c460201', 'hex').copy(elf);
  elf.writeUInt16LE(62, 18);
  const sha256 = createHash('sha256').update(elf).digest('hex');
  const target = {
    fileName: 'PackageFlowService-PS5.elf',
    size: elf.length,
    sha256,
    version: '0.1.27-dev',
    buildId: 'ps5-service-registration-handoff-027-sse2',
    firmware: '13.60',
  };
  const fixture = (globalThis.pfElfUpdateFixture = {
    broken: false,
    offline: false,
    version: target.version,
    buildId: 'previous-build',
    verified: [],
    requests: [],
    profile: () => ({
      id,
      ip,
      platform: 'ps5',
      verified: true,
      firmware: '13.60',
      version: '0.1.99-dev',
    }),
    async bundle(options) {
      this.verified.push(options.verifyFiles);
      if (this.broken) throw new Error('Контрольная сумма комплекта PS5 не совпала');
      return { manifest: { elf: target }, elf };
    },
    async request(path) {
      this.requests.push(path);
      if (this.offline) throw new Error('offline');
      assert.equal(path, '/api/v1/status', 'all status/reconciliation operations remain read-only');
      return {
        status: 200,
        body: {
          apiVersion: 'v1',
          pid: 103,
          serviceReport: {
            service: 'PackageFlowService-PS5',
            platform: 'ps5',
            consoleVerified: true,
            version: this.version,
            buildId: this.buildId,
          },
        },
      };
    },
  });
  try {
    mkdirSync(join(work, 'console-setup'));
    writeFileSync(join(work, 'console-setup', 'manifest.json'), '{}');
    mkdirSync(join(work, 'ps5-service-updates'));
    writeFileSync(join(work, 'ps5-service-updates', target.fileName), elf);
    writeFileSync(
      join(work, 'ps5-service-updates', 'release.json'),
      JSON.stringify({
        ...target,
        service: 'PackageFlowService-PS5',
        version: '0.1.26-dev',
        buildId: 'old-legacy-artifact',
      }),
    );
    const bundle = join(work, 'service.mjs');
    await build({
      stdin: {
        contents:
          "export * from './server/utils/ps5-service-updates';export { claimConsoleWorker } from './server/utils/console-worker-lock'",
        resolveDir: resolve('.'),
      },
      outfile: bundle,
      bundle: true,
      format: 'esm',
      platform: 'node',
      logLevel: 'silent',
      plugins: [
        {
          name: 'fixture',
          setup(b) {
            b.onResolve({ filter: /^\.\/(console-profiles|console-setup-artifacts)$/ }, (args) => ({
              path: args.path,
              namespace: 'fixture',
            }));
            b.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
              loader: 'js',
              contents: args.path.endsWith('console-profiles')
                ? 'export const getConsoleProfile=()=>globalThis.pfElfUpdateFixture.profile(); export const ps5OperationRequest=(id,path)=>globalThis.pfElfUpdateFixture.request(path); export const ps5ServiceRequest=()=>{throw Error("No unauthenticated update receipt")}'
                : 'export const consoleSetupBundle=options=>globalThis.pfElfUpdateFixture.bundle(options)',
            }));
          },
        },
      ],
    });
    const api = await import(pathToFileURL(bundle).href);
    let info = await api.ps5ServiceUpdateInfo(id);
    assert.equal(info.release.source, 'bundle');
    assert.equal(info.release.buildId, target.buildId);
    assert.equal(
      info.updateAvailable,
      true,
      'same-version, different-build candidate must not be skipped',
    );
    assert.equal(
      info.current,
      target.version,
      'stored profile 0.1.99 is not an authenticated version',
    );
    assert.equal(info.currentBuildId, 'previous-build');
    assert.equal(info.currentConfirmed, true);
    assert.deepEqual(fixture.verified, [false]);
    fixture.offline = true;
    info = await api.ps5ServiceUpdateInfo(id);
    assert.equal(info.current, '');
    assert.equal(info.currentConfirmed, false);
    assert.equal(info.updateAvailable, false);
    fixture.offline = false;
    fixture.buildId = target.buildId;
    info = await api.ps5ServiceUpdateInfo(id);
    assert.equal(info.updateAvailable, false);
    fixture.version = '0.1.28-dev';
    fixture.buildId = 'future-build';
    info = await api.ps5ServiceUpdateInfo(id);
    assert.equal(info.updateAvailable, false, 'never offer an ELF downgrade');
    fixture.version = target.version;
    fixture.buildId = target.buildId;
    const appWorker = api.claimConsoleWorker('bootstrap', ip);
    assert.ok(appWorker);
    await assert.rejects(
      api.beginPs5ServiceUpdate(id),
      { statusCode: 409 },
      'ELF update must not race an app updater holding the shared worker',
    );
    assert.throws(
      () => readFileSync(join(work, 'ps5-service-updates', `${id}.json`)),
      { code: 'ENOENT' },
      'a blocked worker creates no update intent',
    );
    appWorker();
    await api.beginPs5ServiceUpdate(id);
    info = await api.ps5ServiceUpdateInfo(id);
    assert.equal(info.flow.state, 'completed');
    assert.equal(info.flow.sha256, sha256);
    assert.equal(info.flow.buildId, target.buildId);
    const released = api.claimConsoleWorker('bootstrap', ip);
    assert.ok(released, 'the shared worker is released after completion');
    released();
    assert.ok(
      fixture.verified.includes(true),
      'an update intent revalidates bundle bytes regardless of status cache',
    );
    fixture.broken = true;
    info = await api.ps5ServiceUpdateInfo(id);
    assert.equal(info.release, null);
    assert.match(info.message, /сумма/);
    await assert.rejects(api.beginPs5ServiceUpdate(id), { statusCode: 409 });
    assert.equal(
      fixture.requests.some((path) => path !== '/api/v1/status'),
      false,
      'a corrupt current bundle does not select the legacy ELF',
    );
    rmSync(join(work, 'console-setup', 'manifest.json'));
    fixture.broken = false;
    info = await api.ps5ServiceUpdateInfo(id);
    assert.equal(info.release.source, 'legacy');
    assert.equal(info.release.version, '0.1.26-dev');
  } finally {
    delete globalThis.pfElfUpdateFixture;
    if (previous === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = previous;
    rmSync(work, { recursive: true, force: true });
  }
});

test('real PS5 health adapter preserves nested fetch causes: refused listener permits update, timeout never does', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-update-health-cause-')),
    fetchBefore = globalThis.fetch;
  try {
    const bundle = join(work, 'adapter.mjs');
    await build({
      stdin: {
        contents:
          "export { ps5ServiceRequest } from './server/utils/console-profiles';export { runPs5ServiceUpdate } from './server/utils/ps5-service-update-driver'",
        resolveDir: resolve('.'),
      },
      outfile: bundle,
      bundle: true,
      format: 'esm',
      platform: 'node',
      logLevel: 'silent',
    });
    const { ps5ServiceRequest, runPs5ServiceUpdate } = await import(pathToFileURL(bundle).href);
    for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET']) {
      globalThis.fetch = async (url) => {
        assert.equal(url, 'http://192.168.0.127:8095/health');
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('transport failure'), { code }),
        });
      };
      await assert.rejects(
        ps5ServiceRequest('192.168.0.127', '/health'),
        (error) => error.statusCode === 503 && error.cause?.code === code,
      );
      const flow = {
        id: 'a'.repeat(32),
        consoleId: 'test',
        ip: '192.168.0.127',
        version: '0.1.28-dev',
        buildId: 'ps5-service-own-app-update-028b-sse2',
        sha256: 'b'.repeat(64),
        state: 'preparing',
        startedAt: 1,
        message: '',
      };
      let sent = 0,
        stopped = 0;
      const health = () => ({
        status: 200,
        body: {
          apiVersion: 'v1',
          pid: sent ? 104 : 103,
          serviceReport: {
            service: 'PackageFlowService-PS5',
            platform: 'ps5',
            consoleVerified: true,
            version: sent ? flow.version : '0.1.27-dev',
            buildId: sent ? flow.buildId : 'ps5-service-registration-handoff-027-sse2',
          },
        },
      });
      await runPs5ServiceUpdate(flow, new Uint8Array([1]), {
        idle: () => true,
        save: () => {},
        pause: async () => {},
        health: () => ps5ServiceRequest('192.168.0.127', '/health'),
        request: async (path) => {
          if (path === '/api/v1/status') return health();
          if (path === '/api/v1/operations/status')
            return { status: 200, body: { running: false } };
          if (path === '/api/v1/console/activity')
            return { status: 200, body: { complete: true, running: false, appId: 0, titleId: '' } };
          if (path === '/api/v1/update/status')
            return { status: 200, body: { service: 'PackageFlowService-PS5', requested: false } };
          assert.equal(path, '/api/v1/shutdown');
          stopped++;
          return { status: 200, body: { ok: true, scope: 'packageflow-process' } };
        },
        connect: async () => ({
          close: () => {},
          send: async () => {
            sent++;
          },
        }),
      });
      assert.equal(stopped, 1);
      assert.equal(sent, code === 'ECONNREFUSED' ? 1 : 0, code);
      assert.equal(flow.state, code === 'ECONNREFUSED' ? 'completed' : 'unconfirmed', code);
    }
  } finally {
    globalThis.fetch = fetchBefore;
    rmSync(work, { recursive: true, force: true });
  }
});
