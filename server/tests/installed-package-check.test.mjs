import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { putPs5ParamPkg, ps5ParamFixture } from './fixtures/ps5-param-pkg.mjs';

const work = mkdtempSync(join(tmpdir(), 'pf-existing-')),
  bundle = join(work, 'api.mjs'),
  oldData = process.env.PACKAGEFLOW_DATA_DIR;
process.env.PACKAGEFLOW_DATA_DIR = join(work, 'data');
mkdirSync(process.env.PACKAGEFLOW_DATA_DIR);
await build({
  stdin: {
    contents:
      "export * from './server/utils/installed-package-check'; export * from './server/utils/ps5-installed-read-coordinator'; export * from './server/utils/ps5-queue-driver'; export * from './server/utils/ps5-queue-core'; export * from './server/utils/console-profiles'; export * from './server/utils/package-library';",
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
  titleId: 'CUSA95001',
  contentId: 'IV0000-CUSA95001_00-PACKAGEFLOWUI001',
  appVersion: '01.00',
  installOrder: 0,
  type: 'Игра',
};
const patch = { ...base, id: 'patch', appVersion: '01.04', installOrder: 1, type: 'Патч' };
const dlc = {
  ...base,
  id: 'dlc',
  contentId: 'IV0000-CUSA95001_00-ANOTHERDLC000001',
  installOrder: 2,
  type: 'DLC',
};
const components = [
  { kind: 'base', version: '1.00', contentId: base.contentId },
  { kind: 'patch', version: '1.03', contentId: base.contentId },
  { kind: 'dlc', version: '', contentId: dlc.contentId },
];
test('PS4 skips exact components, keeps a new patch/DLC, and protects an existing base of another version', () => {
  assert.equal(api.matchInstalledComponent(base, components).state, 'installed');
  assert.equal(api.matchInstalledComponent(patch, components).state, 'absent');
  assert.equal(
    api.matchInstalledComponent({ ...patch, appVersion: '01.03' }, components).state,
    'installed',
  );
  assert.equal(
    api.matchInstalledComponent({ ...patch, appVersion: '01.02' }, components).state,
    'base-present',
  );
  assert.equal(api.matchInstalledComponent(dlc, components).state, 'installed');
  assert.equal(
    api.matchInstalledComponent({ ...dlc, contentId: 'different' }, components).state,
    'absent',
  );
  assert.equal(
    api.matchInstalledComponent({ ...base, appVersion: '01.05' }, components).state,
    'base-present',
  );
});
test('PS4 missing component is absence; a missing endpoint, incomplete or changing snapshot is not', async () => {
  const missing = Object.assign(new Error('missing'), {
    statusCode: 404,
    data: { serviceError: 'component_not_found' },
  });
  assert.equal(
    (
      await api.checkPs4InstalledPackage('192.168.1.4', base, false, async () => {
        throw missing;
      })
    ).state,
    'absent',
  );
  assert.equal(
    (
      await api.checkPs4InstalledPackage('192.168.1.4', base, false, async () => {
        throw Object.assign(new Error('unsupported'), { statusCode: 404 });
      })
    ).state,
    'unavailable',
  );
  const reply = {
    service: 'PackegeFlowService',
    app: { titleId: base.titleId, installed: true },
    complete: true,
    revision: 'a'.repeat(16),
    total: 3,
    next: null,
    components,
  };
  assert.equal(
    (await api.checkPs4InstalledPackage('192.168.1.4', base, false, async () => reply)).state,
    'installed',
  );
  assert.equal(
    (
      await api.checkPs4InstalledPackage('192.168.1.4', base, false, async () => ({
        ...reply,
        complete: false,
      }))
    ).state,
    'unavailable',
  );
});
test('live PS5 version proves a patch; Title ID alone never proves a DLC', () => {
  const row = { installed: true, version: patch.appVersion, content_id: patch.contentId };
  assert.equal(api.matchPs5InstalledGame(patch, row, false).state, 'installed');
  assert.equal(
    api.matchPs5InstalledGame({ ...patch, appVersion: '01.05' }, row, true).state,
    'absent',
  );
  assert.equal(
    api.matchPs5InstalledGame({ ...patch, appVersion: '01.03' }, row, false).state,
    'base-present',
  );
  assert.equal(api.matchPs5InstalledGame(dlc, row, false).state, 'unavailable');
  assert.equal(api.matchPs5InstalledGame(dlc, row, true).state, 'unavailable');
  assert.equal(api.matchPs5InstalledGame(dlc, { ...row, installed: false }, true).state, 'absent');
});
test('live built-in registration without a source is a base review, never proof of selected version or a disconnected console', async () => {
  const signal = new AbortController().signal;
  const read = async (_id, path) => ({
    status: 200,
    body: path.endsWith('/status')
      ? { protocol: 'ps5-management-v1', ready: true, catalog: true }
      : path.endsWith('/catalog')
        ? {
            revision: 'd'.repeat(64),
            entries: [{ titleId: base.titleId, contentId: base.contentId, metadata: '{}' }],
            next: 1,
            done: true,
          }
        : {
            title_id: base.titleId,
            content_id: 'IP9100-' + base.titleId + '_00-PREINMASTER00000',
            version: '0',
            installed: true,
            source_available: false,
            path: '',
            sourceIdentity: 'e'.repeat(64),
          },
  });
  const v = await api.checkPs5InstalledPackage('fixture', '192.168.1.5', base, signal, read);
  assert.equal(v.state, 'base-present');
  assert.match(v.detail, /версия.*не подтверждена/);
  assert.equal(v.revision, 'e'.repeat(64));
  const p = await api.checkPs5InstalledPackage('fixture', '192.168.1.5', patch, signal, read);
  assert.equal(p.state, 'unavailable');
  assert.match(p.detail, /PS5 отвечает/);
  const failed = await api.checkPs5InstalledPackage(
    'fixture',
    '192.168.1.5',
    base,
    signal,
    async () => ({ status: 503, body: {} }),
  );
  assert.equal(failed.state, 'unavailable');
});
const catalogRegistration = (
  candidate = base,
  metadata = { contentVersion: candidate.appVersion },
) => ({
  titleId: candidate.titleId,
  contentId: candidate.contentId,
  metadata: typeof metadata === 'string' ? metadata : JSON.stringify(metadata),
});
const catalogPage = (entries, next = entries.length, done = true, revision = 'c'.repeat(64)) => ({
  revision,
  entries,
  next,
  done,
});
function ps5CatalogReader(pages, info = { status: 503, body: {} }) {
  const paths = [];
  return {
    paths,
    read: async (_id, path, headers) => {
      paths.push(path);
      if (path === '/api/v1/management/status')
        return { status: 200, body: { protocol: 'ps5-management-v1', ready: true, catalog: true } };
      if (path === '/api/v1/console/catalog') {
        const offset = Number(headers['X-PackageFlow-Offset']);
        const page = typeof pages === 'function' ? pages(offset) : pages[offset];
        return page?.status ? page : { status: 200, body: page };
      }
      assert.equal(path, '/api/v1/console/info');
      return info;
    },
  };
}
test('PS5 temporary lookup failures stay unknown and retryable; malformed or unsupported replies do not', async () => {
  const candidate = { ...base, format: 'ffpfsc' };
  const pages = [catalogPage([catalogRegistration(candidate)])];
  for (const status of [408, 429, 500, 502, 503, 504]) {
    const fixture = ps5CatalogReader(pages, { status, body: {} });
    const result = await api.checkPs5InstalledPackage(
      'retryable',
      '192.168.1.5',
      candidate,
      undefined,
      fixture.read,
    );
    assert.equal(result.state, 'unavailable');
    assert.equal(result.transient, true);
  }
  for (const reply of [
    { status: 401, body: {} },
    { status: 404, body: {} },
    { status: 200, body: { title_id: candidate.titleId, installed: 'true' } },
  ]) {
    const fixture = ps5CatalogReader(pages, reply);
    const result = await api.checkPs5InstalledPackage(
      'permanent',
      '192.168.1.5',
      candidate,
      undefined,
      fixture.read,
    );
    assert.equal(result.state, 'unavailable');
    assert.notEqual(result.transient, true);
  }
  for (const error of [
    new DOMException('lookup deadline', 'TimeoutError'),
    new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }),
  ]) {
    const result = await api.checkPs5InstalledPackage(
      'network',
      '192.168.1.5',
      candidate,
      undefined,
      async () => {
        throw error;
      },
    );
    assert.equal(result.state, 'unavailable');
    assert.equal(result.transient, true);
  }
  const invalid = await api.checkPs5InstalledPackage(
    'invalid-json',
    '192.168.1.5',
    candidate,
    undefined,
    async () => {
      throw new SyntaxError('invalid response');
    },
  );
  assert.notEqual(invalid.transient, true);
  for (const code of ['UND_ERR_INVALID_ARG', 'UND_ERR_NOT_SUPPORTED', 'UND_ERR_HEADERS_OVERFLOW']) {
    const result = await api.checkPs5InstalledPackage(
      'protocol-error',
      '192.168.1.5',
      candidate,
      undefined,
      async () => {
        throw new TypeError('invalid protocol', { cause: { code } });
      },
    );
    assert.equal(result.state, 'unavailable');
    assert.notEqual(result.transient, true);
  }
  assert.notEqual(
    api.matchPs5InstalledGame(dlc, { installed: true, content_id: dlc.contentId, version: '01.00' })
      .transient,
    true,
  );
});
test('a changed native PS5 catalog is retryable without claiming absence; invalid metadata stays blocked', async () => {
  for (const [revision, transient] of [
    ['d'.repeat(64), true],
    ['invalid', false],
  ]) {
    const fixture = ps5CatalogReader([
      catalogPage([catalogRegistration(base)], 1, false),
      catalogPage([], 1, true, revision),
    ]);
    const result = await api.checkPs5InstalledPackage(
      'changed-catalog',
      '192.168.1.5',
      { ...base, format: 'folder' },
      undefined,
      fixture.read,
    );
    assert.equal(result.state, 'unavailable');
    assert.equal(result.transient === true, transient);
  }
  const malformed = ps5CatalogReader([
    catalogPage([catalogRegistration(base)], 1, false),
    { revision: 'd'.repeat(64) },
  ]);
  const result = await api.checkPs5InstalledPackage(
    'changed-invalid-catalog',
    '192.168.1.5',
    { ...base, format: 'folder' },
    undefined,
    malformed.read,
  );
  assert.equal(result.state, 'unavailable');
  assert.notEqual(result.transient, true);
});
test('a background lookup queued before installation starts never sends HTTP after the PS5 becomes busy', async () => {
  let release,
    entered,
    busy = false;
  const hold = new Promise((done) => {
    release = done;
  });
  const started = new Promise((done) => {
    entered = done;
  });
  const review = api.withPs5InstalledReview(['busy-at-dispatch'], async () => {
    entered();
    await hold;
  });
  await started;
  const fixture = ps5CatalogReader([catalogPage([])]);
  const candidate = { ...base, format: 'folder' };
  const background = api.checkPs5InstalledPackage(
    'busy-at-dispatch',
    '192.168.1.5',
    candidate,
    undefined,
    fixture.read,
    { background: true, backgroundReadAllowed: () => !busy },
  );
  assert.equal(fixture.paths.length, 0);
  busy = true;
  release();
  await review;
  const deferred = await background;
  assert.equal(deferred.state, 'unavailable');
  assert.equal(deferred.transient, true);
  assert.equal(
    fixture.paths.length,
    0,
    'queued background reads recheck the live queue at dispatch',
  );
  const foreground = await api.checkPs5InstalledPackage(
    'busy-at-dispatch',
    '192.168.1.5',
    candidate,
    undefined,
    fixture.read,
    { backgroundReadAllowed: () => false },
  );
  assert.equal(foreground.state, 'absent', 'the worker still requires a real foreground read');
  assert.deepEqual(fixture.paths, ['/api/v1/management/status', '/api/v1/console/catalog']);
});
test('a complete native PKG base registration allows manual review without claiming its files or version are installed', async () => {
  for (const registration of [
    catalogRegistration(base),
    catalogRegistration(base, { contentVersion: '01.03' }),
    catalogRegistration(base, { contentVersion: '01.05' }),
    { ...catalogRegistration(base), contentId: 'IV0000-CUSA95001_00-ANOTHERBASE00001' },
  ]) {
    const fixture = ps5CatalogReader([catalogPage([registration], 1, false), catalogPage([], 1)]);
    const result = await api.checkPs5InstalledPackage(
      'fixture',
      '192.168.1.5',
      { ...base, format: 'pkg' },
      undefined,
      fixture.read,
    );
    assert.equal(result.state, 'base-present');
    assert.match(result.detail, /зарегистрирована.*наличие файлов.*не подтверждены.*переустановку/);
    assert.equal(result.revision, 'c'.repeat(64));
    assert.deepEqual(fixture.paths, [
      '/api/v1/management/status',
      '/api/v1/console/catalog',
      '/api/v1/console/catalog',
    ]);
  }
});
test('a registered PKG base with an unknown version stays a manual overwrite review', async () => {
  for (const metadata of [{}, { contentVersion: '0' }, { CONTENT_VERSION: '' }]) {
    const fixture = ps5CatalogReader([catalogPage([catalogRegistration(base, metadata)])]);
    const result = await api.checkPs5InstalledPackage(
      'fixture',
      '192.168.1.5',
      { ...base, format: 'pkg' },
      undefined,
      fixture.read,
    );
    assert.equal(result.state, 'base-present');
    assert.match(result.detail, /версия.*не подтверждены.*переустановку/);
    assert.equal(result.revision, 'c'.repeat(64));
    assert.ok(!fixture.paths.includes('/api/v1/console/info'));
  }
});
test('PKG patches and DLC retain native source review and never use catalog registration as file presence', async () => {
  for (const candidate of [patch, dlc]) {
    const fixture = ps5CatalogReader([catalogPage([catalogRegistration(candidate)])]);
    const result = await api.checkPs5InstalledPackage(
      'fixture',
      '192.168.1.5',
      { ...candidate, format: 'pkg' },
      undefined,
      fixture.read,
    );
    assert.equal(result.state, 'unavailable');
    assert.equal(fixture.paths.at(-1), '/api/v1/console/info');
  }
  for (const { candidate, version, state } of [
    { candidate: patch, version: patch.appVersion, state: 'installed' },
    { candidate: patch, version: '01.03', state: 'absent' },
    { candidate: patch, version: '01.05', state: 'base-present' },
    { candidate: dlc, version: dlc.appVersion, state: 'unavailable' },
  ]) {
    // Legacy patch/DLC metadata handling stays unchanged; native game info
    // remains the authority even when catalog metadata cannot be decoded.
    const fixture = ps5CatalogReader([catalogPage([catalogRegistration(candidate, '{')])], {
      status: 200,
      body: {
        title_id: candidate.titleId,
        content_id: candidate.contentId,
        version,
        installed: true,
        source_available: true,
        path: '/data/games/fixture',
        sourceIdentity: 'e'.repeat(64),
      },
    });
    const result = await api.checkPs5InstalledPackage(
      'fixture',
      '192.168.1.5',
      { ...candidate, format: 'pkg' },
      undefined,
      fixture.read,
    );
    assert.equal(result.state, state);
    assert.equal(result.revision, 'e'.repeat(64));
    assert.equal(fixture.paths.at(-1), '/api/v1/console/info');
  }
});
test('PKG absence requires a complete stable catalog, including pages after a matching registration', async () => {
  const row = catalogRegistration();
  const invalid = [
    [catalogPage([], 0, false)],
    [catalogPage([row], 0)],
    [catalogPage([row, row])],
    [catalogPage([{ ...row, titleId: 'invalid' }])],
    [catalogPage([{ ...row, metadata: '{' }])],
    [catalogPage([{ ...row, metadata: 'null' }])],
    [catalogPage([{ ...row, metadata: '[]' }])],
    [catalogPage([catalogRegistration(base, { contentVersion: 4 })])],
    [catalogPage([], 0, true, 'invalid')],
    [catalogPage([row], 1, false), catalogPage([], 1, true, 'd'.repeat(64))],
    [catalogPage([row], 1, false), { status: 503, body: {} }],
    (offset) => catalogPage([{ ...row, titleId: 'CUSA95002' }], offset + 1, false),
  ];
  for (const pages of invalid) {
    const fixture = ps5CatalogReader(pages);
    const result = await api.checkPs5InstalledPackage(
      'fixture',
      '192.168.1.5',
      { ...base, format: 'pkg' },
      undefined,
      fixture.read,
    );
    assert.equal(result.state, 'unavailable');
    assert.ok(!fixture.paths.includes('/api/v1/console/info'));
  }
  const complete = ps5CatalogReader([catalogPage([])]);
  assert.equal(
    (
      await api.checkPs5InstalledPackage(
        'fixture',
        '192.168.1.5',
        { ...base, format: 'pkg' },
        undefined,
        complete.read,
      )
    ).state,
    'absent',
  );
});
test('Folder, images and direct legacy candidates retain their SMP source identity review', async () => {
  for (const format of ['folder', 'ufs2', 'exfat', 'pfs', 'ffpfsc', undefined]) {
    const fixture = ps5CatalogReader([catalogPage([catalogRegistration()])], {
      status: 200,
      body: {
        title_id: base.titleId,
        content_id: base.contentId,
        version: base.appVersion,
        installed: true,
        source_available: true,
        path: '/data/games/fixture',
        sourceIdentity: 'e'.repeat(64),
      },
    });
    const result = await api.checkPs5InstalledPackage(
      'fixture',
      '192.168.1.5',
      { ...base, format },
      undefined,
      fixture.read,
    );
    assert.equal(result.state, 'installed');
    assert.equal(result.revision, 'e'.repeat(64));
    assert.equal(fixture.paths.at(-1), '/api/v1/console/info');
  }
});
test('already present base continues to new patches and the next game without falsely marking its selected version installed', async () => {
  const q = api.ps5BlankQueue('test', '192.168.1.5'),
    seen = [],
    marks = [];
  const item = (id, order = 0, branch = 'ps5:PPSA95001') => ({
    packageId: id,
    title: id,
    titleId: branch.split(':')[1],
    fileName: `${id}.pkg`,
    size: 100,
    type: order ? 'Патч' : 'Игра',
    platform: 'ps5',
    format: 'pkg',
    order,
    branch,
  });
  const runner = new api.Ps5QueueRunner(
    q,
    () => {},
    {
      async run(v) {
        seen.push(v.packageId);
        return v.packageId === 'base'
          ? { state: 'skipped', alreadyPresent: true, detail: 'exists' }
          : { state: 'installed' };
      },
      async cancel() {},
    },
    5,
    (v) => marks.push(v.packageId),
  );
  runner.enqueue([item('base'), item('patch', 1), item('next', 0, 'ps5:PPSA95002')]);
  await runner.settled();
  assert.deepEqual(seen, ['base', 'patch', 'next']);
  assert.deepEqual(marks, ['patch', 'next']);
  assert.equal(q.status, 'completed');
});
test('production PS5 driver skips existing PKG/Folder before hashing, waits on uncertainty, and only an explicit PKG approval bypasses protection', async () => {
  const oldFetch = globalThis.fetch;
  try {
    const p = api.saveConsoleProfile({ name: 'Fixture PS5', platform: 'ps5', ip: '192.168.1.5' })
      .consoles[0];
    writeFileSync(
      join(process.env.PACKAGEFLOW_DATA_DIR, 'ps5-service-keys.json'),
      JSON.stringify({ [p.ip]: 'a'.repeat(64) }),
    );
    const pkg = {
      ...base,
      title: 'Fixture',
      titleId: 'PPSA95001',
      contentId: 'IV0000-PPSA95001_00-PACKAGEFLOWUI001',
      appVersion: '01.000.001',
      platform: 'ps5',
      format: 'pkg',
      fileName: 'test.pkg',
      contentType: 'PS5GD',
      size: 8192,
      path: join(work, 'test.pkg'),
      libraryRoot: work,
      sourceModifiedAt: 1,
      icon: { offset: 0, size: 0 },
      iconSize: 0,
    };
    writeFileSync(pkg.path, putPs5ParamPkg(Buffer.alloc(8192)));
    writeFileSync(
      join(process.env.PACKAGEFLOW_DATA_DIR, 'package-library.json'),
      JSON.stringify({ version: 2, packages: [pkg], deliveries: {} }),
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
      folder: { schemaVersion: 1, route: 'staged-folder', ready: true, platforms: ['ps5'] },
      images: {
        schemaVersion: 1,
        route: 'staged-image',
        ready: true,
        reason: 'ready',
        platforms: ['ps5'],
        formats: ['ufs2', 'exfat', 'pfs', 'ffpfsc'],
        protocol: 'image-registration-v1',
        backend: 'ShadowMountPlus-1.7beta3',
        registrationReceipt: true,
      },
    };
    const writes = [];
    let unavailable = false,
      found = true,
      infoReads = 0;
    globalThis.fetch = async (url, opts = {}) => {
      const path = new URL(url).pathname;
      if (opts.method === 'POST') writes.push(path);
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
        return response({ service: ready.service, storageRead: false });
      if (path === '/api/v1/install/readiness') return response(ready);
      if (path === '/api/v1/management/status')
        return response({ protocol: 'ps5-management-v1', ready: true, catalog: true });
      if (path === '/api/v1/console/catalog')
        return unavailable
          ? response({}, 503)
          : response({
              revision: 'b'.repeat(64),
              entries: found
                ? [
                    {
                      titleId: pkg.titleId,
                      contentId: pkg.contentId,
                      metadata: JSON.stringify({ contentVersion: pkg.appVersion }),
                    },
                  ]
                : [],
              next: found ? 1 : 0,
              done: true,
            });
      if (path === '/api/v1/console/info') {
        infoReads++;
        return response({
          title_id: pkg.titleId,
          content_id: pkg.contentId,
          version: pkg.appVersion,
          installed: true,
          source_available: true,
          path: '/user/app/PPSA95001/app.pkg',
        });
      }
      if (path === '/api/v1/transfers/begin') throw new Error('transfer reached explicitly');
      assert.fail(path);
    };
    await api.probeConsoleProfile(p.id);
    const driver = api.ps5QueueDriver(p.id),
      item = () => ({
        ...pkg,
        packageId: pkg.id,
        order: 0,
        branch: 'ps5:PPSA95001',
        transferId: 'b'.repeat(32),
        state: 'pending',
        detail: '',
        bytesSent: 0,
      }),
      signal = new AbortController().signal;
    let v = item();
    let result = await driver.run(v, signal, (x) => Object.assign(v, x));
    assert.equal(result.state, 'skipped');
    assert.equal(result.confirmation, undefined);
    assert.equal(result.alreadyPresent, true);
    assert.equal(v.hash, undefined);
    assert.deepEqual(writes, []);
    assert.equal(infoReads, 0);
    const legacyPreview = await api.installedPackagePreviewChecker()(p, {
      ...pkg,
      format: undefined,
    });
    assert.equal(legacyPreview.state, 'base-present');
    assert.equal(infoReads, 0);
    const folder = {
      ...pkg,
      id: 'folder',
      format: 'folder',
      fileName: 'folder',
      path: join(work, 'folder'),
    };
    mkdirSync(join(folder.path, 'sce_sys'), { recursive: true });
    writeFileSync(join(folder.path, 'eboot.bin'), Buffer.alloc(64));
    writeFileSync(join(folder.path, 'sce_sys/param.json'), JSON.stringify(ps5ParamFixture()));
    writeFileSync(
      join(process.env.PACKAGEFLOW_DATA_DIR, 'package-library.json'),
      JSON.stringify({ version: 2, packages: [pkg, folder], deliveries: {} }),
    );
    const f = { ...item(), packageId: folder.id, format: 'folder' };
    assert.equal((await driver.run(f, signal, (x) => Object.assign(f, x))).state, 'installed');
    assert.equal(f.hash, undefined);
    assert.deepEqual(writes, []);
    assert.equal(infoReads, 1);
    unavailable = true;
    v = item();
    assert.equal((await driver.run(v, signal, (x) => Object.assign(v, x))).state, 'waiting');
    assert.deepEqual(writes, []);
    unavailable = false;
    v = { ...item(), overwriteApproved: true };
    await assert.rejects(
      driver.run(v, signal, (x) => Object.assign(v, x)),
      /transfer reached explicitly/,
    );
    assert.deepEqual(writes, ['/api/v1/transfers/begin']);
    // A fresh preview does not retain the previous positive snapshot after removal.
    found = false;
    assert.equal((await api.checkPs5InstalledPackage(p.id, p.ip, pkg, signal)).state, 'absent');
  } finally {
    globalThis.fetch = oldFetch;
  }
});
test.after(() => {
  if (oldData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
  else process.env.PACKAGEFLOW_DATA_DIR = oldData;
  rmSync(work, { recursive: true, force: true });
});
