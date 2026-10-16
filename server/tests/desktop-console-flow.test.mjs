import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const work = mkdtempSync(join(tmpdir(), 'pf-desktop-flow-')),
  oldData = process.env.PACKAGEFLOW_DATA_DIR,
  oldFetch = globalThis.fetch;
process.env.PACKAGEFLOW_DATA_DIR = join(work, 'data');
mkdirSync(process.env.PACKAGEFLOW_DATA_DIR);
await build({
  stdin: {
    contents:
      "export * from './server/utils/desktop-console-setup'; export * from './server/utils/console-profiles'; export * from './server/utils/console-forget';",
    resolveDir: resolve('.'),
  },
  outfile: join(work, 'api.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  banner: {
    js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);",
  },
});
const api = await import(join(work, 'api.mjs')),
  data = process.env.PACKAGEFLOW_DATA_DIR;
const param = Buffer.from(
  JSON.stringify({
    titleId: 'PPSA95001',
    contentId: 'IV0000-PPSA95001_00-PACKAGEFLOWUI001',
    contentVersion: '01.000.041',
    applicationCategoryType: 0,
    requiredSystemSoftwareVersion: '0x0800000000000000',
    localizedParameters: { defaultLanguage: 'en-US', 'en-US': { titleName: 'PackageFlow' } },
  }),
);
function exfat() {
  const b = Buffer.alloc(1024 * 1024);
  b.write('EXFAT   ', 3);
  b.writeUInt16LE(0xaa55, 510);
  b[108] = 9;
  b[109] = 0;
  b[110] = 1;
  b.writeBigUInt64LE(BigInt(b.length / 512), 72);
  b.writeUInt32LE(24, 80);
  b.writeUInt32LE(16, 84);
  b.writeUInt32LE(128, 88);
  b.writeUInt32LE(1792, 92);
  b.writeUInt32LE(2, 96);
  function entry(at, name, dir, cluster, size) {
    b[at] = 0x85;
    b[at + 1] = 2;
    b.writeUInt16LE(dir ? 0x10 : 0, at + 4);
    b[at + 32] = 0xc0;
    b[at + 33] = 2;
    b[at + 35] = name.length;
    b.writeUInt32LE(cluster, at + 52);
    b.writeBigUInt64LE(BigInt(size), at + 56);
    b[at + 64] = 0xc1;
    b.write(name, at + 66, 'utf16le');
  }
  entry(65536, 'sce_sys', true, 3, 512);
  entry(65536 + 96, 'eboot.bin', false, 5, 16);
  entry(65536 + 512, 'param.json', false, 4, param.length);
  param.copy(b, 65536 + 1024);
  b.write('owned SELF bytes', 65536 + 1536);
  return b;
}

