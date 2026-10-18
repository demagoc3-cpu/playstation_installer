import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

/** Minimal owned UFS2 image with sce_sys/param.json (same layout as ps5-image.test). */
function ufs2(param) {
  const b = Buffer.alloc(1024 * 1024),
    sb = 65536;
  b.writeUInt32LE(0x19540119, sb + 0x55c);
  b.writeUInt32LE(4096, sb + 48);
  b.writeUInt32LE(512, sb + 52);
  b.writeUInt32LE(1, sb + 44);
  b.writeUInt32LE(32, sb + 184);
  b.writeUInt32LE(b.length / 512, sb + 188);
  b.writeUInt32LE(32, sb + 16);
  function inode(id, dir, size, pointer) {
    const at = 32 * 512 + id * 256;
    b.writeUInt16LE(dir ? 0x4000 : 0x8000, at);
    b.writeBigUInt64LE(BigInt(size), at + 16);
    b.writeBigUInt64LE(BigInt(pointer), at + 112);
  }
  function entry(at, id, name, dir) {
    const len = Math.ceil((8 + name.length + 1) / 4) * 4;
    b.writeUInt32LE(id, at);
    b.writeUInt16LE(len, at + 4);
    b[at + 6] = dir ? 4 : 8;
    b[at + 7] = name.length;
    b.write(name, at + 8);
    return len;
  }
  const rootSize =
    entry(300 * 512, 3, 'sce_sys', true) + entry(300 * 512 + 16, 5, 'eboot.bin', false);
  const sysSize = entry(308 * 512, 4, 'param.json', false);
  inode(2, true, rootSize, 300);
  inode(3, true, sysSize, 308);
  inode(4, false, param.length, 316);
  inode(5, false, 16, 324);
  param.copy(b, 316 * 512);
  b.write('owned SELF bytes', 324 * 512);
  return b;
}

// Services before 029d cannot clear an orphaned registration after deletion.
let serviceBuild = 'ps5-service-pkg-context-029d-sse2';

