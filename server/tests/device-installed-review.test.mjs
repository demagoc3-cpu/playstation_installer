import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

function pkg(values) {
  const keys = Buffer.concat(Object.keys(values).map((k) => Buffer.from(`${k}\0`))),
    data = Buffer.concat(Object.values(values).map((v) => Buffer.from(`${v}\0`))),
    count = Object.keys(values).length;
  const s = Buffer.alloc(20 + 16 * count + keys.length + data.length);
  s.writeUInt32LE(0x46535000);
  s.writeUInt32LE(20 + count * 16, 8);
  s.writeUInt32LE(20 + count * 16 + keys.length, 12);
  s.writeUInt32LE(count, 16);
  let k = 0,
    v = 0;
  Object.entries(values).forEach(([key, value], i) => {
    const at = 20 + i * 16,
      n = Buffer.byteLength(value) + 1;
    s.writeUInt16LE(k, at);
    s.writeUInt16LE(0x204, at + 2);
    s.writeUInt32LE(n, at + 4);
    s.writeUInt32LE(n, at + 8);
    s.writeUInt32LE(v, at + 12);
    k += Buffer.byteLength(key) + 1;
    v += n;
  });
  keys.copy(s, 20 + count * 16);
  data.copy(s, 20 + count * 16 + keys.length);
  const p = Buffer.alloc(8192);
  Buffer.from('7f434e54', 'hex').copy(p);
  p.writeUInt32BE(1, 16);
  p.writeUInt32BE(128, 24);
  Buffer.from(values.CONTENT_ID).copy(p, 64);
  p.writeUInt32BE(0x1000, 128);
  p.writeUInt32BE(256, 144);
  p.writeUInt32BE(s.length, 148);
  s.copy(p, 256);
  return p;
}
test(
  'PS5 temporarily unavailable inventory permits only qualified pending admission and preserves review binding',
  { timeout: 6000 },
  async () => {
    const work = mkdtempSync(join(tmpdir(), 'pf-ps5-pending-review-')),
      oldData = process.env.PACKAGEFLOW_DATA_DIR,
      oldFetch = globalThis.fetch;
    const data = join(work, 'data');
    mkdirSync(data);
    process.env.PACKAGEFLOW_DATA_DIR = data;
    try {
      const bundle = join(work, 'api.mjs');
      await build({
        stdin: {
          contents:
            "export * from './server/utils/device-installation';export * from './server/utils/console-profiles';",
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
      writeFileSync(
        join(data, 'ps5-service-keys.json'),
        JSON.stringify({ [profile.ip]: 'a'.repeat(64) }),
      );
      const source = join(work, 'hades.ffpfsc');
      writeFileSync(source, Buffer.alloc(8192));
      const image = {
        id: 'hades',
        title: 'Hades',
        titleId: 'PPSA36082',
        contentId: 'EP4484-PPSA36082_00-0912328937643383',
        appVersion: '01.006.000',
        platform: 'ps5',
        format: 'ffpfsc',
        contentType: 'PS5GD',
        type: 'Игра',
        installOrder: 0,
        size: 8192,
        requiredFirmware: '13.00',
        path: source,
        fileName: 'hades.ffpfsc',
        libraryRoot: work,
        sourceModifiedAt: 1,
        iconSize: 0,
        icon: { offset: 0, size: 0 },
      };
      const dlc = {
        ...image,
        id: 'dlc',
        format: 'pkg',
        type: 'DLC',
        contentType: 'PS5AC',
        installOrder: 2,
      };
      const patch = {
        ...image,
        id: 'patch',
        format: 'pkg',
        type: 'Патч',
        contentType: 'PS5GP',
        installOrder: 1,
      };
      writeFileSync(
        join(data, 'package-library.json'),
        JSON.stringify({ version: 2, packages: [image, dlc, patch], deliveries: {} }),
      );
      let mode = 'temporary',
        formatsReady = true,
        storageRead = true,
        revision = 'a'.repeat(64),
        healthReads = 0,
        holdCatalog = false,
        catalogEntered,
        releaseCatalog;
      const posts = [];
      const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
      globalThis.fetch = async (url, options) => {
        const path = new URL(url).pathname;
        assert.equal(new URL(url).hostname, profile.ip);
        if (options.method !== 'GET') {
          posts.push(path);
          throw Error('No dispatch expected');
        }
        if (path === '/health') {
          healthReads++;
          return reply({
            apiVersion: 'v1',
            pid: 97,
            firmwareRead: true,
            firmwareRaw: '0x13600007',
            serviceReport: {
              service: 'PackageFlowService-PS5',
              platform: 'ps5',
              consoleVerified: true,
              version: '0.1.24-dev',
            },
          });
        }
        if (path === '/api/v1/capabilities')
          return reply({ service: 'PackageFlowService-PS5', capabilities: {} });
        if (path === '/api/v1/system')
          return reply({
            service: 'PackageFlowService-PS5',
            storageRead,
            freeBytes: 8 * 1024 ** 3,
            totalBytes: 10 * 1024 ** 3,
          });
        if (path === '/api/v1/install/readiness')
          return reply({
            service: 'PackageFlowService-PS5',
            schemaVersion: 1,
            route: 'staged-pkg',
            exactVersionReceipt: false,
            ready: true,
            reason: 'ready',
            formats: ['pkg'],
            platforms: ['ps4', 'ps5'],
            images: {
              schemaVersion: 1,
              route: 'staged-image',
              ready: formatsReady,
              reason: formatsReady ? 'ready' : 'backend_not_verified_or_unavailable',
              protocol: 'image-registration-v1',
              backend: 'ShadowMountPlus-1.7beta3',
              registrationReceipt: formatsReady,
              platforms: formatsReady ? ['ps5'] : [],
              formats: formatsReady ? ['ufs2', 'exfat', 'pfs', 'ffpfsc'] : [],
            },
          });
        if (path === '/api/v1/management/status')
          return reply({ protocol: 'ps5-management-v1', ready: true, catalog: true });
        if (path === '/api/v1/console/catalog') {
          if (holdCatalog) {
            holdCatalog = false;
            catalogEntered();
            await new Promise((resolve) => {
              releaseCatalog = resolve;
            });
          }
          return reply({
            revision,
            entries: [
              {
                titleId: image.titleId,
                contentId: image.contentId,
                metadata: JSON.stringify({ contentVersion: image.appVersion }),
              },
            ],
            next: 1,
            done: true,
          });
        }
        if (path === '/api/v1/console/info') {
          if (mode === 'temporary') return reply({}, 503);
          if (mode === 'schema') return reply({ title_id: image.titleId });
          return reply({
            title_id: image.titleId,
            installed: true,
            source_available: true,
            content_id: image.contentId,
            version: image.appVersion,
            sourceIdentity: 'c'.repeat(64),
          });
        }
        assert.fail(path);
      };
      const selection = { packageIds: [image.id] },
        targets = [profile.id];
      const pending = (await api.previewDeviceInstall(selection, targets)).devices[0];
      assert.equal(pending.eligible, true);
      assert.equal(pending.reason, '');
      assert.equal(
        pending.warning,
        'Проверка установленных пакетов продолжится в очереди. До её завершения файлы не передаются.',
      );
      assert.deepEqual(
        pending.installedPackages,
        [],
        'unknown inventory is never installed or overwrite proof',
      );
      assert.equal(pending.selectedBytes, image.size);
      const backgroundEntered = new Promise((resolve) => {
        catalogEntered = resolve;
      });
      holdCatalog = true;
      const background = api.deviceActivitiesLive([image.id]);
      await backgroundEntered;
      const beforeForeground = healthReads;
      const foreground = api.previewDeviceInstall(selection, targets);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(
        healthReads,
        beforeForeground,
        'foreground review drains the active background read before its health probe',
      );
      releaseCatalog();
      const [reviewAfterDrain] = await Promise.all([foreground, background]);
      assert.equal(reviewAfterDrain.devices[0].eligible, true);
      assert.equal(healthReads, beforeForeground + 1);
      // An image the review does not mark replaceable is never queued for overwrite.
      const refusedImage = await api.installDeviceBatch(
        '9'.repeat(32),
        selection,
        targets,
        'localhost:3000',
        { [profile.id]: [image.id] },
        { [profile.id]: pending.reviewToken },
      );
      assert.notEqual(refusedImage.results[0].state, 'queued');
      formatsReady = false;
      const unqualified = (await api.previewDeviceInstall(selection, targets)).devices[0];
      assert.equal(unqualified.eligible, false);
      assert.match(unqualified.reason, /формата/);
      assert.equal(unqualified.warning, undefined);
      formatsReady = true;
      storageRead = false;
      const noStorage = (await api.previewDeviceInstall(selection, targets)).devices[0];
      assert.equal(noStorage.eligible, false);
      assert.match(noStorage.reason, /свободное место/);
      assert.equal(noStorage.warning, undefined);
      storageRead = true;
      mode = 'schema';
      const malformed = (await api.previewDeviceInstall(selection, targets)).devices[0];
      assert.equal(malformed.eligible, false);
      assert.equal(malformed.warning, undefined);
      mode = 'temporary';
      const unavailableDlc = (await api.previewDeviceInstall({ packageIds: [dlc.id] }, targets))
        .devices[0];
      // A transient check waits in the queue for every format: the queue checks
      // each package again before sending and sends nothing while unavailable.
      assert.equal(unavailableDlc.eligible, true, unavailableDlc.reason);
      const mixedPatch = (
        await api.previewDeviceInstall({ packageIds: [image.id, patch.id] }, targets)
      ).devices[0];
      assert.equal(mixedPatch.eligible, true, mixedPatch.reason);
      mode = 'known';
      const unsupportedDlc = (await api.previewDeviceInstall({ packageIds: [dlc.id] }, targets))
        .devices[0];
      // The service cannot list DLC: it is sent, the installer reports duplicates.
      assert.equal(unsupportedDlc.eligible, true, unsupportedDlc.reason);
      mode = 'temporary';
      const beforeChange = (await api.previewDeviceInstall(selection, targets)).devices[0];
      mode = 'known';
      revision = 'b'.repeat(64);
      const changed = await api.installDeviceBatch(
        '8'.repeat(32),
        selection,
        targets,
        'localhost:3000',
        {},
        { [profile.id]: beforeChange.reviewToken },
      );
      assert.equal(changed.results[0].state, 'failed');
      assert.match(changed.results[0].message, /изменился/);
      assert.equal(posts.length, 0);
      assert.equal(api.deviceQueue(profile.id).items.length, 0);
    } finally {
      globalThis.fetch = oldFetch;
      if (oldData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
      else process.env.PACKAGEFLOW_DATA_DIR = oldData;
      rmSync(work, { recursive: true, force: true });
    }
  },
);
test('live two-game selection, insufficient space, changed reviews, explicit queue admission, and selected PS4 reinstallation', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-live-review-')),
    oldData = process.env.PACKAGEFLOW_DATA_DIR,
    oldFetch = globalThis.fetch,
    oldHost = process.env.PACKAGEFLOW_HOST_IP;
  const data = join(work, 'data');
  mkdirSync(data);
  process.env.PACKAGEFLOW_DATA_DIR = data;
  process.env.PACKAGEFLOW_HOST_IP = '192.168.1.2';
  try {
    const bundle = join(work, 'api.mjs');
    await build({
      stdin: {
        contents:
          "export * from './server/utils/device-installation';export * from './server/utils/native-install-review';export * from './server/utils/console-app-commands';export * from './server/utils/console-profiles';export * from './server/utils/package-library';export * from './server/utils/installation-queue';export * from './server/utils/selected-reinstallation';export * from './server/utils/maintenance-store';",
        resolveDir: resolve('.'),
      },
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const api = await import(pathToFileURL(bundle).href),
      ip = '192.168.1.4',
      profile = api.saveConsoleProfile({ name: 'Test PS4', ip, platform: 'ps4' }).consoles[0];
    writeFileSync(join(data, 'ps4-service-keys.json'), JSON.stringify({ [ip]: 'a'.repeat(32) }));
    const make = (id, titleId) => {
      const contentId = `IV0000-${titleId}_00-PACKAGEFLOWUI001`,
        path = join(work, `${id}.pkg`);
      writeFileSync(
        path,
        pkg({
          TITLE: id,
          TITLE_ID: titleId,
          CONTENT_ID: contentId,
          CATEGORY: 'gd',
          APP_VER: '01.00',
          SYSTEM_VER: '0x05050000',
        }),
      );
      return {
        id,
        title: id,
        titleId,
        contentId,
        appVersion: '01.00',
        platform: 'ps4',
        format: 'pkg',
        contentType: 'PS4GD',
        size: 8192,
        path,
        fileName: `${id}.pkg`,
        libraryRoot: work,
        sourceModifiedAt: 1,
        iconSize: 0,
        icon: { offset: 0, size: 0 },
        type: 'Игра',
        installOrder: 0,
      };
    };
    const old = make('old', 'CUSA95001'),
      fresh = make('new', 'CUSA95002'),
      unselected = make('LittleNightmares', 'CUSA95003');
    let items = [old, { ...fresh, size: 2 * 1024 ** 3 }, unselected],
      free = 1024 ** 3,
      revision = 'a'.repeat(16),
      broken = false;
    const library = () =>
      writeFileSync(
        join(data, 'package-library.json'),
        JSON.stringify({ version: 2, packages: items, deliveries: {} }),
      );
    library();
    const component = (p) => ({
      id: 'base',
      kind: 'base',
      title: p.title,
      version: p.appVersion,
      contentId: p.contentId,
      sizeBytes: 8192,
      storage: 'internal',
      canRemove: true,
    });
    const inventory = new Map([
        [old.titleId, [component(old)]],
        [unselected.titleId, [component(unselected)]],
      ]),
      removals = new Map(),
      posts = [],
      removed = [];
    let delayRemoval = false,
      holdRuntime = false,
      runtimeEntered,
      releaseRuntime;
    const cap = {
      service: 'PackegeFlowService',
      version: '0.4.0',
      installApi: 1,
      authentication: 'bearer',
      ready: true,
      contentTypes: ['PS4GD', 'PS4GP', 'PS4AC'],
      error: 0,
      errorHex: '0x00000000',
    };
    const response = (v, status = 200) => new Response(JSON.stringify(v), { status });
    globalThis.fetch = async (url, options = {}) => {
      const u = new URL(url),
        path = u.pathname;
      assert.equal(u.hostname, ip);
      if (
        path === '/ping' ||
        path === '/status' ||
        path === '/install/capabilities' ||
        path === '/install/session'
      )
        return response({ ...cap, status: 'ok' });
      if (path === '/system/info')
        return response({
          ...cap,
          environment: 'ps4',
          firmware: { version: '12.50' },
          model: { name: 'Slim', family: 'Slim' },
          hen: {},
        });
      if (path === '/storage')
        return response({
          ...cap,
          volumes: [
            {
              id: 'internal',
              path: '/user',
              available: true,
              totalBytes: 20 * 1024 ** 3,
              freeBytes: free,
              availableBytes: free,
              usedBytes: 20 * 1024 ** 3 - free,
            },
          ],
        });
      if (path.startsWith('/apps/title/')) {
        if (broken) return response({}, 503);
        const titleId = path.split('/')[3],
          components = inventory.get(titleId) || [];
        return response({
          service: cap.service,
          revision,
          complete: true,
          total: components.length,
          next: null,
          app: {
            titleId,
            title: titleId,
            version: '01.00',
            installed: components.some((c) => c.kind === 'base'),
            protected: false,
          },
          components,
        });
      }
      if (path.startsWith('/apps/runtime/')) {
        if (holdRuntime) {
          runtimeEntered();
          await new Promise((resolve) => {
            releaseRuntime = resolve;
          });
        }
        return response({
          service: cap.service,
          titleId: path.split('/').at(-1),
          running: false,
          appId: -1,
        });
      }
      if (path === '/apps/remove') {
        const input = JSON.parse(options.body),
          parts = inventory.get(input.titleId) || [],
          affected = parts.filter(
            (c) => input.kind === 'game' || (c.kind === input.kind && c.id === input.componentId),
          );
        assert.ok(affected.length);
        inventory.set(
          input.titleId,
          parts.filter((c) => !affected.includes(c)),
        );
        removed.push(input);
        const job = {
          service: cap.service,
          ...input,
          state: delayRemoval ? 'verifying' : 'removed',
          completed: affected.length,
          total: affected.length,
          error: 0,
          errorHex: '0x00000000',
          pollError: 0,
        };
        removals.set(input.requestId, job);
        return response(job);
      }
      if (path.startsWith('/apps/operations/'))
        return response(removals.get(path.split('/').at(-1)));
      if (path === '/install/jobs/active') return response({ service: cap.service, active: false });
      if (path === '/install/jobs') {
        const input = JSON.parse(options.body);
        posts.push(input);
        return response({
          service: cap.service,
          jobId: input.requestId,
          requestId: input.requestId,
          contentId: input.contentId,
          taskId: 43,
          state: 'installed',
          totalBytes: input.size,
          downloadedBytes: input.size,
          downloadTotalBytes: input.size,
          error: 0,
          errorHex: '0x00000000',
          pollError: 0,
        });
      }
      assert.fail(path);
    };
    const selected = { packageIds: [old.id, fresh.id] },
      targets = [profile.id],
      preview = await api.previewDeviceInstall(selected, targets),
      device = preview.devices[0];
    assert.equal(preview.files, 2);
    assert.deepEqual(
      preview.packages.map((p) => p.packageId),
      ['old', 'new'],
    );
    assert.deepEqual(
      device.installedPackages.map((p) => p.packageId),
      ['old'],
    );
    assert.equal(device.selectedBytes, 2 * 1024 ** 3);
    assert.equal(device.eligible, false);
    assert.match(device.reason, /места/);
    const denied = await api.installDeviceBatch(
      '1'.repeat(32),
      selected,
      targets,
      'localhost:3000',
      {},
      { [profile.id]: device.reviewToken },
    );
    assert.equal(denied.results[0].state, 'failed');
    assert.equal(posts.length, 0);
    assert.equal(removed.length, 0);
    assert.equal(api.getPackage(fresh.id).installedAt, undefined);
    // An old local mark on the absent game never changes the live preflight.
    api.markPackageInstalled(fresh.id, true, ip);
    const again = await api.previewDeviceInstall(selected, targets);
    assert.deepEqual(
      again.devices[0].installedPackages.map((p) => p.packageId),
      ['old'],
    );
    api.markPackageInstalled(fresh.id, false, ip);
    // Even at sufficient space, an unreviewed installed component cannot silently skip.
    items = [old, fresh, unselected];
    library();
    free = 8 * 1024 ** 3;
    const noReview = await api.installDeviceBatch(
      '2'.repeat(32),
      selected,
      targets,
      'localhost:3000',
    );
    assert.equal(noReview.results[0].state, 'failed');
    assert.equal(posts.length, 0);
    const valid = await api.previewDeviceInstall(selected, targets);
    revision = 'b'.repeat(16);
    const changed = await api.installDeviceBatch(
      '3'.repeat(32),
      selected,
      targets,
      'localhost:3000',
      {},
      { [profile.id]: valid.devices[0].reviewToken },
    );
    assert.match(changed.results[0].message, /изменился/);
    assert.equal(posts.length, 0);
    const until = async (check) => {
      const end = Date.now() + 6000;
      while (!check()) {
        assert.ok(Date.now() < end, 'worker timeout');
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    // User reviewed skip on old: new game alone is dispatched, never Little Nightmares.
    const reviewed = await api.previewDeviceInstall(selected, targets);
    const started = await api.installDeviceBatch(
      '4'.repeat(32),
      selected,
      targets,
      'localhost:3000',
      {},
      { [profile.id]: reviewed.devices[0].reviewToken },
    );
    assert.equal(started.results[0].state, 'queued', started.results[0].message);
    await until(() => api.getInstallationQueue(ip).status === 'completed');
    assert.deepEqual(
      posts.map((p) => p.titleId),
      [fresh.titleId],
    );
    assert.equal(
      api.getPackage(old.id).installedAt,
      undefined,
      'preview skip does not write an installation mark',
    );
    assert.equal(removed.length, 0);
    // Reinstall only approved old and install selected new: no implicit full-library bundle.
    const replacePreview = await api.previewDeviceInstall(selected, targets);
    const replaced = await api.installDeviceBatch(
      '5'.repeat(32),
      selected,
      targets,
      'localhost:3000',
      { [profile.id]: [old.id] },
      { [profile.id]: replacePreview.devices[0].reviewToken },
    );
    assert.equal(replaced.results[0].state, 'queued', replaced.results[0].message);
    await until(() => api.getInstallationQueue(ip).status === 'completed');
    assert.deepEqual(
      removed.map((p) => p.titleId),
      [old.titleId],
    );
    assert.deepEqual(
      posts.slice(1).map((p) => p.titleId),
      [old.titleId, fresh.titleId],
    );
    assert.ok(inventory.get(unselected.titleId).length);
    // A live unknown/incomplete response never marks an absent item installed.
    await api.advanceSelectedReinstall(ip);
    broken = true;
    const unknown = await api.previewDeviceInstall({ packageIds: [fresh.id] }, targets);
    assert.equal(unknown.devices[0].eligible, false);
    assert.equal(unknown.devices[0].installedPackages.length, 0);
    // Looking at a preflight must not restart an old pending queue.
    broken = false;
    const queueFile = join(data, 'consoles', ip, 'installation-queue.json'),
      savedQueue = readFileSync(queueFile, 'utf8'),
      postCount = posts.length;
    writeFileSync(
      queueFile,
      JSON.stringify({
        version: 1,
        id: 'old-queue',
        status: 'running',
        transport: 'service',
        psIp: ip,
        items: [
          {
            packageId: unselected.id,
            title: unselected.title,
            titleId: unselected.titleId,
            size: unselected.size,
            url: 'http://192.168.1.2:3000/json/LittleNightmares.json',
            state: 'pending',
            detail: 'Old pending task',
            bytesSent: 0,
          },
        ],
      }),
    );
    {
      // Badges for a PS4 receiving package data never send installed-state reads.
      await api.probeConsoleProfile(profile.id);
      const realFetch = globalThis.fetch;
      let reads = 0;
      globalThis.fetch = (...args) => {
        reads++;
        return realFetch(...args);
      };
      try {
        const busy = (await api.deviceActivitiesLive([fresh.id])).find(
          (entry) => entry.consoleId === profile.id,
        );
        assert.equal(busy.status, 'running');
        assert.equal(reads, 0, 'a running PS4 queue gets no live inventory requests');
      } finally {
        globalThis.fetch = realFetch;
      }
    }
    const withQueue = await api.previewDeviceInstall(selected, targets);
    assert.deepEqual(
      withQueue.packages.map((p) => p.packageId),
      ['old', 'new'],
    );
    assert.deepEqual(
      withQueue.devices[0].queuedPackages.map((p) => p.packageId),
      ['LittleNightmares'],
    );
    assert.equal(withQueue.devices[0].installedPackages.length, 0);
    const noQueueReview = await api.installDeviceBatch(
      '6'.repeat(32),
      selected,
      targets,
      'localhost:3000',
    );
    assert.equal(noQueueReview.results[0].state, 'failed');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      posts.length,
      postCount,
      'preflight and rejected admission never restart the old queue',
    );
    writeFileSync(queueFile, savedQueue);
    assert.equal(
      api.replacementCoversComponents(
        [
          { kind: 'base', contentId: old.contentId },
          { kind: 'dlc', contentId: 'DLC' },
        ],
        [old],
      ),
      false,
    );
    // Reload every bundled module from disk while removal is pending: recover with GET only.
    inventory.set(old.titleId, [component(old)]);
    delayRemoval = true;
    const steps = await api.selectedReinstallPlan(ip, [old.id]),
      removeCount = removed.length;
    const flowInput = {
      packageIds: [old.id],
      packageUrls: { [old.id]: 'http://192.168.1.2:3000/json/old.json' },
    };
    await api.beginSelectedReinstall(ip, flowInput, steps);
    assert.equal(api.readMaintenance()[ip].state, 'removing');
    assert.equal(removed.length, removeCount + 1);
    const resumedBundle = join(work, 'restarted.mjs');
    copyFileSync(bundle, resumedBundle);
    const restarted = await import(pathToFileURL(resumedBundle).href);
    removals.get(steps[0].requestId).state = 'removed';
    delayRemoval = false;
    await restarted.advanceSelectedReinstall(ip);
    await until(() => restarted.peekInstallationQueue(ip).status === 'completed');
    assert.equal(removed.length, removeCount + 1, 'restart never repeats the removal POST');
    assert.deepEqual(
      restarted.peekInstallationQueue(ip).items.map((p) => p.packageId),
      [old.id],
    );
    assert.equal((await restarted.advanceSelectedReinstall(ip)).state, 'completed');
    // An intent persisted before the removal ledger was written cannot be replayed blindly.
    const uncertain = {
      ...restarted.readMaintenance()[ip],
      id: 'uncertain-restart',
      state: 'removing',
      index: 0,
      steps: [{ ...steps[0], requestId: '01234567-89ab-4cde-8fab-0123456789ab', dispatched: true }],
    };
    restarted.saveMaintenance({ [ip]: uncertain });
    const installsBefore = posts.length;
    assert.equal((await restarted.advanceSelectedReinstall(ip)).state, 'uncertain');
    assert.equal(removed.length, removeCount + 1);
    assert.equal(posts.length, installsBefore);
    // A finished queue with an error must not report successful reinstallation.
    writeFileSync(
      queueFile,
      JSON.stringify({
        ...restarted.peekInstallationQueue(ip),
        items: [{ ...restarted.peekInstallationQueue(ip).items[0], state: 'failed' }],
      }),
    );
    restarted.saveMaintenance({
      [ip]: { ...uncertain, id: restarted.peekInstallationQueue(ip).id, state: 'installing' },
    });
    assert.equal((await restarted.advanceSelectedReinstall(ip)).state, 'failed');
    // Stop while the worker awaits runtime: no next removal or installation may slip through.
    inventory.set(old.titleId, [component(old)]);
    const stopFlow = {
      ...uncertain,
      id: 'stop-test',
      state: 'removing',
      cancelRequested: false,
      index: 0,
      steps: [{ ...steps[0], dispatched: false }],
    };
    restarted.saveMaintenance({ [ip]: stopFlow });
    holdRuntime = true;
    const entered = new Promise((resolve) => {
        runtimeEntered = resolve;
      }),
      working = restarted.advanceSelectedReinstall(ip);
    await entered;
    await restarted.stopSelectedReinstall(ip, stopFlow.id);
    holdRuntime = false;
    releaseRuntime();
    await working;
    assert.equal((await restarted.advanceSelectedReinstall(ip)).state, 'failed');
    assert.equal(removed.length, removeCount + 1);
    assert.equal(posts.length, installsBefore);
    // "Reinstall all" includes non-CUSA PS2 Classics and every selected game.
    // Previously SLES was treated as absent, so it never received a removal POST.
    const classic = make('classic', 'SLES53741');
    items = [old, fresh, classic, unselected];
    library();
    for (const p of [old, fresh, classic]) inventory.set(p.titleId, [component(p)]);
    restarted.saveMaintenance({});
    const multiSelection = { packageIds: [old.id, fresh.id, classic.id] };
    const multiPreview = await restarted.previewNativeInstall(
      {
        ip,
        gameId: 'favorites',
        action: 'install-favorites',
        favoriteIds: [old.titleId, fresh.titleId, classic.titleId],
      },
      'ps4',
    );
    assert.deepEqual(multiPreview.device.installedPackages.map((p) => p.packageId).sort(), [
      'classic',
      'new',
      'old',
    ]);
    assert.ok(multiPreview.device.installedPackages.every((p) => p.canReinstall));
    assert.equal(multiPreview.consoleId, profile.id);
    assert.equal(multiPreview.consolePlatform, 'ps4');
    const removedBefore = removed.length,
      postsBefore = posts.length;
    const multiCommand = {
      ip,
      consoleId: profile.id,
      gameId: 'review',
      requestId: '7'.repeat(32),
      action: 'install-reviewed',
      packageIds: multiPreview.selection.packageIds,
      overwritePackageIds: multiSelection.packageIds,
      reviewToken: multiPreview.device.reviewToken,
    };
    restarted.submitConsoleCommand(multiCommand, '3000');
    await until(() => restarted.consoleCommand(multiCommand.requestId, ip).state !== 'pending');
    assert.equal(
      restarted.consoleCommand(multiCommand.requestId, ip).state,
      'accepted',
      restarted.consoleCommand(multiCommand.requestId, ip).message,
    );
    for (let n = 0; n < 80; n++) {
      await restarted.advanceSelectedReinstall(ip);
      if (restarted.readMaintenance()[ip].state === 'completed') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(
      restarted.readMaintenance()[ip].state,
      'completed',
      restarted.readMaintenance()[ip].message,
    );
    assert.deepEqual(
      removed
        .slice(removedBefore)
        .map((r) => r.titleId)
        .sort(),
      [old.titleId, fresh.titleId, classic.titleId].sort(),
      'all three games are removed, each with its own command',
    );
    assert.deepEqual(
      posts
        .slice(postsBefore)
        .map((r) => r.titleId)
        .sort(),
      [old.titleId, fresh.titleId, classic.titleId].sort(),
      'all three games are installed after removals',
    );
    assert.ok(
      restarted.peekInstallationQueue(ip).items.every((item) => item.state === 'installed'),
      'approved replacement is never silently skipped',
    );
    assert.ok(
      inventory.get(unselected.titleId).length,
      'unselected Little Nightmares is not touched',
    );
    const installsAfter = posts.length,
      removalsAfter = removed.length;
    assert.equal(restarted.submitConsoleCommand(multiCommand, '3000').state, 'accepted');
    assert.equal(posts.length, installsAfter);
    assert.equal(removed.length, removalsAfter);
    assert.throws(
      () =>
        restarted.submitConsoleCommand({ ...multiCommand, overwritePackageIds: [old.id] }, '3000'),
      /другой командой/,
    );
    assert.throws(
      () =>
        restarted.submitConsoleCommand(
          { ...multiCommand, requestId: '8'.repeat(32), reviewToken: 'invalid' },
          '3000',
        ),
      /проверку/,
    );
  } finally {
    globalThis.fetch = oldFetch;
    if (oldData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = oldData;
    if (oldHost === undefined) delete process.env.PACKAGEFLOW_HOST_IP;
    else process.env.PACKAGEFLOW_HOST_IP = oldHost;
    rmSync(work, { recursive: true, force: true });
  }
});

test('busy PS5 activity keeps local queue details without refreshing expired installed badges', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-busy-ps5-badges-')),
    previous = {
      data: process.env.PACKAGEFLOW_DATA_DIR,
      fetch: globalThis.fetch,
      now: Date.now,
    },
    data = join(work, 'data');
  mkdirSync(data);
  process.env.PACKAGEFLOW_DATA_DIR = data;
  try {
    const bundle = join(work, 'api.mjs');
    await build({
      stdin: {
        contents:
          "export * from './server/utils/device-installation';export * from './server/utils/console-profiles';export { activityFixtureQueue } from './server/utils/ps5-installation-queue';export { withPs5InstalledReview } from './server/utils/ps5-installed-read-coordinator';",
        resolveDir: resolve('.'),
      },
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
      plugins: [
        {
          name: 'activity-queue-fixture',
          setup(plugin) {
            // Mutate only the bundled fixture's queue: no worker wake or test hook in production.
            plugin.onLoad({ filter: /\/ps5-installation-queue\.ts$/ }, ({ path }) => ({
              contents: `${readFileSync(path, 'utf8')}\nexport function activityFixtureQueue(id, value) { Object.assign(runner(id).queue, value); }`,
              loader: 'ts',
              resolveDir: resolve('server/utils'),
            }));
          },
        },
      ],
    });
    const api = await import(pathToFileURL(bundle).href),
      profiles = ['Running', 'Cancelling', 'Idle'].map((name, index) => {
        const ip = `192.168.1.${50 + index}`;
        return api
          .saveConsoleProfile({ name, ip, platform: 'ps5' })
          .consoles.find((p) => p.ip === ip);
      }),
      candidates = ['installed', 'queued'].map((id, index) => {
        const titleId = `PPSA3608${index + 2}`,
          path = join(work, `${id}.ffpfsc`);
        writeFileSync(path, Buffer.alloc(8192));
        return {
          id,
          title: id,
          titleId,
          contentId: `EP4484-${titleId}_00-0912328937643383`,
          appVersion: '01.006.000',
          platform: 'ps5',
          format: 'ffpfsc',
          contentType: 'PS5GD',
          type: 'Игра',
          installOrder: 0,
          size: 8192,
          path,
          fileName: `${id}.ffpfsc`,
          libraryRoot: work,
          sourceModifiedAt: 1,
          iconSize: 0,
          icon: { offset: 0, size: 0 },
        };
      });
    writeFileSync(
      join(data, 'ps5-service-keys.json'),
      JSON.stringify(Object.fromEntries(profiles.map((p) => [p.ip, 'a'.repeat(64)]))),
    );
    writeFileSync(
      join(data, 'package-library.json'),
      JSON.stringify({ version: 2, packages: candidates, deliveries: {} }),
    );
    const reads = [],
      installed = candidates[0],
      reply = (body) => new Response(JSON.stringify(body), { status: 200 });
    let infoGate, infoEntered;
    globalThis.fetch = async (url, options) => {
      const { hostname: ip, pathname: path } = new URL(url);
      assert.ok(profiles.some((p) => p.ip === ip));
      assert.equal(options.method, 'GET', 'activity never dispatches installation work');
      if (path === '/health')
        return reply({
          apiVersion: 'v1',
          pid: 97,
          firmwareRead: true,
          firmwareRaw: '0x13600007',
          serviceReport: {
            service: 'PackageFlowService-PS5',
            platform: 'ps5',
            consoleVerified: true,
            version: '0.1.24-dev',
          },
        });
      if (path === '/api/v1/capabilities')
        return reply({ service: 'PackageFlowService-PS5', capabilities: {} });
      if (path === '/api/v1/system') return reply({ service: 'PackageFlowService-PS5' });
      if (path === '/api/v1/install/readiness')
        return reply({ service: 'PackageFlowService-PS5', ready: false });
      reads.push({ ip, path });
      if (path === '/api/v1/management/status')
        return reply({ protocol: 'ps5-management-v1', ready: true, catalog: true });
      if (path === '/api/v1/console/catalog')
        return reply({
          revision: 'a'.repeat(64),
          entries: [
            {
              titleId: installed.titleId,
              contentId: installed.contentId,
              metadata: JSON.stringify({ contentVersion: installed.appVersion }),
            },
          ],
          next: 1,
          done: true,
        });
      if (path === '/api/v1/console/info') {
        if (ip === profiles[0].ip) {
          infoEntered?.();
          if (infoGate) await infoGate;
        }
        return reply({
          title_id: installed.titleId,
          installed: true,
          source_available: true,
          content_id: installed.contentId,
          version: installed.appVersion,
          sourceIdentity: 'c'.repeat(64),
        });
      }
      assert.fail(`Unexpected activity request: ${path}`);
    };
    for (const profile of profiles) await api.probeConsoleProfile(profile.id);
    const ids = candidates.map((p) => p.id);
    let now = Date.now();
    Date.now = () => now;
    const initial = await api.deviceActivitiesLive(ids);
    for (const entry of initial) assert.deepEqual(entry.installedPackageIds, ['installed']);
    const [running, cancelling, idle] = profiles;
    for (const [profile, status] of [
      [running, 'running'],
      [cancelling, 'cancelling'],
    ])
      api.activityFixtureQueue(profile.id, {
        id: `${status}-queue`,
        status,
        message: status,
        items: candidates.map((candidate, index) => ({
          ...candidate,
          packageId: candidate.id,
          state: index ? 'pending' : 'waiting',
          bytesSent: 0,
        })),
      });
    const assertBusy = (activity, expectedInstalled) => {
      for (const profile of [running, cancelling]) {
        const entry = activity.find((p) => p.consoleId === profile.id);
        assert.equal(entry.status, profile === running ? 'running' : 'cancelling');
        assert.equal(entry.queueId, `${entry.status}-queue`);
        assert.equal(entry.message, entry.status);
        assert.deepEqual(entry.counts, { active: 1, queued: 1, completed: 0, failed: 0 });
        assert.deepEqual(entry.activePackageIds, ['installed']);
        assert.deepEqual(entry.queuedPackageIds, ['queued']);
        assert.deepEqual(entry.installedPackageIds, expectedInstalled);
      }
    };
    reads.length = 0;
    now += 4999;
    assertBusy(await api.deviceActivitiesLive([...ids].reverse()), ['installed']);
    assert.deepEqual(reads, [], 'busy PS5 reuses only its unexpired exact-selection snapshot');
    now++;
    const expired = await api.deviceActivitiesLive(ids);
    assertBusy(expired, []);
    assert.deepEqual(expired.find((p) => p.consoleId === idle.id).installedPackageIds, [
      'installed',
    ]);
    assert.deepEqual(
      reads.map((read) => read.ip),
      [idle.ip, idle.ip, idle.ip],
      'running/waiting and cancelling send no management/catalog/info reads; idle PS5 remains independent',
    );
    reads.length = 0;
    assertBusy(await api.deviceActivitiesLive(ids), []);
    assert.deepEqual(reads, [], 'busy polling never refills an expired installed snapshot');
    api.activityFixtureQueue(running.id, { status: 'paused' });
    const resumedLookup = await api.deviceActivitiesLive(ids);
    assert.deepEqual(
      resumedLookup.find((p) => p.consoleId === running.id).installedPackageIds,
      ['installed'],
      'ordinary live checking resumes when the PS5 queue is no longer busy',
    );
    assert.ok(reads.length > 0);
    assert.ok(reads.every((read) => read.ip === running.ip));
    now += 5000;
    reads.length = 0;
    let releaseReview, enterReview;
    const reviewEntered = new Promise((resolve) => {
        enterReview = resolve;
      }),
      review = api.withPs5InstalledReview([running.id, idle.id], async () => {
        enterReview();
        await new Promise((resolve) => {
          releaseReview = resolve;
        });
      });
    await reviewEntered;
    const queuedBackground = api.deviceActivitiesLive(ids);
    await new Promise(setImmediate);
    assert.deepEqual(reads, [], 'background inventory waits behind the foreground review lease');
    api.activityFixtureQueue(running.id, { status: 'running' });
    releaseReview();
    await review;
    api.activityFixtureQueue(running.id, { status: 'paused' });
    const deferredActivity = await queuedBackground;
    assert.deepEqual(
      deferredActivity.find((p) => p.consoleId === running.id).installedPackageIds,
      [],
      'reads queued while idle defer when the queue starts, even if it pauses before completion',
    );
    assert.ok(reads.length > 0);
    assert.ok(
      reads.every((read) => read.ip === idle.ip),
      'deferred PS5 reads send no HTTP',
    );
    reads.length = 0;
    const afterDeferral = await api.deviceActivitiesLive(ids);
    assert.deepEqual(
      afterDeferral.find((p) => p.consoleId === running.id).installedPackageIds,
      ['installed'],
      'deferred/partial inventory never creates a new five-second negative snapshot',
    );
    assert.deepEqual(
      reads.map((read) => read.ip),
      [running.ip, running.ip, running.ip],
    );
    now += 5000;
    let releaseInfo;
    const enteredInfo = new Promise((resolve) => {
      infoEntered = resolve;
    });
    infoGate = new Promise((resolve) => {
      releaseInfo = resolve;
    });
    const partialBackground = api.deviceActivitiesLive(ids);
    await enteredInfo;
    api.activityFixtureQueue(running.id, { status: 'running' });
    releaseInfo();
    const partial = await partialBackground;
    assert.deepEqual(
      partial.find((p) => p.consoleId === running.id).installedPackageIds,
      [],
      'even a completed installed reply cannot publish a new snapshot after the queue starts',
    );
    infoGate = undefined;
    infoEntered = undefined;
    api.activityFixtureQueue(running.id, { status: 'paused' });
    reads.length = 0;
    const afterPartial = await api.deviceActivitiesLive(ids);
    assert.deepEqual(afterPartial.find((p) => p.consoleId === running.id).installedPackageIds, [
      'installed',
    ]);
    assert.deepEqual(
      reads.map((read) => read.ip),
      [running.ip, running.ip, running.ip],
      'the interrupted scan neither creates a partial positive snapshot nor resets its TTL',
    );
  } finally {
    globalThis.fetch = previous.fetch;
    Date.now = previous.now;
    if (previous.data === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = previous.data;
    rmSync(work, { recursive: true, force: true });
  }
});

test('live library badges use public connection state and an exact device catalog, never saved profile flags', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-live-badges-'));
  const previous = {
    data: process.env.PACKAGEFLOW_DATA_DIR,
    fetch: globalThis.fetch,
    now: Date.now,
  };
  const data = join(work, 'data');
  mkdirSync(data);
  process.env.PACKAGEFLOW_DATA_DIR = data;
  try {
    const bundle = join(work, 'api.mjs');
    await build({
      stdin: {
        contents:
          "export * from './server/utils/device-installation';export * from './server/utils/console-profiles';",
        resolveDir: resolve('.'),
      },
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const api = await import(pathToFileURL(bundle).href);
    const profiles = [
      ['Paired', '192.168.1.40'],
      ['Offline', '192.168.1.41'],
      ['Unpaired', '192.168.1.42'],
    ].map(([name, ip]) => {
      const saved = api.saveConsoleProfile({ name, ip, platform: 'ps4' });
      return saved.consoles.find((profile) => profile.ip === ip);
    });
    const [paired, offline, unpaired] = profiles;
    writeFileSync(
      join(data, 'ps4-service-keys.json'),
      JSON.stringify({ [paired.ip]: 'a'.repeat(32), [offline.ip]: 'b'.repeat(32) }),
    );
    const candidates = ['installed', 'absent'].map((id, index) => {
      const titleId = `CUSA9500${index + 1}`;
      const contentId = `IV0000-${titleId}_00-PACKAGEFLOWUI001`;
      const path = join(work, `${id}.pkg`);
      writeFileSync(path, Buffer.alloc(8192));
      return {
        id,
        title: id,
        titleId,
        contentId,
        appVersion: '01.00',
        platform: 'ps4',
        format: 'pkg',
        contentType: 'PS4GD',
        type: 'Игра',
        installOrder: 0,
        size: 8192,
        path,
        fileName: `${id}.pkg`,
        libraryRoot: work,
        sourceModifiedAt: 1,
        iconSize: 0,
        icon: { offset: 0, size: 0 },
        packageDigest: String(index + 1).repeat(64),
        installedAt: 123,
      };
    });
    writeFileSync(
      join(data, 'package-library.json'),
      JSON.stringify({ version: 2, packages: candidates, deliveries: {} }),
    );
    const unavailable = new Set([offline.ip]);
    const calls = [],
      catalogCalls = [];
    let catalogGate,
      catalogEntered,
      abortCatalog = false;
    const cap = {
      service: 'PackegeFlowService',
      version: '0.4.0',
      installApi: 1,
      authentication: 'bearer',
      ready: true,
      contentTypes: ['PS4GD'],
      error: 0,
      errorHex: '0x00000000',
    };
    const response = (body) => new Response(JSON.stringify(body), { status: 200 });
    globalThis.fetch = async (url, options = {}) => {
      const address = new URL(url),
        path = address.pathname;
      assert.ok(profiles.some((profile) => profile.ip === address.hostname));
      calls.push({ ip: address.hostname, path, method: options.method || 'GET' });
      if (unavailable.has(address.hostname)) throw Error('offline fixture');
      if (path.startsWith('/apps/title/')) {
        catalogCalls.push(address.hostname);
        assert.notEqual(address.hostname, unpaired.ip, 'unpaired consoles must not be queried');
        assert.equal(
          options.headers.Authorization,
          `Bearer ${(address.hostname === paired.ip ? 'a' : 'b').repeat(32)}`,
        );
        catalogEntered?.();
        if (catalogGate) await catalogGate;
        if (abortCatalog) throw new DOMException('Aborted fixture', 'AbortError');
        const titleId = path.split('/')[3];
        const candidate = candidates.find((item) => item.titleId === titleId);
        assert.ok(candidate);
        const installed = address.hostname === paired.ip && candidate.id === 'installed';
        return response({
          service: cap.service,
          complete: true,
          revision: 'a'.repeat(16),
          app: { titleId, installed },
          total: installed ? 1 : 0,
          next: null,
          components: installed
            ? [
                {
                  id: 'base',
                  kind: 'base',
                  version: candidate.appVersion,
                  contentId: candidate.contentId,
                  canRemove: true,
                },
              ]
            : [],
        });
      }
      if (path === '/ping' || path === '/status') return response({ ...cap, status: 'ok' });
      if (path === '/install/capabilities' || path === '/install/session') return response(cap);
      if (path === '/system/info')
        return response({
          ...cap,
          environment: 'ps4',
          firmware: { version: '12.50' },
          model: { name: 'Slim', family: 'Slim' },
          hen: {},
        });
      if (path === '/storage') return response({ ...cap, volumes: [] });
      assert.fail(`Unexpected activity request: ${path}`);
    };
    for (const profile of profiles) await api.probeConsoleProfile(profile.id);
    const stored = JSON.parse(readFileSync(join(data, 'console-profiles.json'), 'utf8'));
    for (const profile of stored.consoles) {
      assert.equal(Object.hasOwn(profile, 'online'), false);
      assert.equal(Object.hasOwn(profile, 'paired'), false);
    }
    const publicProfiles = api.getConsoleProfiles().consoles;
    assert.equal(publicProfiles.find((profile) => profile.id === paired.id).online, true);
    assert.equal(publicProfiles.find((profile) => profile.id === paired.id).paired, true);
    assert.equal(publicProfiles.find((profile) => profile.id === offline.id).online, false);
    assert.equal(publicProfiles.find((profile) => profile.id === unpaired.id).online, true);
    assert.equal(publicProfiles.find((profile) => profile.id === unpaired.id).paired, false);
    const activity = await api.deviceActivitiesLive(candidates.map((item) => item.id));
    assert.deepEqual(
      activity.find((entry) => entry.consoleId === paired.id).installedPackageIds,
      ['installed'],
      'only the exact live component is installed; stale WEB marks do not prove the absent game',
    );
    for (const profile of [offline, unpaired])
      assert.deepEqual(
        activity.find((entry) => entry.consoleId === profile.id).installedPackageIds,
        [],
      );
    assert.deepEqual(catalogCalls, [paired.ip, paired.ip]);
    const ids = candidates.map((item) => item.id);
    let now = Date.now();
    Date.now = () => now;
    now += 6000;
    let releaseCatalog;
    const entered = new Promise((resolve) => {
      catalogEntered = resolve;
    });
    catalogGate = new Promise((resolve) => {
      releaseCatalog = resolve;
    });
    const first = api.deviceActivitiesLive(ids);
    await entered;
    assert.equal(catalogCalls.length, 4);
    now += 6000;
    const second = api.deviceActivitiesLive(ids);
    const reordered = api.deviceActivitiesLive([...ids].reverse());
    await new Promise(setImmediate);
    assert.equal(catalogCalls.length, 4, 'a check slower than the TTL remains one shared flight');
    catalogGate = undefined;
    catalogEntered = undefined;
    releaseCatalog();
    for (const result of await Promise.all([first, second, reordered]))
      assert.deepEqual(result.find((entry) => entry.consoleId === paired.id).installedPackageIds, [
        'installed',
      ]);
    now += 4999;
    await api.deviceActivitiesLive(ids);
    assert.equal(catalogCalls.length, 4, 'the five-second snapshot starts when the check finishes');
    now++;
    await api.deviceActivitiesLive(ids);
    assert.equal(catalogCalls.length, 6, 'a completed snapshot expires at five seconds');
    await api.deviceActivitiesLive(['absent']);
    assert.equal(catalogCalls.length, 7, 'different selections have independent checks');
    now += 5000;
    abortCatalog = true;
    const abortedActivity = await api.deviceActivitiesLive(ids);
    assert.deepEqual(
      abortedActivity.find((entry) => entry.consoleId === paired.id).installedPackageIds,
      [],
      'an aborted live read never preserves an earlier installed result',
    );
    assert.equal(catalogCalls.length, 9);
    abortCatalog = false;
    now += 5000;
    unavailable.delete(offline.ip);
    await api.probeConsoleProfile(offline.id);
    const multiDevice = await api.deviceActivitiesLive(ids);
    assert.equal(catalogCalls.length, 13, 'each console checks its own selection independently');
    assert.deepEqual(
      multiDevice.find((entry) => entry.consoleId === paired.id).installedPackageIds,
      ['installed'],
      'a finished aborted flight does not block a later fresh check',
    );
    assert.deepEqual(
      multiDevice.find((entry) => entry.consoleId === offline.id).installedPackageIds,
      [],
      'another console never reuses the first console installed proof',
    );
    const beforeOffline = catalogCalls.length;
    unavailable.add(paired.ip);
    await api.probeConsoleProfile(paired.id);
    const offlineActivity = await api.deviceActivitiesLive(candidates.map((item) => item.id));
    assert.deepEqual(
      offlineActivity.find((entry) => entry.consoleId === paired.id).installedPackageIds,
      [],
      'a fresh offline status also prevents reuse of a recent installed snapshot',
    );
    assert.equal(catalogCalls.length, beforeOffline);
    assert.ok(
      calls.every((call) => call.method === 'GET'),
      'activity never starts an installation',
    );
  } finally {
    globalThis.fetch = previous.fetch;
    Date.now = previous.now;
    if (previous.data === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = previous.data;
    rmSync(work, { recursive: true, force: true });
  }
});
