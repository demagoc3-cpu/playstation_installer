import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createError } from 'h3';
import { putPs5ParamPkg } from './ps5-param-pkg.mjs';
import { streamedBody } from './streamed-body.mjs';

const [bundle, work] = process.argv.slice(2);
const data = join(work, 'data');
mkdirSync(data);
process.env.PACKAGEFLOW_DATA_DIR = data;
process.env.PACKAGEFLOW_HOST_IP = '192.168.50.2';
globalThis.createError = createError;
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const until = async (check, label) => {
  const deadline = Date.now() + 12000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `Mixed-device worker timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

function ps4Pkg(fields) {
  const keys = Buffer.concat(Object.keys(fields).map((key) => Buffer.from(`${key}\0`)));
  const values = Buffer.concat(Object.values(fields).map((value) => Buffer.from(`${value}\0`)));
  const count = Object.keys(fields).length;
  const sfo = Buffer.alloc(20 + 16 * count + keys.length + values.length);
  sfo.writeUInt32LE(0x46535000);
  sfo.writeUInt32LE(20 + 16 * count, 8);
  sfo.writeUInt32LE(20 + 16 * count + keys.length, 12);
  sfo.writeUInt32LE(count, 16);
  let keyOffset = 0,
    valueOffset = 0;
  Object.entries(fields).forEach(([key, value], index) => {
    const at = 20 + index * 16;
    const length = Buffer.byteLength(value) + 1;
    sfo.writeUInt16LE(keyOffset, at);
    sfo.writeUInt16LE(0x204, at + 2);
    sfo.writeUInt32LE(length, at + 4);
    sfo.writeUInt32LE(length, at + 8);
    sfo.writeUInt32LE(valueOffset, at + 12);
    keyOffset += Buffer.byteLength(key) + 1;
    valueOffset += length;
  });
  keys.copy(sfo, 20 + 16 * count);
  values.copy(sfo, 20 + 16 * count + keys.length);
  const pkg = Buffer.alloc(8192);
  Buffer.from('7f434e54', 'hex').copy(pkg);
  pkg.writeUInt32BE(1, 16);
  pkg.writeUInt32BE(128, 24);
  Buffer.from(fields.CONTENT_ID).copy(pkg, 64);
  pkg.writeUInt32BE(0x1000, 128);
  pkg.writeUInt32BE(256, 144);
  pkg.writeUInt32BE(sfo.length, 148);
  sfo.copy(pkg, 256);
  return pkg;
}

async function run() {
  const api = await import(pathToFileURL(bundle).href);
  const save = (name, ip, platform) =>
    api.saveConsoleProfile({ name, ip, platform }).consoles.find((p) => p.ip === ip);
  const four = save('Mixed PS4', '192.168.50.4', 'ps4');
  const a = save('Mixed PS5 A', '192.168.50.5', 'ps5');
  const b = save('Mixed PS5 B', '192.168.50.6', 'ps5');
  const credentials = { [four.ip]: 'a'.repeat(32), [a.ip]: 'b'.repeat(64), [b.ip]: 'c'.repeat(64) };
  writeFileSync(
    join(data, 'ps4-service-keys.json'),
    JSON.stringify({ [four.ip]: credentials[four.ip] }),
  );
  writeFileSync(
    join(data, 'ps5-service-keys.json'),
    JSON.stringify({ [a.ip]: credentials[a.ip], [b.ip]: credentials[b.ip] }),
  );
  const keyFiles = ['ps4-service-keys.json', 'ps5-service-keys.json'].map((name) =>
    readFileSync(join(data, name), 'utf8'),
  );
  const contentId = 'IV0000-CUSA95001_00-PACKAGEFLOWUI001';
  const makePs4 = (id, patch) => {
    const path = join(work, `${id}.pkg`);
    const appVersion = patch ? '01.01' : '01.00';
    const bytes = ps4Pkg({
      TITLE: id,
      TITLE_ID: 'CUSA95001',
      CONTENT_ID: contentId,
      CATEGORY: patch ? 'gp' : 'gd',
      APP_VER: appVersion,
      SYSTEM_VER: '0x05050000',
    });
    writeFileSync(path, bytes);
    return {
      id,
      title: id,
      titleId: 'CUSA95001',
      contentId,
      appVersion,
      platform: 'ps4',
      format: 'pkg',
      contentType: patch ? 'PS4GP' : 'PS4GD',
      size: bytes.length,
      path,
      fileName: `${id}.pkg`,
      libraryRoot: work,
      sourceModifiedAt: 1,
      iconSize: 0,
      icon: { offset: 0, size: 0 },
      type: patch ? 'Патч' : 'Игра',
      installOrder: patch ? 1 : 0,
      requiredFirmware: '5.05',
    };
  };
  const base = makePs4('z-base', false);
  const patch = makePs4('a-patch', true);
  const nativeBytes = putPs5ParamPkg(Buffer.alloc(786432, 39));
  const nativePath = join(work, 'native.pkg');
  writeFileSync(nativePath, nativeBytes);
  const native = {
    id: 'native',
    title: 'PS5 fixture',
    titleId: 'PPSA95001',
    contentId: 'IV0000-PPSA95001_00-PACKAGEFLOWUI001',
    appVersion: '01.000.001',
    platform: 'ps5',
    format: 'pkg',
    contentType: 'PS5GD',
    type: 'Игра',
    installOrder: 0,
    size: nativeBytes.length,
    path: nativePath,
    fileName: 'native.pkg',
    libraryRoot: work,
    sourceModifiedAt: 1,
    iconSize: 0,
    icon: { offset: 0, size: 0 },
    packageDigest: '',
  };
  writeFileSync(
    join(data, 'package-library.json'),
    JSON.stringify({ version: 2, packages: [base, patch, native], deliveries: {} }),
  );

  const ps4Cap = {
    service: 'PackegeFlowService',
    version: '0.4.0',
    installApi: 1,
    authentication: 'bearer',
    ready: true,
    contentTypes: ['PS4GD', 'PS4GP'],
    error: 0,
    errorHex: '0x00000000',
  };
  const posts = [],
    removals = [],
    jobs = new Map(),
    ps4Inventory = [];
  let finishPs4 = false;
  const states = new Map(
    [a, b].map((p) => [
      p.ip,
      {
        transfers: new Map(),
        release: false,
        blocked: false,
        installed: false,
        submits: 0,
        cancels: 0,
      },
    ]),
  );
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    options = await streamedBody(options);
    const u = new URL(url),
      ip = u.hostname,
      path = u.pathname;
    assert.ok([four.ip, a.ip, b.ip].includes(ip), `No external destination: ${url}`);
    calls.push({
      ip,
      path,
      method: options.method || 'GET',
      authorization: options.headers?.Authorization,
    });
    assert.equal(options.redirect, 'error', 'console HTTP never follows another destination');
    if (ip === four.ip) {
      assert.equal(u.port, '12801');
      if (!['/ping', '/system/info', '/storage', '/status', '/install/capabilities'].includes(path))
        assert.equal(options.headers.Authorization, `Bearer ${credentials[ip]}`);
      if (['/ping', '/status', '/install/capabilities', '/install/session'].includes(path))
        return response({ ...ps4Cap, status: 'ok', uptimeSeconds: 1, requests: 1, replies: 1 });
      if (path === '/system/info')
        return response({
          ...ps4Cap,
          environment: 'ps4',
          firmware: { version: '12.50' },
          model: { name: 'Slim', family: 'Slim' },
          hen: {},
        });
      if (path === '/storage')
        return response({
          ...ps4Cap,
          volumes: [
            {
              id: 'internal',
              path: '/user',
              available: true,
              totalBytes: 20 * 1024 ** 3,
              freeBytes: 18 * 1024 ** 3,
              availableBytes: 18 * 1024 ** 3,
              usedBytes: 2 * 1024 ** 3,
            },
          ],
        });
      if (path.startsWith('/apps/title/'))
        return response({
          service: ps4Cap.service,
          revision: 'a'.repeat(16),
          complete: true,
          total: ps4Inventory.length,
          next: null,
          app: {
            titleId: base.titleId,
            title: base.title,
            version: '01.00',
            installed: ps4Inventory.some((row) => row.kind === 'base'),
            protected: false,
          },
          components: ps4Inventory,
        });
      if (path.startsWith('/apps/runtime/'))
        return response({
          service: ps4Cap.service,
          titleId: base.titleId,
          running: false,
          appId: -1,
        });
      if (path === '/apps/remove') {
        const input = JSON.parse(options.body);
        assert.equal(input.kind, 'game');
        assert.equal(input.titleId, base.titleId);
        removals.push(input);
        const count = ps4Inventory.length;
        ps4Inventory.length = 0;
        const job = {
          service: ps4Cap.service,
          ...input,
          state: 'removed',
          completed: count,
          total: count,
          error: 0,
          errorHex: '0x00000000',
          pollError: 0,
        };
        jobs.set(input.requestId, job);
        return response(job);
      }
      if (path.startsWith('/apps/operations/')) return response(jobs.get(path.split('/').at(-1)));
      if (path === '/install/jobs/active')
        return response({ service: ps4Cap.service, active: false });
      if (path === '/install/jobs' && options.method === 'POST') {
        const input = JSON.parse(options.body);
        assert.ok(new URL(input.url).pathname.startsWith(`/ps4/manifest/${ip}/`));
        posts.push(input);
        const job = {
          service: ps4Cap.service,
          jobId: input.requestId,
          requestId: input.requestId,
          contentId: input.contentId,
          taskId: posts.length,
          state: finishPs4 ? 'installed' : 'downloading',
          totalBytes: input.size,
          downloadedBytes: finishPs4 ? input.size : 2048,
          downloadTotalBytes: input.size,
          error: 0,
          errorHex: '0x00000000',
          pollError: 0,
        };
        jobs.set(input.requestId, job);
        if (finishPs4) addPs4Component(input);
        return response(job);
      }
      if (path.startsWith('/install/jobs/')) {
        const id = path.split('/')[3],
          job = jobs.get(id);
        assert.ok(job, path);
        if (path.endsWith('/cancel')) job.state = 'cancelled';
        else if (finishPs4) {
          job.state = 'installed';
          job.downloadedBytes = job.totalBytes;
          addPs4Component(posts.find((input) => input.requestId === id));
        }
        return response(job);
      }
      assert.fail(`Unexpected PS4 endpoint: ${path}`);
    }
    assert.equal(u.port, '8095');
    const state = states.get(ip);
    if (path === '/health')
      return response({
        apiVersion: 'v1',
        pid: ip === a.ip ? 91 : 92,
        firmwareRead: true,
        firmwareRaw: '0x13600007',
        serviceReport: {
          service: 'PackageFlowService-PS5',
          platform: 'ps5',
          consoleVerified: true,
          version: '0.1.29-dev',
          buildId: 'unified-test',
        },
      });
    assert.equal(
      options.headers.Authorization,
      `Bearer ${credentials[ip]}`,
      'each PS5 keeps its own credential',
    );
    if (path === '/api/v1/capabilities')
      return response({
        service: 'PackageFlowService-PS5',
        capabilities: { installPs4Pkg: true, installPs5Content: true },
      });
    if (path === '/api/v1/system')
      return response({
        service: 'PackageFlowService-PS5',
        storageRead: true,
        freeBytes: 18 * 1024 ** 3,
        totalBytes: 20 * 1024 ** 3,
      });
    if (path === '/api/v1/install/readiness')
      return response({
        service: 'PackageFlowService-PS5',
        schemaVersion: 1,
        route: 'staged-pkg',
        ready: true,
        reason: 'ready',
        formats: ['pkg'],
        platforms: ['ps4', 'ps5'],
        exactVersionReceipt: false,
      });
    if (path === '/api/v1/management/status')
      return response({ protocol: 'ps5-management-v1', ready: true, catalog: true });
    if (path === '/api/v1/console/catalog')
      return response({
        revision: 'a'.repeat(64),
        entries: state.installed
          ? [
              {
                titleId: native.titleId,
                contentId: native.contentId,
                metadata: JSON.stringify({ contentVersion: native.appVersion }),
              },
            ]
          : [],
        next: state.installed ? 1 : 0,
        done: true,
      });
    if (path === '/api/v1/console/info')
      return response({
        title_id: native.titleId,
        installed: state.installed,
        source_available: true,
        content_id: native.contentId,
        version: native.appVersion,
        sourceIdentity: 'd'.repeat(64),
      });
    const transferId = options.headers['X-PackageFlow-Transfer-Id'];
    assert.match(transferId, /^[a-f0-9]{32}$/);
    if (path === '/api/v1/transfers/begin') {
      if (!state.transfers.has(transferId))
        state.transfers.set(transferId, {
          id: transferId,
          bytesDurable: 0,
          size: Number(options.headers['X-PackageFlow-Size']),
          blake3: options.headers['X-PackageFlow-Blake3'],
          verified: false,
          cancelled: false,
          chunkMax: 262144,
          batchMax: 0,
        });
      return response(state.transfers.get(transferId));
    }
    const transfer = state.transfers.get(transferId);
    assert.ok(transfer, `Known transfer on captured console: ${ip} ${path}`);
    if (path === '/api/v1/transfers/chunk') {
      const offset = Number(options.headers['X-PackageFlow-Offset']);
      assert.equal(offset, transfer.bytesDurable);
      assert.deepEqual(
        Buffer.from(options.body),
        nativeBytes.subarray(offset, offset + options.body.length),
      );
      const holdAt = ip === a.ip ? 262144 : 524288;
      if (!state.release && offset >= holdAt) {
        state.blocked = true;
        await new Promise((resolve, reject) => {
          const abort = () => reject(options.signal.reason);
          state.unblock = () => {
            options.signal.removeEventListener('abort', abort);
            resolve();
          };
          if (options.signal.aborted) abort();
          else options.signal.addEventListener('abort', abort, { once: true });
        });
      }
      options.signal.throwIfAborted();
      transfer.bytesDurable += options.body.length;
      return response(transfer);
    }
    if (path === '/api/v1/transfers/cancel') {
      state.cancels++;
      transfer.cancelled = true;
      return response(transfer);
    }
    if (path === '/api/v1/transfers/commit') {
      transfer.verified = true;
      return response(transfer);
    }
    if (path === '/api/v1/transfers/status') return response(transfer);
    if (path === '/api/v1/install/staged') {
      state.submits++;
      return response({ state: 'submitting' });
    }
    if (path === '/api/v1/install/status')
      return response({ ok: true, job: ip === a.ip ? '1-5' : '1-6' });
    if (path === '/api/v1/installer/job')
      return response({
        ok: true,
        phase: 'done',
        total: transfer.size,
        bytes_served: transfer.size,
        code: 0,
      });
    if (path === '/api/v1/install/verify') {
      state.installed = true;
      return response({
        title: native.titleId,
        proof: 'base-registration',
        scope: 'internal-storage-only',
        contentPresent: true,
        metadataMatch: true,
        jobBound: true,
        registered: true,
      });
    }
    assert.fail(`Unexpected PS5 endpoint: ${ip} ${path}`);
  };
  function addPs4Component(input) {
    const pkg = input.contentType === 'PS4GP' ? patch : base;
    if (!ps4Inventory.some((row) => row.kind === (pkg.installOrder ? 'patch' : 'base')))
      ps4Inventory.push({
        id: pkg.installOrder ? 'patch' : 'base',
        kind: pkg.installOrder ? 'patch' : 'base',
        title: pkg.title,
        version: pkg.appVersion,
        contentId: pkg.contentId,
        sizeBytes: pkg.size,
        storage: 'internal',
        canRemove: true,
      });
  }
  const selection4 = { packageIds: [patch.id, base.id] };
  const selection5 = { packageIds: [native.id] };
  const [started4, started5] = await Promise.all([
    api.installDeviceBatch('1'.repeat(32), selection4, [four.id], 'localhost:3000'),
    api.installDeviceBatch('2'.repeat(32), selection5, [a.id, b.id], 'localhost:3000'),
  ]);
  assert.ok(
    [...started4.results, ...started5.results].every((item) => item.state === 'queued'),
    JSON.stringify([started4, started5]),
  );
  const initialQueueIds = [
    api.getInstallationQueue(four.ip).id,
    api.getPs5Queue(a.id).id,
    api.getPs5Queue(b.id).id,
  ];
  assert.equal(new Set(initialQueueIds).size, 3);
  await until(
    () => posts.length === 1 && states.get(a.ip).blocked && states.get(b.ip).blocked,
    'all three workers concurrently active',
  );
  const initialPs5Bytes = [a, b].map((p) => api.getPs5Queue(p.id).items[0].bytesSent);
  assert.deepEqual(initialPs5Bytes, [262144, 524288]);
  assert.equal(
    api.getInstallationQueue(four.ip).items[0].packageId,
    base.id,
    'PS4 base precedes patch',
  );
  assert.equal(api.getInstallationQueue(four.ip).items[0].bytesSent, 2048);
  const durableA = JSON.parse(
    readFileSync(join(data, 'consoles', a.id, 'ps5-installation-queue.json')),
  );
  const durableB = JSON.parse(
    readFileSync(join(data, 'consoles', b.id, 'ps5-installation-queue.json')),
  );
  assert.notEqual(
    durableA.items[0].transferId,
    durableB.items[0].transferId,
    'same source gets destination-specific transfer IDs',
  );
  assert.notEqual(api.getPs5Tasks(a.id).active[0].id, api.getPs5Tasks(b.id).active[0].id);
  api.selectConsoleProfile(b.id);
  api.cancelPs5Queue(a.id, initialQueueIds[1]);
  await until(() => api.getPs5Queue(a.id).status === 'cancelled', 'cancel only PS5 A');
  assert.equal(states.get(a.ip).cancels, 1);
  assert.equal(states.get(a.ip).submits, 0);
  assert.equal(states.get(b.ip).cancels, 0);
  assert.equal(api.getPs5Queue(b.id).status, 'running');
  assert.equal(api.getPs5Queue(b.id).items[0].bytesSent, 524288);
  assert.equal(api.getInstallationQueue(four.ip).status, 'running');

  finishPs4 = true;
  await until(
    () => api.getInstallationQueue(four.ip).status === 'completed',
    'PS4 base and patch finish despite PS5 cancellation',
  );
  assert.deepEqual(
    posts.map((input) => input.contentType),
    ['PS4GD', 'PS4GP'],
  );
  const replace4 = await api.previewDeviceInstall(selection4, [four.id]);
  assert.equal(replace4.devices[0].installedPackages.length, 2);
  assert.ok(replace4.devices[0].installedPackages.every((item) => item.canReinstall));
  const reinstall4 = await api.installDeviceBatch(
    '3'.repeat(32),
    selection4,
    [four.id],
    'localhost:3000',
    { [four.id]: [base.id, patch.id] },
    { [four.id]: replace4.devices[0].reviewToken },
  );
  assert.equal(reinstall4.results[0].state, 'queued', reinstall4.results[0].message);
  await until(
    async () => (await api.advanceSelectedReinstall(four.ip)).state === 'completed',
    'PS4 approved base+patch replacement',
  );
  assert.deepEqual(
    posts.map((input) => input.contentType),
    ['PS4GD', 'PS4GP', 'PS4GD', 'PS4GP'],
  );
  assert.equal(removals.length, 1);
  assert.equal(
    api.getPs5Queue(b.id).items[0].bytesSent,
    524288,
    'PS4 replacement does not alter PS5 progress',
  );

  states.get(a.ip).release = true;
  const retry = await api.installDeviceBatch('4'.repeat(32), selection5, [a.id], 'localhost:3000');
  assert.equal(retry.results[0].state, 'queued', retry.results[0].message);
  assert.notEqual(api.getPs5Queue(a.id).id, initialQueueIds[1]);
  await until(
    () => api.getPs5Queue(a.id).status === 'completed',
    'cancelled PS5 can start another queue while PS5 B is active',
  );
  const replace5 = await api.previewDeviceInstall(selection5, [a.id]);
  assert.equal(replace5.devices[0].installedPackages[0].canOverwrite, true);
  const reinstall5 = await api.installDeviceBatch(
    '5'.repeat(32),
    selection5,
    [a.id],
    'localhost:3000',
    { [a.id]: [native.id] },
    { [a.id]: replace5.devices[0].reviewToken },
  );
  assert.equal(reinstall5.results[0].state, 'queued', reinstall5.results[0].message);
  await until(() => api.getPs5Queue(a.id).status === 'completed', 'approved PS5 PKG replacement');
  assert.equal(
    states.get(a.ip).submits,
    2,
    'explicit replacement dispatches installed package rather than silently skipping',
  );
  assert.equal(api.getPs5Queue(b.id).id, initialQueueIds[2]);
  assert.equal(api.getPs5Queue(b.id).items[0].bytesSent, 524288);
  assert.equal(states.get(b.ip).submits, 0);
  states.get(b.ip).release = true;
  states.get(b.ip).unblock();
  await until(
    () => api.getPs5Queue(b.id).status === 'completed',
    'PS5 B independently finishes original queue',
  );
  assert.ok(
    [a, b].every((p) => api.getPs5Queue(p.id).items.every((item) => item.state === 'installed')),
  );
  assert.ok(api.getInstallationQueue(four.ip).items.every((item) => item.state === 'installed'));
  assert.deepEqual(
    ['ps4-service-keys.json', 'ps5-service-keys.json'].map((name) =>
      readFileSync(join(data, name), 'utf8'),
    ),
    keyFiles,
  );
  assert.ok(
    calls
      .filter((call) => call.path !== '/health' && call.ip !== four.ip)
      .every((call) => call.authorization === `Bearer ${credentials[call.ip]}`),
  );
  return {
    devices: 3,
    initialQueueIds,
    initialPs5Bytes,
    cancelledDestinations: states.get(a.ip).cancels,
    ps4Installs: posts.length,
    ps5AInstalls: states.get(a.ip).submits,
    ps5BInstalls: states.get(b.ip).submits,
    ps4Removals: removals.length,
    keysPreserved: true,
    allFinished: true,
  };
}

try {
  const proof = await run();
  process.stdout.write(`${JSON.stringify(proof)}\n`);
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