test('an own PS5 image whose source was deleted can be installed again; a store game with the same shape cannot', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-ps5-image-reinstall-')),
    oldData = process.env.PACKAGEFLOW_DATA_DIR,
    oldFetch = globalThis.fetch;
  const keepAlive = setInterval(() => {}, 1000);
  const data = join(work, 'data');
  mkdirSync(data);
  process.env.PACKAGEFLOW_DATA_DIR = data;
  let api, own, store;
  try {
    const out = join(work, 'api.mjs');
    await build({
      stdin: {
        contents:
          "export * from './server/utils/device-installation'; export * from './server/utils/console-profiles'; export * from './server/utils/ps5-installation-queue';",
        resolveDir: resolve('.'),
      },
      outfile: out,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
      // Some console-games dependencies are CommonJS.
      banner: {
        js: "import { createRequire as __pfRequire } from 'node:module'; const require = __pfRequire(import.meta.url);",
      },
    });
    api = await import(pathToFileURL(out).href);
    api.saveConsoleProfile({ name: 'Own PS5', ip: '192.0.2.5', platform: 'ps5' });
    api.saveConsoleProfile({ name: 'Store PS5', ip: '192.0.2.6', platform: 'ps5' });
    const profiles = api.getConsoleProfiles().consoles;
    own = profiles.find((p) => p.ip === '192.0.2.5');
    store = profiles.find((p) => p.ip === '192.0.2.6');
    writeFileSync(
      join(data, 'ps5-service-keys.json'),
      JSON.stringify({ [own.ip]: 'b'.repeat(64), [store.ip]: 'c'.repeat(64) }),
    );
    const image = {
      id: 'ufs2-fixture',
      title: 'PackageFlow UI UFS2 Test',
      titleId: 'PPSA95002',
      contentId: 'IV0000-PPSA95002_00-PACKAGEFLOWUI001',
      appVersion: '01.000.001',
      platform: 'ps5',
      format: 'ufs2',
      contentType: 'PS5GD',
      installOrder: 0,
      type: 'Игра',
      fileName: 'PPSA95002.ffpkg',
      path: join(work, 'PPSA95002.ffpkg'),
      size: 1024 * 1024,
      libraryRoot: work,
      sourceModifiedAt: 1,
      iconSize: 0,
      icon: { offset: 0, size: 0 },
    };
    writeFileSync(
      image.path,
      ufs2(
        Buffer.from(
          JSON.stringify({
            titleId: image.titleId,
            contentId: image.contentId,
            contentVersion: image.appVersion,
            applicationCategoryType: 0,
            requiredSystemSoftwareVersion: '0x0100000000000000',
            sdkVersion: '0x0800000000000000',
            localizedParameters: {
              defaultLanguage: 'en-US',
              'en-US': { titleName: image.title },
            },
          }),
        ),
      ),
    );
    writeFileSync(
      join(data, 'package-library.json'),
      JSON.stringify({ version: 2, packages: [image], deliveries: {} }),
    );
    // WEB installed this image on the own PS5 before (queue record).
    mkdirSync(join(data, 'consoles', own.id), { recursive: true });
    writeFileSync(
      join(data, 'consoles', own.id, 'ps5-installation-queue.json'),
      JSON.stringify({
        version: 1,
        consoleId: own.id,
        psIp: own.ip,
        transport: 'service',
        status: 'completed',
        createdAt: 1,
        updatedAt: 2,
        message: '',
        id: 'q'.repeat(8),
        history: [],
        items: [
          {
            packageId: image.id,
            title: image.title,
            fileName: image.fileName,
            size: image.size,
            type: image.type,
            titleId: image.titleId,
            branch: 'ps5:PPSA95002',
            order: 0,
            platform: 'ps5',
            format: 'ufs2',
            appVersion: image.appVersion,
            contentId: image.contentId,
            transferId: 'a'.repeat(32),
            state: 'installed',
            detail: 'PS5 подтвердила системную регистрацию образа',
            bytesSent: image.size,
            createdAt: 1,
          },
        ],
      }),
    );
    const writes = [],
      response = (body) => new Response(JSON.stringify(body), { status: 200 });
    globalThis.fetch = async (url, options = {}) => {
      const path = new URL(url).pathname;
      if (options.method === 'POST') writes.push(path);
      if (path === '/health')
        return response({
          apiVersion: 'v1',
          pid: 91,
          firmwareRead: true,
          firmwareRaw: '0x13600007',
          serviceReport: {
            service: 'PackageFlowService-PS5',
            platform: 'ps5',
            consoleVerified: true,
            version: '0.1.29-dev',
            buildId: serviceBuild,
          },
        });
      if (path === '/api/v1/capabilities')
        return response({ service: 'PackageFlowService-PS5', capabilities: {} });
      if (path === '/api/v1/system')
        return response({
          service: 'PackageFlowService-PS5',
          storageRead: true,
          freeBytes: 10 * 1024 ** 3,
          totalBytes: 20 * 1024 ** 3,
        });
      if (path === '/api/v1/install/readiness')
        return response({
          service: 'PackageFlowService-PS5',
          schemaVersion: 1,
          route: 'staged-pkg',
          ready: false,
          reason: 'installer_unavailable',
          formats: [],
          platforms: [],
          exactVersionReceipt: false,
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
        });
      if (path === '/api/v1/management/status')
        return response({
          protocol: 'ps5-management-v1',
          ready: true,
          catalog: true,
          consoleControl: true,
        });
      if (path === '/api/v1/console/catalog')
        return response({
          revision: 'd'.repeat(64),
          total: 1,
          entries: [{ titleId: image.titleId, contentId: image.contentId, metadata: '{}' }],
          next: 1,
          done: true,
        });
      // Registered, but neither a Folder nor an image source (deleted, or a store game).
      if (path === '/api/v1/console/info')
        return response({
          status: 0,
          title_id: image.titleId,
          title_name: image.title,
          platform: 'ps5',
          content_id: image.contentId,
          version: image.appVersion,
          path: '',
          runtime_path: '',
          source_type: 'unknown',
          image_type: '',
          installed: true,
          managed: false,
          mounted: false,
          source_available: false,
          can_uninstall: false,
          can_manage_source: false,
          sourceIdentity: 'e'.repeat(64),
        });
      assert.fail(`Unexpected operation ${path}`);
    };

    const preview = await api.previewDeviceInstall({ packageIds: [image.id] }, [own.id, store.id]);
    const ownDevice = preview.devices.find((d) => d.profile.id === own.id),
      storeDevice = preview.devices.find((d) => d.profile.id === store.id);
    assert.equal(ownDevice.installedPackages.length, 1);
    assert.equal(ownDevice.installedPackages[0].canOverwrite, true);
    assert.match(ownDevice.installedPackages[0].detail, /удалены/);
    assert.equal(storeDevice.installedPackages.length, 1);
    assert.equal(storeDevice.installedPackages[0].canOverwrite, false);
    assert.match(storeDevice.installedPackages[0].reinstallReason, /На консоли/);

    // A store-like registration cannot be overwritten even if the browser asks.
    const refused = await api.installDeviceBatch(
      'b'.repeat(32),
      { packageIds: [image.id] },
      [store.id],
      'localhost:3000',
      { [store.id]: [image.id] },
      { [store.id]: storeDevice.reviewToken },
    );
    assert.notEqual(refused.results[0].state, 'queued');

    const result = await api.installDeviceBatch(
      'a'.repeat(32),
      { packageIds: [image.id] },
      [own.id],
      'localhost:3000',
      { [own.id]: [image.id] },
      { [own.id]: ownDevice.reviewToken },
    );
    assert.equal(result.results[0].state, 'queued', result.results[0].message);
    const queued = api.getPs5Queue(own.id).items.find((item) => item.state !== 'installed');
    assert.equal(queued.overwriteApproved, true, 'the approval reaches the image queue');
    assert.deepEqual(writes, [], 'review and admission send nothing to the console');
    await api.pausePs5Queue(own.id, api.getPs5Queue(own.id).id);
  } finally {
    if (api && own) {
      const q = api.getPs5Queue(own.id);
      if (q.status === 'running') await api.pausePs5Queue(own.id, q.id);
    }
    globalThis.fetch = oldFetch;
    clearInterval(keepAlive);
    if (oldData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = oldData;
    rmSync(work, { recursive: true, force: true });
  }
});

