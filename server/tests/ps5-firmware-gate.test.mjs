import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ps5ParamFixture, putPs5ParamPkg } from './fixtures/ps5-param-pkg.mjs';

test('real PARAM overrides stale index; incompatible/unknown PS5 sources never transfer or enter a batch', async () => {
  const work = await mkdtemp(join(tmpdir(), 'pf-firmware-gate-')),
    previousData = process.env.PACKAGEFLOW_DATA_DIR,
    previousFetch = globalThis.fetch;
  const data = join(work, 'data');
  await mkdir(data);
  process.env.PACKAGEFLOW_DATA_DIR = data;
  try {
    const bundle = join(work, 'api.mjs');
    await build({
      stdin: {
        contents:
          "export * from './server/utils/ps5-installation-queue'; export * from './server/utils/ps5-queue-driver'; export * from './server/utils/ps5-installation-firmware'; export * from './server/utils/console-profiles'; export * from './shared/device-eligibility';",
        resolveDir: resolve('.'),
      },
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const api = await import(pathToFileURL(bundle).href),
      signal = new AbortController().signal;
    const profile = api.saveConsoleProfile({
      name: 'Fixture PS5',
      platform: 'ps5',
      ip: '192.168.1.5',
    }).consoles[0];
    await writeFile(
      join(data, 'ps5-service-keys.json'),
      JSON.stringify({ [profile.ip]: 'a'.repeat(64) }),
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
    };
    let rawFirmware = '0x13600007',
      reported = true;
    const writes = [];
    globalThis.fetch = async (url, options = {}) => {
      const path = new URL(url).pathname;
      assert.equal(new URL(url).hostname, profile.ip);
      if (options.method === 'POST') writes.push(path);
      const json = (body) => new Response(JSON.stringify(body), { status: 200 });
      if (path === '/health')
        return json({
          apiVersion: 'v1',
          firmwareRead: reported,
          firmwareRaw: rawFirmware,
          serviceReport: { service: ready.service, consoleVerified: true },
        });
      if (path === '/api/v1/capabilities')
        return json({
          service: ready.service,
          capabilities: { installPs5Content: true, installPs4Pkg: true },
        });
      if (path === '/api/v1/system') return json({ service: ready.service, storageRead: false });
      if (path === '/api/v1/install/readiness') return json(ready);
      assert.fail(`No mutating/transfer call expected: ${path}`);
    };
    const future = {
      id: 'future',
      title: 'Future fixture',
      fileName: 'future.pkg',
      path: join(work, 'future.pkg'),
      platform: 'ps5',
      format: 'pkg',
      type: 'Игра',
      contentType: 'PS5GD',
      size: 8192,
      titleId: 'PPSA95001',
      contentId: 'IV0000-PPSA95001_00-PACKAGEFLOWUI001',
      appVersion: '01.000.001',
      installOrder: 0,
      libraryRoot: work,
      sourceModifiedAt: 1,
      iconSize: 0,
      icon: { offset: 0, size: 0 },
      requiredFirmware: '1.00',
    };
    const compatible = { ...future, id: 'compatible', path: join(work, 'compatible.pkg') };
    await writeFile(
      future.path,
      putPs5ParamPkg(Buffer.alloc(8192), { requiredSystemSoftwareVersion: '0x1400000000000000' }),
    );
    await writeFile(compatible.path, putPs5ParamPkg(Buffer.alloc(8192)));
    const folder = { ...future, id: 'folder', format: 'folder', path: join(work, 'folder') };
    await mkdir(join(folder.path, 'sce_sys'), { recursive: true });
    await writeFile(join(folder.path, 'eboot.bin'), Buffer.alloc(64));
    await writeFile(
      join(folder.path, 'sce_sys/param.json'),
      JSON.stringify(ps5ParamFixture({ requiredSystemSoftwareVersion: '0x1400000000000000' })),
    );
    await writeFile(
      join(data, 'package-library.json'),
      JSON.stringify({ version: 2, packages: [future, compatible, folder], deliveries: {} }),
    );
    const snapshot = (await api.probeConsoleProfile(profile.id)).consoles[0];
    assert.match(
      api.deviceInstallReason(snapshot, [{ ...future, requiredFirmware: '14.00' }], 8192),
      /14.00.*13.60/,
    );
    assert.equal((await api.assessPs5SourceFirmware('13.60', compatible)).state, 'compatible');
    await assert.rejects(
      api.startPs5Queue({ consoleId: profile.id, packageIds: ['compatible', 'future'] }),
      /PARAM 14.00.*13.60.*Набор не отправлен/,
    );
    assert.equal(
      api.getPs5Queue(profile.id).items.length,
      0,
      'whole batch rejected before persistence',
    );
    const driver = api.ps5QueueDriver(profile.id);
    const queueItem = (source) => ({
      ...source,
      packageId: source.id,
      transferId: 'b'.repeat(32),
      order: 0,
      bytesSent: 0,
      state: 'pending',
      detail: '',
    });
    for (const source of [future, folder]) {
      const item = queueItem(source);
      await assert.rejects(
        driver.run(item, signal, (patch) => Object.assign(item, patch)),
        /PARAM 14.00.*13.60/,
      );
      assert.equal(item.hash, undefined, 'admission happens before hashing');
      assert.equal(item.bytesSent, 0);
    }
    // Recovery/start reads current firmware, not the persisted 13.60 profile.
    rawFirmware = '0x07500000';
    await assert.rejects(
      driver.run(queueItem(compatible), signal, () => {}),
      /8.00.*7.50/,
    );
    rawFirmware = '0x13600007';
    reported = false;
    assert.equal((await driver.run(queueItem(compatible), signal, () => {})).state, 'waiting');
    reported = true;
    for (const [fields, state] of [
      [{ requiredSystemSoftwareVersion: undefined, sdkVersion: undefined }, 'unverified'],
      [
        { requiredSystemSoftwareVersion: '0x0500000000000000', sdkVersion: '0x1400000000000000' },
        'incompatible',
      ],
      [
        { requiredSystemSoftwareVersion: '0x0000000000000000', sdkVersion: '0x0000000000000000' },
        'compatible',
      ],
      [{ contentVersion: '01.000.002' }, 'unverified'],
    ]) {
      await writeFile(compatible.path, putPs5ParamPkg(Buffer.alloc(8192), fields));
      assert.equal((await api.assessPs5SourceFirmware('13.60', compatible)).state, state);
    }
    await writeFile(compatible.path, Buffer.alloc(8192));
    await assert.rejects(
      driver.run(queueItem(compatible), signal, () => {}),
      /PARAM/,
    );
    assert.deepEqual(writes, [], 'no chunks, publication, install or mount sent');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = previousData;
    await rm(work, { recursive: true, force: true });
  }
});
