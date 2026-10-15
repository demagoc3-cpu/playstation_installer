import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
const turns = async (count = 20) => {
  for (let index = 0; index < count; index++) await new Promise(setImmediate);
};
async function until(predicate) {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  assert.fail('mock device request did not start');
}

async function fixture(platform, count, run) {
  const work = mkdtempSync(join(tmpdir(), 'pf-activity-cache-')),
    oldData = process.env.PACKAGEFLOW_DATA_DIR,
    oldFetch = globalThis.fetch,
    oldNow = Date.now;
  const state = {
    now: oldNow(),
    started: 0,
    active: 0,
    maximum: 0,
    present: true,
    gate: deferred(),
  };
  process.env.PACKAGEFLOW_DATA_DIR = join(work, 'data');
  mkdirSync(process.env.PACKAGEFLOW_DATA_DIR);
  Date.now = () => state.now;
  try {
    const output = join(work, 'activity.mjs');
    await build({
      stdin: {
        contents: `export { deviceActivitiesLive } from './server/utils/device-installation';
          export { saveConsoleProfile, probeConsoleProfile } from './server/utils/console-profiles';`,
        resolveDir: resolve('.'),
      },
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const api = await import(pathToFileURL(output).href),
      profile = api.saveConsoleProfile({ name: 'Own fixture', ip: '192.168.1.5', platform })
        .consoles[0],
      data = process.env.PACKAGEFLOW_DATA_DIR,
      source = join(work, 'source.pkg'),
      packages = Array.from({ length: count }, (_, index) => {
        const titleId = `${platform === 'ps5' ? 'PPSA' : 'CUSA'}${95000 + index}`;
        return {
          id: `own-${index}`,
          titleId,
          contentId: `IV0000-${titleId}_00-PACKAGEFLOWUI001`,
          platform,
          format: platform === 'ps5' ? 'folder' : 'pkg',
          contentType: platform === 'ps5' ? 'PS5GD' : 'PS4GD',
          appVersion: '01.000.001',
          title: `Own package ${index}`,
          fileName: `own-${index}.pkg`,
          type: 'Игра',
          installOrder: 0,
          size: 1024,
          path: source,
          libraryRoot: work,
          sourceModifiedAt: index,
          iconSize: 0,
          icon: { offset: 0, size: 0 },
          packageDigest: String(index + 1).padStart(64, '0'),
          installedAt: 123,
        };
      });
    writeFileSync(source, Buffer.alloc(1024));
    writeFileSync(
      join(data, 'package-library.json'),
      JSON.stringify({ version: 2, packages, deliveries: {} }),
    );
    writeFileSync(
      join(data, platform === 'ps5' ? 'ps5-service-keys.json' : 'ps4-service-keys.json'),
      JSON.stringify({ [profile.ip]: 'b'.repeat(platform === 'ps5' ? 64 : 32) }),
    );
    const byTitle = new Map(packages.map((pkg) => [pkg.titleId, pkg])),
      response = (body) => new Response(JSON.stringify(body)),
      ps4 = {
        service: 'PackegeFlowService',
        version: '0.4.0',
        installApi: 1,
        authentication: 'bearer',
        ready: true,
        contentTypes: ['PS4GD'],
        error: 0,
        errorHex: '0x00000000',
      };
    globalThis.fetch = async (url, options = {}) => {
      const address = new URL(url),
        path = address.pathname;
      assert.equal(address.hostname, profile.ip);
      assert.ok(
        !options.method || options.method === 'GET',
        'passive activity never mutates the console',
      );
      if (path === '/health')
        return response({
          apiVersion: 'v1',
          pid: 88,
          firmwareRead: true,
          firmwareRaw: '0x13600007',
          serviceReport: {
            service: 'PackageFlowService-PS5',
            consoleVerified: true,
            version: '0.1.27-dev',
            buildId: 'same-process',
          },
        });
      if (path === '/api/v1/capabilities')
        return response({ service: 'PackageFlowService-PS5', capabilities: {} });
      if (path === '/api/v1/install/readiness')
        return response({
          service: 'PackageFlowService-PS5',
          schemaVersion: 1,
          route: 'staged-pkg',
          exactVersionReceipt: false,
          ready: true,
          reason: 'ready',
          formats: ['pkg'],
          platforms: ['ps4', 'ps5'],
        });
      if (path === '/api/v1/system')
        return response({
          service: 'PackageFlowService-PS5',
          storageRead: true,
          freeBytes: 2 ** 30,
          totalBytes: 8 * 2 ** 30,
        });
      if (path === '/ping') return response({ ...ps4, status: 'ok' });
      if (path === '/install/capabilities' || path === '/install/session') return response(ps4);
      if (path === '/system/info')
        return response({
          ...ps4,
          environment: 'ps4',
          firmware: { version: '12.50' },
          model: { name: 'Slim', family: 'Slim' },
          hen: {},
        });
      if (path === '/storage')
        return response({
          ...ps4,
          volumes: [
            {
              id: 'internal',
              path: '/user',
              available: true,
              totalBytes: 8 * 2 ** 30,
              availableBytes: 2 ** 30,
            },
          ],
        });
      if (path === '/api/v1/management/status')
        return response({ protocol: 'ps5-management-v1', ready: true, catalog: true });
      if (path === '/api/v1/console/catalog') {
        const offset = Number(options.headers['X-PackageFlow-Offset'] || 0),
          pkg = packages[offset];
        return response({
          revision: 'c'.repeat(64),
          total: packages.length,
          entries: pkg
            ? [
                {
                  titleId: pkg.titleId,
                  contentId: pkg.contentId,
                  metadata: JSON.stringify({ contentVersion: pkg.appVersion }),
                },
              ]
            : [],
          next: offset + (pkg ? 1 : 0),
          done: offset + (pkg ? 1 : 0) === packages.length,
        });
      }
      if (path === '/api/v1/console/info' || path.startsWith('/apps/title/')) {
        const titleId =
            platform === 'ps5' ? options.headers['X-PackageFlow-Title'] : path.split('/')[3],
          pkg = byTitle.get(titleId);
        assert.ok(pkg);
        state.started++;
        state.active++;
        state.maximum = Math.max(state.maximum, state.active);
        try {
          await state.gate.promise;
          return platform === 'ps5'
            ? response({
                title_id: titleId,
                installed: state.present,
                source_available: true,
                content_id: pkg.contentId,
                version: pkg.appVersion,
              })
            : response({
                service: ps4.service,
                complete: true,
                revision: 'a'.repeat(16),
                app: { titleId, installed: state.present },
                total: state.present ? 1 : 0,
                next: null,
                components: state.present
                  ? [
                      {
                        id: titleId,
                        kind: 'base',
                        version: pkg.appVersion,
                        contentId: pkg.contentId,
                        canRemove: true,
                      },
                    ]
                  : [],
              });
        } finally {
          state.active--;
        }
      }
      assert.fail(`unexpected route ${path}`);
    };
    assert.equal((await api.probeConsoleProfile(profile.id)).consoles[0].online, true);
    await run({ api, state, ids: packages.map((pkg) => pkg.id) });
  } finally {
    state.gate.resolve();
    await turns();
    Date.now = oldNow;
    globalThis.fetch = oldFetch;
    if (oldData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = oldData;
    rmSync(work, { recursive: true, force: true });
  }
}

test('slow pending activity checks remain shared after five seconds and TTL starts after completion', async () => {
  await fixture('ps5', 1, async ({ api, state, ids }) => {
    const first = api.deviceActivitiesLive(ids);
    await until(() => state.started === 1);
    state.now += 6000;
    const second = api.deviceActivitiesLive(ids);
    await turns();
    assert.equal(state.started, 1, 'a second client must join a slow pending scan after the TTL');
    state.gate.resolve();
    for (const result of await Promise.all([first, second])) {
      assert.deepEqual(
        result[0].installedPackageIds,
        ids,
        'only the exact live response proves installation',
      );
    }
    state.now += 4999;
    await api.deviceActivitiesLive(ids);
    assert.equal(state.started, 1, 'a completed slow scan gets a full five-second TTL');
    state.now += 2;
    state.present = false;
    const absent = await api.deviceActivitiesLive(ids);
    assert.equal(state.started, 2);
    assert.deepEqual(
      absent[0].installedPackageIds,
      [],
      'a fresh absence overrides local installation marks',
    );
  });
});

for (const [platform, width] of [
  ['ps5', 1],
  ['ps4', 8],
]) {
  test(`passive ${platform} checks limit outstanding device requests to ${width}`, async () => {
    await fixture(platform, 9, async ({ api, state, ids }) => {
      const pending = api.deviceActivitiesLive(ids);
      await until(() => state.started >= width);
      await turns();
      assert.equal(
        state.started,
        width,
        'a passive scan must not enqueue another batch while the current one waits',
      );
      assert.equal(state.maximum, width);
      state.gate.resolve();
      const result = await pending;
      assert.equal(state.started, ids.length);
      assert.equal(state.maximum, width);
      assert.deepEqual(result[0].installedPackageIds.sort(), ids.sort());
    });
  });
}