test('an image installed by another WEB is reinstallable on service proof; blocked cases say why', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-ps5-image-other-web-')),
    oldData = process.env.PACKAGEFLOW_DATA_DIR,
    oldFetch = globalThis.fetch;
  const keepAlive = setInterval(() => {}, 1000);
  const data = join(work, 'data');
  mkdirSync(data);
  process.env.PACKAGEFLOW_DATA_DIR = data;
  let api, managed;
  try {
    const out = join(work, 'api.mjs');
    await build({
      stdin: {
        contents:
          "export * from './server/utils/device-installation'; export * from './server/utils/console-profiles'; export * from './server/utils/ps5-installation-queue';",
        resolveDir: resolve('.'),
      },
      outfile: out,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
      banner: {
        js: "import { createRequire as __pfRequire } from 'node:module'; const require = __pfRequire(import.meta.url);",
      },
    });
    api = await import(pathToFileURL(out).href);
    // No queue record on this WEB for any of them: they were installed elsewhere.
    const consoles = [
      ['192.0.2.7', { canManage: true, control: true }],
      ['192.0.2.8', { canManage: true, control: false }],
      ['192.0.2.9', { canManage: false, control: true }],
    ];
    for (const [ip] of consoles) api.saveConsoleProfile({ name: ip, ip, platform: 'ps5' });
    const profiles = api.getConsoleProfiles().consoles;
    const byIp = Object.fromEntries(consoles);
    writeFileSync(
      join(data, 'ps5-service-keys.json'),
      JSON.stringify(Object.fromEntries(consoles.map(([ip], i) => [ip, String(i).repeat(64)]))),
    );
    const image = {
      id: 'ufs2-other-web',
      title: 'Other WEB Image',
      titleId: 'PPSA95003',
      contentId: 'IV0000-PPSA95003_00-PACKAGEFLOWUI001',
      appVersion: '01.000.001',
      platform: 'ps5',
      format: 'ufs2',
      contentType: 'PS5GD',
      installOrder: 0,
      type: 'Игра',
      fileName: 'PPSA95003.ffpkg',
      path: join(work, 'PPSA95003.ffpkg'),
      size: 1024 * 1024,
      libraryRoot: work,
      sourceModifiedAt: 1,
      iconSize: 0,
      icon: { offset: 0, size: 0 },
    };
    writeFileSync(
      image.path,
      ufs2(
        Buffer.from(
          JSON.stringify({
            titleId: image.titleId,
            contentId: image.contentId,
            contentVersion: image.appVersion,
            applicationCategoryType: 0,
            requiredSystemSoftwareVersion: '0x0100000000000000',
            sdkVersion: '0x0800000000000000',
            localizedParameters: { defaultLanguage: 'en-US', 'en-US': { titleName: image.title } },
          }),
        ),
      ),
    );
    writeFileSync(
      join(data, 'package-library.json'),
      JSON.stringify({ version: 2, packages: [image], deliveries: {} }),
    );
    const writes = [],
      response = (body) => new Response(JSON.stringify(body), { status: 200 });
    globalThis.fetch = async (url, options = {}) => {
      const { hostname, pathname: path } = new URL(url);
      const fixture = byIp[hostname];
      if (options.method === 'POST') writes.push(path);
      if (path === '/health')
        return response({
          apiVersion: 'v1',
          pid: 91,
          firmwareRead: true,
          firmwareRaw: '0x13600007',
          serviceReport: {
            service: 'PackageFlowService-PS5',
            platform: 'ps5',
            consoleVerified: true,
            version: '0.1.29-dev',
            buildId: serviceBuild,
          },
        });
      if (path === '/api/v1/capabilities')
        return response({ service: 'PackageFlowService-PS5', capabilities: {} });
      if (path === '/api/v1/system')
        return response({
          service: 'PackageFlowService-PS5',
          storageRead: true,
          freeBytes: 10 * 1024 ** 3,
          totalBytes: 20 * 1024 ** 3,
        });
      if (path === '/api/v1/install/readiness')
        return response({
          service: 'PackageFlowService-PS5',
          schemaVersion: 1,
          route: 'staged-pkg',
          ready: false,
          reason: 'installer_unavailable',
          formats: [],
          platforms: [],
          exactVersionReceipt: false,
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
        });
      if (path === '/api/v1/management/status')
        return response({
          protocol: 'ps5-management-v1',
          ready: true,
          catalog: true,
          consoleControl: true,
          consoleSourceControl: fixture.control,
        });
      if (path === '/api/v1/console/catalog')
        return response({
          revision: 'd'.repeat(64),
          total: 1,
          entries: [{ titleId: image.titleId, contentId: image.contentId, metadata: '{}' }],
          next: 1,
          done: true,
        });
      // Registered from a mounted image the service published (or did not).
      if (path === '/api/v1/console/info')
        return response({
          status: 0,
          title_id: image.titleId,
          title_name: image.title,
          platform: 'ps5',
          content_id: image.contentId,
          version: image.appVersion,
          path: '/data/packageflow/images/PPSA95003.ffpkg',
          runtime_path: '/mnt/sandbox/pfsmnt/PPSA95003-app0',
          source_type: 'image',
          image_type: 'ufs2',
          installed: true,
          managed: fixture.canManage,
          mounted: true,
          source_available: true,
          can_uninstall: fixture.canManage,
          can_manage_source: fixture.canManage,
          sourceIdentity: 'f'.repeat(64),
        });
      assert.fail(`Unexpected operation ${path}`);
    };

    const ids = profiles.map((p) => p.id);
    const preview = await api.previewDeviceInstall({ packageIds: [image.id] }, ids);
    const row = (ip) => preview.devices.find((d) => d.profile.ip === ip).installedPackages[0];
    assert.equal(row('192.0.2.7').canOverwrite, true, 'service proof is enough');
    assert.equal(row('192.0.2.8').canOverwrite, false);
    assert.match(row('192.0.2.8').reinstallReason, /Разрешите изменение файлов игр/);
    assert.equal(row('192.0.2.9').canOverwrite, false);
    assert.match(row('192.0.2.9').reinstallReason, /не управляет/);

    // 029c would delete the files and then refuse to clear the registration.
    serviceBuild = 'ps5-service-pkg-context-029c-sse2';
    const old = await api.previewDeviceInstall({ packageIds: [image.id] }, ids);
    const oldRow = old.devices.find((d) => d.profile.ip === '192.0.2.7').installedPackages[0];
    assert.equal(oldRow.canOverwrite, false);
    assert.match(oldRow.reinstallReason, /029d/);
    serviceBuild = 'ps5-service-pkg-context-029d-sse2';

    managed = profiles.find((p) => p.ip === '192.0.2.7');
    const device = preview.devices.find((d) => d.profile.id === managed.id);
    const result = await api.installDeviceBatch(
      'c'.repeat(32),
      { packageIds: [image.id] },
      [managed.id],
      'localhost:3000',
      { [managed.id]: [image.id] },
      { [managed.id]: device.reviewToken },
    );
    assert.equal(result.results[0].state, 'queued', result.results[0].message);
    assert.equal(api.getPs5Queue(managed.id).items[0].overwriteApproved, true);
    assert.deepEqual(writes, [], 'review and admission send nothing to the console');
    await api.pausePs5Queue(managed.id, api.getPs5Queue(managed.id).id);
  } finally {
    if (api && managed) {
      const q = api.getPs5Queue(managed.id);
      if (q.status === 'running') await api.pausePs5Queue(managed.id, q.id);
    }
    globalThis.fetch = oldFetch;
    clearInterval(keepAlive);
    if (oldData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = oldData;
    rmSync(work, { recursive: true, force: true });
  }
});
