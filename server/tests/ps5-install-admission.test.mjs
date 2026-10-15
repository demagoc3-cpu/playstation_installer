import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { putPs5ParamPkg } from './fixtures/ps5-param-pkg.mjs';

test('an installed PS5 PKG can be selected and explicitly queued for reinstall while its unchanged worker waits for live readiness', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-ps5-admission-')),
    oldData = process.env.PACKAGEFLOW_DATA_DIR,
    oldFetch = globalThis.fetch;
  const keepAlive = setInterval(() => {}, 1000);
  const data = join(work, 'data');
  mkdirSync(data);
  process.env.PACKAGEFLOW_DATA_DIR = data;
  let api, profile;
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
    });
    api = await import(pathToFileURL(out).href);
    profile = api.saveConsoleProfile({ name: 'PS5 fixture', ip: '192.0.2.5', platform: 'ps5' })
      .consoles[0];
    writeFileSync(
      join(data, 'ps5-service-keys.json'),
      JSON.stringify({ [profile.ip]: 'b'.repeat(64) }),
    );
    const pkg = {
      id: 'astro-fixture',
      title: 'ASTRO fixture',
      titleId: 'PPSA95001',
      contentId: 'IV0000-PPSA95001_00-PACKAGEFLOWUI001',
      appVersion: '01.000.001',
      platform: 'ps5',
      format: 'pkg',
      contentType: 'PS5GD',
      installOrder: 0,
      type: 'Игра',
      fileName: 'astro.pkg',
      path: join(work, 'astro.pkg'),
      size: 8192,
      libraryRoot: work,
      sourceModifiedAt: 1,
      iconSize: 0,
      icon: { offset: 0, size: 0 },
    };
    writeFileSync(pkg.path, putPs5ParamPkg(Buffer.alloc(pkg.size)));
    writeFileSync(
      join(data, 'package-library.json'),
      JSON.stringify({ version: 2, packages: [pkg], deliveries: {} }),
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
            version: '0.1.27-dev',
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
        return response({ protocol: 'ps5-management-v1', ready: true, catalog: true });
      if (path === '/api/v1/console/catalog')
        return response({
          revision: 'd'.repeat(64),
          total: 1,
          entries: [{ titleId: pkg.titleId, contentId: pkg.contentId, metadata: '{}' }],
          next: 1,
          done: true,
        });
      if (path === '/api/v1/console/info')
        return response({
          title_id: pkg.titleId,
          content_id: pkg.contentId,
          version: '0',
          installed: true,
          source_available: false,
          sourceIdentity: 'e'.repeat(64),
        });
      assert.fail(`Unexpected operation ${path}`);
    };
    const preview = await api.previewDeviceInstall({ packageIds: [pkg.id] }, [profile.id]),
      device = preview.devices[0];
    assert.equal(device.eligible, true, device.reason);
    assert.equal(device.installedPackages.length, 1);
    assert.equal(device.installedPackages[0].canOverwrite, true);
    const result = await api.installDeviceBatch(
      'a'.repeat(32),
      { packageIds: [pkg.id] },
      [profile.id],
      'localhost:3000',
      { [profile.id]: [pkg.id] },
      { [profile.id]: device.reviewToken },
    );
    assert.equal(result.results[0].state, 'queued', result.results[0].message);
    const queue = api.getPs5Queue(profile.id),
      item = queue.items[0];
    assert.equal(
      item.overwriteApproved,
      true,
      'explicit reinstall approval reaches the original queue',
    );
    assert.equal(item.bytesSent, 0);
    assert.equal(item.hash, undefined);
    assert.deepEqual(
      writes,
      [],
      'selection/admission does not dispatch a payload, transfer, or install',
    );
    await api.pausePs5Queue(profile.id, queue.id);
  } finally {
    if (api && profile) {
      const q = api.getPs5Queue(profile.id);
      if (q.status === 'running') await api.pausePs5Queue(profile.id, q.id);
    }
    globalThis.fetch = oldFetch;
    clearInterval(keepAlive);
    if (oldData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = oldData;
    rmSync(work, { recursive: true, force: true });
  }
});