const elf = Buffer.alloc(8192);
Buffer.from('7f454c460201', 'hex').copy(elf);
elf.writeUInt16LE(62, 18);
const image = exfat(),
  artifact = (fileName, bytes) => ({
    fileName,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
const manifest = {
  schemaVersion: 1,
  elf: {
    ...artifact('service.elf', elf),
    firmware: '13.60',
    version: '0.1.15-dev',
    buildId: 'fixture',
  },
  app: {
    ...artifact('PackageFlow.exfat', image),
    name: 'PackageFlow',
    titleId: 'PPSA95001',
    contentId: 'IV0000-PPSA95001_00-PACKAGEFLOWUI001',
    version: '01.000.041',
    format: 'exfat',
  },
};
mkdirSync(join(data, 'console-setup'));
writeFileSync(join(data, 'console-setup', 'manifest.json'), JSON.stringify(manifest));
writeFileSync(join(data, 'console-setup', manifest.elf.fileName), elf);
writeFileSync(join(data, 'console-setup', manifest.app.fileName), image);
const p = api.saveConsoleProfile({ name: 'Fixture', platform: 'ps5', ip: '192.168.50.5' })
  .consoles[0];
const other = api.saveConsoleProfile({ name: 'PS4', platform: 'ps4', ip: '192.168.50.4' })
  .consoles[1];
writeFileSync(
  join(data, 'ps5-service-keys.json'),
  JSON.stringify({ [p.ip]: 'a'.repeat(64), '192.168.50.8': 'b'.repeat(64) }),
);
writeFileSync(join(data, 'ps4-service-keys.json'), JSON.stringify({ [other.ip]: 'c'.repeat(32) }));
let pairingMode = 'automatic',
  pairCalls = 0;
let mode = 'installed',
  writes = 0,
  running = false,
  managed = true,
  sourceAvailable = true,
  controlReady = true,
  contentId = manifest.app.contentId;
const capabilityReplies = [],
  readinessReplies = [];
let capabilityReads = 0,
  readinessReads = 0;
let advanceReadinessClock;
const game = () => ({
  title_id: manifest.app.titleId,
  title_name: 'PackageFlow',
  platform: 'ps5',
  source_type: 'image',
  image_type: 'exfat',
  version: manifest.app.version,
  content_id: contentId,
  path: '/data/homebrew/PPSA95001.exfat',
  installed: true,
  mounted: true,
  managed,
  source_available: sourceAvailable,
  can_manage_source: true,
  can_uninstall: true,
  sourceIdentity: 'd'.repeat(64),
});
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname,
    response = (body, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === '/api/v1/pair') {
    pairCalls++;
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['X-PackageFlow-Pairing-Mode'], 'automatic');
    assert.equal(options.headers['X-PackageFlow-Pairing-Code'], undefined);
    return response({ apiVersion: 'v1', pairingMode: 'automatic', token: 'a'.repeat(64) });
  }
  if (path === '/api/v1/web/config')
    return response({
      service: 'PackageFlowService-PS5',
      webConfigured: true,
      webHost: options.headers['X-PackageFlow-Web-Host'],
      webPort: Number(options.headers['X-PackageFlow-Web-Port']),
      webConsoleId: options.headers['X-PackageFlow-Console-Id'],
    });
  if (path === '/api/v1/console/command') {
    writes++;
    assert.equal(options.headers['X-PackageFlow-Title'], 'PPSA95001');
    assert.equal(options.headers['X-PackageFlow-Action'], 'delete');
    return response({
      requestId: options.headers['X-PackageFlow-Request-Id'],
      titleId: 'PPSA95001',
      action: 'delete',
      state: 'accepted',
      result: { status: 0 },
    });
  }
  assert.notEqual(options.method, 'POST');
  if (path === '/health')
    return response({
      apiVersion: 'v1',
      pairingMode,
      firmwareRead: true,
      firmwareRaw: '0x13600000',
      serviceReport: {
        service: 'PackageFlowService-PS5',
        platform: 'ps5',
        consoleVerified: true,
        version: '0.1.28-dev',
      },
    });
  if (path === '/api/v1/capabilities') {
    capabilityReads++;
    return capabilityReplies.shift() === 'unauthorized'
      ? response({ error: 'unauthorized' }, 401)
      : response({ service: 'PackageFlowService-PS5', capabilities: {} });
  }
  if (path === '/api/v1/system')
    return response({ service: 'PackageFlowService-PS5', storageRead: false });
  if (path === '/api/v1/install/readiness') {
    readinessReads++;
    advanceReadinessClock?.();
    const ready = readinessReplies.shift() !== false;
    return response({
      service: 'PackageFlowService-PS5',
      schemaVersion: 1,
      images: {
        schemaVersion: 1,
        route: 'staged-image',
        ready,
        reason: ready ? 'ready' : 'backend_starting',
        protocol: 'image-registration-v1',
        backend: 'ShadowMountPlus-1.7beta3',
        registrationReceipt: true,
        platforms: ['ps5'],
        formats: ['ufs2', 'exfat', 'pfs', 'ffpfsc'],
      },
    });
  }
  if (path === '/api/v1/management/status')
    return response({
      protocol: 'ps5-management-v1',
      ready: true,
      catalog: true,
      consoleControl: controlReady,
      consoleActivity: true,
    });
  if (path === '/api/v1/console/catalog')
    return mode === 'unknown'
      ? response({}, 503)
      : mode === 'absent'
        ? response({ revision: 'e'.repeat(64), entries: [], next: 0, done: true })
        : response({
            revision: 'e'.repeat(64),
            entries: [
              {
                titleId: manifest.app.titleId,
                contentId,
                metadata: JSON.stringify({ contentVersion: manifest.app.version }),
              },
            ],
            next: 1,
            done: true,
          });
  if (path === '/api/v1/console/info') return response(game());
  if (path === '/api/v1/console/activity')
    return response({
      complete: true,
      running,
      appId: running ? 10 : 0,
      titleId: running ? 'PPSA95001' : '',
    });
  assert.fail(path);
};
test('connection without a PIN validates service mode and retains credentials on repeat', async () => {
  pairingMode = undefined;
  await assert.rejects(api.pairConsoleProfile(p.id, 'http://192.168.50.1:3000'), {
    statusCode: 409,
  });
  assert.equal(pairCalls, 0);
  pairingMode = 'automatic';
  await api.pairConsoleProfile(p.id, 'http://192.168.50.1:3000');
  await api.pairConsoleProfile(p.id, 'http://192.168.50.1:3000');
  assert.equal(pairCalls, 2);
  assert.equal(
    JSON.parse(readFileSync(join(data, 'ps5-service-keys.json'), 'utf8'))[p.ip],
    'a'.repeat(64),
  );
});
test('network loss retains this WEB key and another WEB can connect independently without a PIN', async () => {
  const saved = readFileSync(join(data, 'ps5-service-keys.json'), 'utf8'),
    serviceFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    await assert.rejects(
      api.pairConsoleProfile(p.id, 'http://192.168.50.1:3000'),
      (error) => error.statusCode === 503 && error.message.includes('8095'),
    );
    await api.probeConsoleProfile(p.id);
    const offline = api.getConsoleProfiles().consoles.find((row) => row.id === p.id);
    assert.equal(offline.online, false);
    assert.equal(offline.paired, false);
    assert.equal(offline.pairingConfigured, true);
    assert.equal(readFileSync(join(data, 'ps5-service-keys.json'), 'utf8'), saved);
    globalThis.fetch = serviceFetch;
    await api.probeConsoleProfile(p.id);
    assert.equal(api.getConsoleProfiles().consoles.find((row) => row.id === p.id).paired, true);
    const otherData = join(work, 'another-web');
    mkdirSync(otherData);
    process.env.PACKAGEFLOW_DATA_DIR = otherData;
    const second = api
      .saveConsoleProfile({ name: 'Second WEB', platform: 'ps5', ip: p.ip })
      .consoles.find((row) => row.ip === p.ip);
    assert.equal(api.consolePairConfigured(second.id), false);
    const before = pairCalls;
    await api.pairConsoleProfile(second.id, 'http://192.168.50.2:3000');
    assert.equal(pairCalls, before + 1);
    assert.equal(
      api.getConsoleProfiles().consoles.find((row) => row.id === second.id).paired,
      true,
    );
    assert.equal(
      JSON.parse(readFileSync(join(otherData, 'ps5-service-keys.json'), 'utf8'))[p.ip],
      'a'.repeat(64),
    );
  } finally {
    globalThis.fetch = serviceFetch;
    process.env.PACKAGEFLOW_DATA_DIR = data;
  }
  assert.equal(readFileSync(join(data, 'ps5-service-keys.json'), 'utf8'), saved);
});
test('first request reads the console and skips an already installed app without dispatch or receipt', async () => {
  assert.equal((await api.installDesktopPs5App(p.id, '1'.repeat(32))).retry, 'installed');
  assert.equal(writes, 0);
  assert.throws(
    () => readFileSync(join(data, 'console-setup', `app-${p.id}-${'1'.repeat(32)}.json`)),
    { code: 'ENOENT' },
  );
  mode = 'unknown';
  await assert.rejects(api.installDesktopPs5App(p.id, '2'.repeat(32)), { statusCode: 409 });
  assert.equal(writes, 0);
  mode = 'installed';
});
test('own-app preflight rechecks transient readiness, but never bypasses a persistent or unpaired result', async () => {
  try {
    let reads = readinessReads;
    readinessReplies.push(false, true);
    assert.equal((await api.installDesktopPs5App(p.id, 'a1'.repeat(16))).retry, 'installed');
    assert.equal(
      readinessReads - reads,
      2,
      'one fresh authenticated readiness probe may recover after an ELF restart',
    );
    assert.equal(writes, 0);
    const realNow = Date.now;
    let virtualNow = realNow(),
      virtualProbes = 0;
    reads = readinessReads;
    readinessReplies.push(false, true);
    Date.now = () => virtualNow;
    advanceReadinessClock = () => {
      if (++virtualProbes === 1) virtualNow += 2500;
    };
    try {
      assert.equal((await api.installDesktopPs5App(p.id, 'a4'.repeat(16))).retry, 'installed');
      assert.equal(
        readinessReads - reads,
        2,
        'a slow initial probe must not consume the later readonly retry window',
      );
    } finally {
      Date.now = realNow;
      advanceReadinessClock = undefined;
    }
    reads = readinessReads;
    readinessReplies.push(false, false, false);
    await assert.rejects(
      api.installDesktopPs5App(p.id, 'a2'.repeat(16)),
      (error) => error.statusCode === 409 && error.message.includes('Установка этого формата'),
    );
    assert.equal(
      readinessReads - reads,
      3,
      'persistent missing readiness must stop after the bounded three probes',
    );
    const authReads = capabilityReads;
    reads = readinessReads;
    readinessReplies.push(false, true);
    capabilityReplies.push('ready', 'unauthorized');
    await assert.rejects(
      api.installDesktopPs5App(p.id, 'a3'.repeat(16)),
      (error) => error.statusCode === 409 && error.message.includes('Установка этого формата'),
    );
    assert.equal(
      capabilityReads - authReads,
      2,
      'losing pairing stops retries rather than accepting a later reply',
    );
    assert.equal(
      readinessReads - reads,
      1,
      'an unauthenticated profile must not query installation readiness again',
    );
    assert.equal(writes, 0, 'all readiness retries are read-only');
  } finally {
    readinessReplies.length = 0;
    capabilityReplies.length = 0;
    await api.probeConsoleProfile(p.id);
  }
});
test('orphan repair cannot overwrite a foreign identity or mistake a present source for absence', async () => {
  sourceAvailable = false;
  contentId = 'IV0000-PPSA95001_00-OTHERAPP';
  await assert.rejects(api.installDesktopPs5App(p.id, '5'.repeat(32)), { statusCode: 409 });
  assert.equal(writes, 0);
  sourceAvailable = true;
  contentId = manifest.app.contentId;
});
test('a proven local delete preflight rejection unblocks another request without admitting unknown commands', async () => {
  const rejectedRequest = '8'.repeat(32),
    freshRequest = '9'.repeat(32);
  const journalPath = join(data, 'console-setup', `app-upgrade-${p.id}-${rejectedRequest}.json`);
  let commandPath;
  try {
    controlReady = false;
    await assert.rejects(
      api.installDesktopPs5App(p.id, rejectedRequest, true),
      (error) => error.statusCode === 409 && error.data?.commandNotDispatched === true,
    );
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    commandPath = join(data, 'ps5-game-commands', `${journal.deleteId}.json`);
    assert.equal(journal.deleteNotDispatched?.commandNotDispatched, true);
    assert.throws(() => readFileSync(commandPath), { code: 'ENOENT' });
    assert.equal(writes, 0, 'the rejected preflight must precede every native mutation');
    controlReady = true;
    assert.equal(
      (await api.installDesktopPs5App(p.id, freshRequest)).retry,
      'installed',
      'a bound presend proof may unblock the next explicit read-only request',
    );
    const mismatch = {
      ...journal,
      deleteNotDispatched: { ...journal.deleteNotDispatched, sourceIdentity: '0'.repeat(64) },
    };
    writeFileSync(journalPath, JSON.stringify(mismatch));
    await assert.rejects(
      api.installDesktopPs5App(p.id, freshRequest),
      (error) =>
        error.statusCode === 409 &&
        error.message.includes('прежнего обновления приложения неизвестен'),
    );
    writeFileSync(journalPath, JSON.stringify(journal));
    mkdirSync(join(data, 'ps5-game-commands'), { recursive: true });
    writeFileSync(
      commandPath,
      JSON.stringify({
        id: journal.deleteId,
        consoleId: p.id,
        sourceIp: p.ip,
        titleId: manifest.app.titleId,
        action: 'delete',
        sourceIdentity: journal.sourceIdentity,
        state: 'unconfirmed',
      }),
    );
    await assert.rejects(
      api.installDesktopPs5App(p.id, freshRequest),
      (error) =>
        error.statusCode === 409 &&
        error.message.includes('прежнего обновления приложения неизвестен'),
    );
    assert.equal(
      writes,
      0,
      'an existing unknown native intent always wins over the presend marker',
    );
  } finally {
    controlReady = true;
    rmSync(journalPath, { force: true });
    if (commandPath) rmSync(commandPath, { force: true });
  }
});
test('another request cannot bypass an unknown prior stop or delete even when its bundle hash changes', async () => {
  const oldRequest = 'a'.repeat(32),
    newRequest = 'b'.repeat(32),
    stopId = '6'.repeat(32),
    deleteId = '7'.repeat(32);
  const journalPath = join(data, 'console-setup', `app-upgrade-${p.id}-${oldRequest}.json`);
  const commandPath = (id) => join(data, 'ps5-game-commands', `${id}.json`);
  const journal = {
    consoleId: p.id,
    ip: p.ip,
    sha256: 'f'.repeat(64),
    titleId: manifest.app.titleId,
    sourceIdentity: 'd'.repeat(64),
    deleteId,
    startedAt: 100,
  };
  const command = (id, action, state) => ({
    id,
    consoleId: p.id,
    sourceIp: p.ip,
    titleId: manifest.app.titleId,
    action,
    sourceIdentity: journal.sourceIdentity,
    destination: '',
    expectedAppId: action === 'stop' ? 10 : 0,
    state,
    result: { status: 0 },
  });
  mkdirSync(join(data, 'ps5-game-commands'), { recursive: true });
  try {
    for (const scenario of [
      { deleteState: null },
      { deleteState: 'unconfirmed' },
      { deleteState: 'accepted', stopState: null },
      { deleteState: 'accepted', stopState: 'unconfirmed' },
    ]) {
      for (const id of [stopId, deleteId]) rmSync(commandPath(id), { force: true });
      writeFileSync(
        journalPath,
        JSON.stringify({ ...journal, ...('stopState' in scenario ? { stopId, appId: 10 } : {}) }),
      );
      if (scenario.deleteState)
        writeFileSync(
          commandPath(deleteId),
          JSON.stringify(command(deleteId, 'delete', scenario.deleteState)),
        );
      if (scenario.stopState)
        writeFileSync(
          commandPath(stopId),
          JSON.stringify(command(stopId, 'stop', scenario.stopState)),
        );
      await assert.rejects(
        api.installDesktopPs5App(p.id, newRequest, true),
        (error) =>
          error.statusCode === 409 &&
          error.message.includes('прежнего обновления приложения неизвестен'),
      );
      assert.equal(
        writes,
        0,
        'a fresh request ID or a new bundle must never dispatch past the unknown prior command',
      );
      assert.throws(
        () => readFileSync(join(data, 'console-setup', `app-${p.id}-${newRequest}.json`)),
        { code: 'ENOENT' },
      );
    }
    // Known terminal native results may unblock a new explicit check. The old
    // receipt is never replayed; the already-present control remains read-only.
    for (const state of ['accepted', 'failed']) {
      writeFileSync(commandPath(stopId), JSON.stringify(command(stopId, 'stop', state)));
      writeFileSync(commandPath(deleteId), JSON.stringify(command(deleteId, 'delete', state)));
      assert.equal((await api.installDesktopPs5App(p.id, newRequest)).retry, 'installed');
      assert.equal(writes, 0);
    }
  } finally {
    rmSync(journalPath, { force: true });
    for (const id of [stopId, deleteId]) rmSync(commandPath(id), { force: true });
  }
});
test('a later same-version build or unresolved upgrade invalidates an older successful build receipt', async () => {
  const history = api
    .saveConsoleProfile({ name: 'Build history fixture', platform: 'ps5', ip: '192.168.50.9' })
    .consoles.find((row) => row.ip === '192.168.50.9');
  const keyPath = join(data, 'ps5-service-keys.json'),
    keys = JSON.parse(readFileSync(keyPath, 'utf8'));
  writeFileSync(keyPath, JSON.stringify({ ...keys, [history.ip]: '9'.repeat(64) }));
  const requestA = 'c'.repeat(32),
    requestB = 'd'.repeat(32),
    requestC = 'e'.repeat(32),
    queueA = '8'.repeat(32),
    queueB = '9'.repeat(32);
  const packageId = createHash('sha256')
    .update(resolve(data, 'console-setup', manifest.app.fileName))
    .digest('hex')
    .slice(0, 32);
  const receiptPath = (request) => join(data, 'console-setup', `app-${history.id}-${request}.json`);
  const upgradePath = join(data, 'console-setup', `app-upgrade-${history.id}-${requestC}.json`);
  const receipt = (requestId, queueId, sha256, startedAt) => ({
    consoleId: history.id,
    ip: history.ip,
    requestId,
    packageId,
    queueId,
    sha256,
    startedAt,
    state: 'queued',
  });
  const installed = (queueId, transferId) => ({
    packageId,
    queueId,
    transferId,
    title: 'PackageFlow',
    titleId: manifest.app.titleId,
    fileName: manifest.app.fileName,
    size: image.length,
    type: 'Игра',
    platform: 'ps5',
    format: 'exfat',
    branch: 'app-history',
    order: 0,
    state: 'installed',
    detail: 'Registered fixture',
    bytesSent: image.length,
    confirmation: 'service-registration',
    confirmedAt: 100,
    createdAt: 100,
  });
  const directory = join(data, 'consoles', history.id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'ps5-installation-queue.json'),
    JSON.stringify({
      version: 1,
      id: queueB,
      consoleId: history.id,
      psIp: history.ip,
      transport: 'service',
      status: 'completed',
      items: [installed(queueB, '1'.repeat(32))],
      history: [[installed(queueA, '2'.repeat(32))]],
      createdAt: 100,
      updatedAt: 100,
      message: '',
    }),
  );
  try {
    writeFileSync(
      receiptPath(requestA),
      JSON.stringify(receipt(requestA, queueA, manifest.app.sha256, 100)),
    );
    assert.equal(api.findDesktopPs5AppRequest(history.id, manifest.app.sha256), requestA);
    assert.equal((await api.readDesktopPs5AppSetup(history.id, requestA)).retry, 'installed');
    // A fresh WEB/Windows client may share exact current proof, but that proof
    // must be reread: loss of contact blocks writes, while live absence permits
    // a fresh restoration instead of repeatedly returning the stale receipt.
    const freshRequest = 'f'.repeat(32);
    assert.equal((await api.readDesktopPs5AppSetup(history.id, freshRequest)).retry, 'installed');
    assert.equal(
      (await api.installDesktopPs5App(history.id, freshRequest, true)).retry,
      'installed',
    );
    mode = 'unknown';
    assert.equal((await api.readDesktopPs5AppSetup(history.id, freshRequest)).retry, 'unavailable');
    assert.equal(
      (await api.installDesktopPs5App(history.id, freshRequest, true)).retry,
      'unavailable',
    );
    assert.equal(writes, 0, 'an unreachable shared app receipt must not trigger an update');
    mode = 'absent';
    assert.equal(
      await api.readDesktopPs5AppSetup(history.id, freshRequest),
      null,
      'a confirmed removed application must not inherit the old installed receipt',
    );
    mode = 'installed';
    // Both source snapshots have the same PARAM version; only the newer receipt
    // records that B superseded A. A matching old SHA is no longer current proof.
    writeFileSync(
      receiptPath(requestB),
      JSON.stringify(receipt(requestB, queueB, 'f'.repeat(64), 200)),
    );
    assert.equal(api.findDesktopPs5AppRequest(history.id, manifest.app.sha256), null);
    assert.equal(api.findDesktopPs5AppRequest(history.id, 'f'.repeat(64)), requestB);
    assert.equal((await api.readDesktopPs5AppSetup(history.id, requestA)).retry, 'different-build');
    writeFileSync(
      upgradePath,
      JSON.stringify({
        consoleId: history.id,
        ip: history.ip,
        sha256: manifest.app.sha256,
        titleId: manifest.app.titleId,
        sourceIdentity: 'd'.repeat(64),
        deleteId: '3'.repeat(32),
        startedAt: 300,
      }),
    );
    assert.equal(
      api.findDesktopPs5AppRequest(history.id, manifest.app.sha256),
      null,
      'a newer unresolved replacement cannot revive an older successful matching SHA',
    );
    assert.equal((await api.readDesktopPs5AppSetup(history.id, requestA)).retry, 'different-build');
    assert.equal(writes, 0, 'cross-client receipt sharing is a read-only operation');
  } finally {
    mode = 'installed';
    for (const path of [receiptPath(requestA), receiptPath(requestB), upgradePath])
      rmSync(path, { force: true });
    api.forgetConsole(history.id, true);
  }
});
test('app removal is source deletion, bound to its exact identity; replay never dispatches again', async () => {
  running = true;
  await assert.rejects(api.removeDesktopPs5App(p.id, '3'.repeat(32), true), { statusCode: 409 });
  running = false;
  managed = false;
  await assert.rejects(api.removeDesktopPs5App(p.id, '3'.repeat(32), true), { statusCode: 409 });
  managed = true;
  contentId = 'IV0000-PPSA95001_00-OTHERAPP';
  await assert.rejects(api.removeDesktopPs5App(p.id, '3'.repeat(32), true), { statusCode: 409 });
  contentId = manifest.app.contentId;
  assert.equal(writes, 0);
  assert.equal((await api.removeDesktopPs5App(p.id, '3'.repeat(32), true)).state, 'accepted');
  assert.equal(writes, 1);
  // The source can disappear after acceptance; replay must read its durable receipt first.
  contentId = 'gone';
  assert.equal((await api.removeDesktopPs5App(p.id, '3'.repeat(32), true)).state, 'accepted');
  assert.equal(writes, 1);
});
test('forgetting one offline device erases its key only, and re-adding it cannot restore trusted access', () => {
  assert.throws(() => api.forgetConsole(p.id, false), { statusCode: 400 });
  mkdirSync(join(data, 'ps5-save-restores'), { recursive: true });
  const pending = join(data, 'ps5-save-restores', '4'.repeat(32) + '.json');
  writeFileSync(pending, JSON.stringify({ consoleId: p.id, state: 'pending' }));
  assert.throws(() => api.forgetConsole(p.id, true), { statusCode: 409 });
  assert.equal(api.consolePairConfigured(p.id), true, 'unfinished restoration must retain the key');
  rmSync(pending);
  const result = api.forgetConsole(p.id, true);
  assert.equal(result.remotePairing, 'unchanged');
  assert.equal(result.profiles.consoles.length, 1);
  assert.equal(
    JSON.parse(readFileSync(join(data, 'ps5-service-keys.json'), 'utf8'))[p.ip],
    undefined,
  );
  assert.equal(
    JSON.parse(readFileSync(join(data, 'ps5-service-keys.json'), 'utf8'))['192.168.50.8'],
    'b'.repeat(64),
  );
  assert.equal(
    JSON.parse(readFileSync(join(data, 'ps4-service-keys.json'), 'utf8'))[other.ip],
    'c'.repeat(32),
  );
  const readded = api
    .saveConsoleProfile({ name: 'Again', ip: p.ip, platform: 'ps5' })
    .consoles.find((row) => row.ip === p.ip);
  assert.equal(api.consolePairConfigured(readded.id), false);
});
test.after(() => {
  assert.equal(writes, 1, 'all scenarios must finish with exactly one destructive dispatch');
  console.log(
    'PASS: live app check, bound source deletion, replay and forgotten-device credentials',
  );
  globalThis.fetch = oldFetch;
  if (oldData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
  else process.env.PACKAGEFLOW_DATA_DIR = oldData;
  rmSync(work, { recursive: true, force: true });
});
