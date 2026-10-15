import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { putPs5ParamPkg } from './fixtures/ps5-param-pkg.mjs';

const work = mkdtempSync(join(tmpdir(), 'pf-catalog-presence-')),
  oldData = process.env.PACKAGEFLOW_DATA_DIR,
  data = join(work, 'data'),
  bundle = join(work, 'api.mjs');
process.env.PACKAGEFLOW_DATA_DIR = data;
mkdirSync(data);
await build({
  stdin: {
    contents:
      "export * from './server/utils/installed-package-check'; export * from './server/utils/ps5-queue-driver'; export * from './server/utils/console-profiles'; export * from './server/utils/device-installation';",
    resolveDir: resolve('.'),
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});
const api = await import(pathToFileURL(bundle).href);
const base = {
  id: 'base',
  titleId: 'PPSA95001',
  contentId: 'IV0000-PPSA95001_00-PACKAGEFLOWUI001',
  appVersion: '01.000.001',
  installOrder: 0,
  type: 'Игра',
  platform: 'ps5',
  format: 'pkg',
};
const revision = 'a'.repeat(64);
const row = (pkg = base) => ({
  titleId: pkg.titleId,
  contentId: pkg.contentId,
  metadata: JSON.stringify({ contentVersion: pkg.appVersion }),
});
function reader(options = {}) {
  const calls = [],
    entries = options.entries ?? [row()];
  const read = async (_id, path, headers, _body, signal) => {
    calls.push(path);
    if (path.endsWith('/status'))
      return {
        status: 200,
        body: {
          protocol: 'ps5-management-v1',
          ready: true,
          catalog: true,
          consoleGames: false,
          ...options.management,
        },
      };
    if (path.endsWith('/catalog')) {
      const offset = Number(headers['X-PackageFlow-Offset']);
      const body = {
        revision,
        total: entries.length,
        entries: entries.slice(offset, offset + 1),
        next: Math.min(offset + 1, entries.length),
        done: offset + 1 >= entries.length,
      };
      if (options.catalogAction) return options.catalogAction(signal);
      return {
        status: options.catalogStatus ?? 200,
        body: options.catalog?.(body, offset) ?? body,
      };
    }
    assert.equal(path, '/api/v1/console/info');
    if (options.infoThrow) throw options.infoThrow;
    if (options.infoAction) return options.infoAction(signal);
    return options.info ?? { status: 503, body: { error: 'ShadowMount unavailable' } };
  };
  return { read, calls };
}
const check = (options, pkg = base, signal = new AbortController().signal) =>
  api.checkPs5InstalledPackage('fixture', '192.0.2.5', pkg, signal, reader(options).read);

test('a complete stable catalog proves only base presence without requesting source details', async () => {
  for (const consoleGames of [false, true, undefined]) {
    for (const info of [
      { status: 503, body: {} },
      { status: 200, body: {} },
    ]) {
      const { read, calls } = reader({
        management: { consoleGames },
        info,
        entries: [
          row(),
          row({ ...base, titleId: 'PPSA95002', contentId: 'IV0000-PPSA95002_00-ANOTHERGAME00000' }),
        ],
      });
      const result = await api.checkPs5InstalledPackage(
        'fixture',
        '192.0.2.5',
        base,
        undefined,
        read,
      );
      assert.equal(result.state, 'base-present');
      assert.equal(result.revision, revision);
      assert.match(result.detail, /каталоге PS5.*версия.*не подтверждена/);
      assert.match(result.detail, /переустанов/);
      assert.equal(result.components, undefined);
      assert.deepEqual(calls, [
        '/api/v1/management/status',
        '/api/v1/console/catalog',
        '/api/v1/console/catalog',
      ]);
    }
  }
});
test('catalog-only presence requires explicit base PS5 PKG scope', async () => {
  for (const pkg of [
    { ...base, installOrder: 1, type: 'Патч' },
    { ...base, installOrder: 2, type: 'DLC' },
    { ...base, type: 'DLC' },
    { ...base, format: 'folder' },
    { ...base, format: 'ffpfsc' },
    { ...base, format: undefined },
    { ...base, platform: undefined },
    { ...base, platform: 'ps4' },
    { ...base, platform: 'ps4', titleId: 'CUSA95001' },
  ]) {
    const { read, calls } = reader({ entries: [row(pkg)] });
    assert.equal(
      (await api.checkPs5InstalledPackage('fixture', '192.0.2.5', pkg, undefined, read)).state,
      'unavailable',
      JSON.stringify(pkg),
    );
    assert.ok(calls.includes('/api/v1/console/info'));
  }
});
test('unavailable management/catalog and the unchanged source-detail routes fail closed', async () => {
  for (const management of [{ ready: false }, { catalog: false }, { protocol: 'unknown' }])
    assert.equal((await check({ management })).state, 'unavailable');
  for (const catalogStatus of [401, 403, 503])
    assert.equal((await check({ catalogStatus })).state, 'unavailable');
  for (const status of [200, 401, 403, 404, 409, 503]) {
    for (const pkg of [
      { ...base, format: 'folder' },
      { ...base, installOrder: 1, type: 'Патч' },
      { ...base, installOrder: 2, type: 'DLC' },
    ])
      assert.equal((await check({ info: { status, body: {} } }, pkg)).state, 'unavailable');
  }
});
test('incomplete, inconsistent or structurally invalid catalogs fail closed', async () => {
  const entries = [
    row(),
    row({ ...base, titleId: 'PPSA95002', contentId: 'IV0000-PPSA95002_00-ANOTHERGAME00000' }),
  ];
  for (const catalog of [
    (v) => ({ ...v, total: undefined }),
    (v) => ({ ...v, total: -1 }),
    (v, offset) => ({ ...v, total: offset ? 3 : 2 }),
    (v, offset) => ({ ...v, revision: (offset ? 'b' : 'a').repeat(64) }),
    (v) => ({ ...v, next: v.next + 1 }),
    (v) => ({ ...v, done: true }),
    (v, offset) => (offset ? { ...v, entries: [], next: offset, done: false } : v),
    (v) => ({ ...v, entries: [{ ...v.entries[0], metadata: null }] }),
    (v) => ({ ...v, entries: [{ ...v.entries[0], metadata: 'x'.repeat(32769) }] }),
    (v) => ({ ...v, entries: [{ ...v.entries[0], contentId: 'x'.repeat(129) }] }),
    (v) => ({ ...v, entries: [{ ...v.entries[0], titleId: 'invalid' }] }),
    (v) => ({ ...v, entries: [{ ...v.entries[0], contentId: null }] }),
  ])
    assert.equal((await check({ entries, catalog })).state, 'unavailable');
});
test('catalog registration does not depend on JSON metadata, Content ID identity or row uniqueness', async () => {
  const unrelated = row({ ...base, titleId: 'PPSA95002', contentId: '' });
  for (const metadata of ['', 'null', 'invalid JSON', '[]', '{"contentVersion":7}']) {
    for (const entries of [
      [{ ...row(), contentId: '', metadata }, unrelated],
      [row(), { ...unrelated, metadata }],
      [{ ...row(), contentId: 'unrelated Content ID', metadata }],
    ]) {
      const { read, calls } = reader({ entries });
      const result = await api.checkPs5InstalledPackage(
        'fixture',
        '192.0.2.5',
        base,
        undefined,
        read,
      );
      assert.equal(result.state, 'base-present');
      assert.equal(result.revision, revision);
      assert.ok(!calls.includes('/api/v1/console/info'));
    }
  }
  const duplicates = await check({ entries: [row(), row()] });
  assert.equal(duplicates.state, 'base-present');
  assert.equal(duplicates.revision, revision);
  assert.equal(
    (
      await check({
        entries: [
          {
            ...unrelated,
            metadata: JSON.stringify({ titleId: base.titleId, contentVersion: base.appVersion }),
          },
        ],
      })
    ).state,
    'absent',
    'metadata can never invent a registration for a different title',
  );
});
test('complete fresh absence and valid source-detail proofs retain their previous meaning', async () => {
  const empty = reader({ entries: [] });
  assert.equal(
    (await api.checkPs5InstalledPackage('fixture', '192.0.2.5', base, undefined, empty.read)).state,
    'absent',
  );
  assert.ok(!empty.calls.includes('/api/v1/console/info'));
  const info = {
    status: 200,
    body: {
      title_id: base.titleId,
      content_id: base.contentId,
      version: base.appVersion,
      installed: true,
      source_available: true,
      sourceIdentity: 'c'.repeat(64),
      path: '/user/app/PPSA95001/app.pkg',
    },
  };
  const baseRead = reader({ info });
  assert.equal(
    (await api.checkPs5InstalledPackage('fixture', '192.0.2.5', base, undefined, baseRead.read))
      .state,
    'base-present',
    'even exact-looking source details never assert this selected base PKG is installed',
  );
  assert.ok(!baseRead.calls.includes('/api/v1/console/info'));
  for (const consoleGames of [false, true, undefined]) {
    const result = await check(
      { info, management: { consoleGames } },
      { ...base, format: 'folder' },
    );
    assert.equal(result.state, 'installed');
    assert.equal(result.revision, info.body.sourceIdentity);
    assert.equal(
      (await check({ info }, { ...base, installOrder: 1, type: 'Патч' })).state,
      'installed',
    );
    assert.equal(
      (await check({ info }, { ...base, installOrder: 2, type: 'DLC' })).state,
      'unavailable',
    );
  }
  assert.equal(
    (
      await check(
        { info: { ...info, body: { ...info.body, installed: false } } },
        { ...base, format: 'folder' },
      )
    ).state,
    'absent',
  );
  assert.equal(
    (await check({ entries: [], catalog: (v) => ({ ...v, total: 1 }) })).state,
    'unavailable',
  );
});
test('explicit aborts propagate from catalog reads and unchanged detail reads', async () => {
  const error = new DOMException('cancelled', 'AbortError');
  await assert.rejects(
    check({
      catalogAction: () => {
        throw error;
      },
    }),
    { name: 'AbortError' },
  );
  await assert.rejects(check({ infoThrow: error }, { ...base, format: 'folder' }), {
    name: 'AbortError',
  });
  const controller = new AbortController();
  await assert.rejects(
    check(
      {
        catalogAction: () => {
          controller.abort(error);
          throw error;
        },
      },
      base,
      controller.signal,
    ),
    { name: 'AbortError' },
  );
});
test('catalog revision binds the real preview and the unchanged worker requires explicit overwrite', async () => {
  const oldFetch = globalThis.fetch;
  try {
    const profile = api.saveConsoleProfile({
      name: 'Fixture PS5',
      platform: 'ps5',
      ip: '192.0.2.5',
    }).consoles[0];
    writeFileSync(
      join(data, 'ps5-service-keys.json'),
      JSON.stringify({ [profile.ip]: 'b'.repeat(64) }),
    );
    const pkg = {
      ...base,
      title: 'Fixture',
      fileName: 'base.pkg',
      size: 8192,
      path: join(work, 'base.pkg'),
      libraryRoot: work,
      contentType: 'PS5GD',
      sourceModifiedAt: 1,
      icon: { offset: 0, size: 0 },
      iconSize: 0,
    };
    writeFileSync(pkg.path, putPs5ParamPkg(Buffer.alloc(pkg.size)));
    const libraryFile = join(data, 'package-library.json');
    writeFileSync(libraryFile, JSON.stringify({ version: 2, packages: [pkg], deliveries: {} }));
    const before = readFileSync(libraryFile, 'utf8'),
      writes = [];
    let liveRevision = revision;
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
    globalThis.fetch = async (url, options = {}) => {
      const path = new URL(url).pathname;
      if (options.method === 'POST') writes.push(path);
      const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
      if (path === '/health')
        return response({
          apiVersion: 'v1',
          firmwareRead: true,
          firmwareRaw: '0x13600007',
          serviceReport: { service: ready.service, platform: 'ps5', consoleVerified: true },
        });
      if (path === '/api/v1/capabilities')
        return response({
          service: ready.service,
          capabilities: { installPs5Content: true, installPs4Pkg: true },
        });
      if (path === '/api/v1/system')
        return response({
          service: ready.service,
          storageRead: true,
          freeBytes: 210 * 1024 ** 3,
          totalBytes: 1024 ** 4,
        });
      if (path === '/api/v1/install/readiness') return response(ready);
      if (path === '/api/v1/management/status')
        return response({
          protocol: 'ps5-management-v1',
          ready: true,
          catalog: true,
          consoleGames: false,
        });
      if (path === '/api/v1/console/catalog')
        return response({
          revision: liveRevision,
          total: 1,
          entries: [row()],
          next: 1,
          done: true,
        });
      if (path === '/api/v1/console/info') assert.fail('base PKG must not request source details');
      if (path === '/api/v1/transfers/begin') throw new Error('transfer reached explicitly');
      assert.fail(path);
    };
    const preview = await api.previewDeviceInstall({ packageIds: [pkg.id] }, [profile.id]);
    const device = preview.devices[0];
    assert.equal(device.eligible, true, device.reason);
    assert.equal(device.installedPackages.length, 1);
    assert.equal(device.installedPackages[0].canOverwrite, true);
    liveRevision = 'b'.repeat(64);
    const changed = await api.previewDeviceInstall({ packageIds: [pkg.id] }, [profile.id]);
    assert.notEqual(changed.devices[0].reviewToken, device.reviewToken);
    assert.deepEqual(writes, []);
    const driver = api.ps5QueueDriver(profile.id),
      signal = new AbortController().signal;
    const item = () => ({
      ...pkg,
      packageId: pkg.id,
      order: 0,
      branch: 'ps5:PPSA95001',
      transferId: 'c'.repeat(32),
      state: 'pending',
      detail: '',
      bytesSent: 0,
    });
    let current = item();
    const result = await driver.run(current, signal, (patch) => Object.assign(current, patch));
    assert.equal(result.state, 'skipped');
    assert.equal(result.alreadyPresent, true);
    assert.equal(current.hash, undefined);
    assert.deepEqual(writes, []);
    assert.equal(readFileSync(libraryFile, 'utf8'), before);
    current = { ...item(), overwriteApproved: true };
    await assert.rejects(
      driver.run(current, signal, (patch) => Object.assign(current, patch)),
      /transfer reached explicitly/,
    );
    assert.deepEqual(writes, ['/api/v1/transfers/begin']);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test.after(() => {
  if (oldData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
  else process.env.PACKAGEFLOW_DATA_DIR = oldData;
  rmSync(work, { recursive: true, force: true });
});
