import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createError } from 'h3';
import { putPs5ParamPkg } from './ps5-param-pkg.mjs';

const [bundle, work, scenario] = process.argv.slice(2);
const data = join(work, scenario);
mkdirSync(data);
process.env.PACKAGEFLOW_DATA_DIR = data;
globalThis.createError = createError;
const response = (body) => new Response(JSON.stringify(body));
const until = async (check) => {
  const deadline = Date.now() + 4000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'production preflight or transfer was not reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

async function run() {
  const api = await import(pathToFileURL(bundle).href);
  const add = (name, ip) =>
    api.saveConsoleProfile({ name, ip, platform: 'ps5' }).consoles.find((p) => p.ip === ip);
  const blocked = add('PS5 with pending service launch', '192.168.60.5');
  const other = add('Independent PS5', '192.168.60.6');
  const keys = { [blocked.ip]: 'a'.repeat(64), [other.ip]: 'b'.repeat(64) };
  writeFileSync(join(data, 'ps5-service-keys.json'), JSON.stringify(keys));
  const path = join(work, `${scenario}.pkg`);
  const bytes = putPs5ParamPkg(Buffer.alloc(8192, 39));
  writeFileSync(path, bytes);
  const pkg = {
    id: 'native',
    title: 'Accepted metadata fixture',
    titleId: 'PPSA95001',
    contentId: 'IV0000-PPSA95001_00-PACKAGEFLOWUI001',
    appVersion: '01.000.001',
    platform: 'ps5',
    format: 'pkg',
    contentType: 'PS5GD',
    type: 'Игра',
    installOrder: 0,
    size: bytes.length,
    path,
    fileName: 'native.pkg',
    libraryRoot: work,
    sourceModifiedAt: 1,
    iconSize: 0,
    icon: { offset: 0, size: 0 },
    packageDigest: '',
  };
  writeFileSync(
    join(data, 'package-library.json'),
    JSON.stringify({ version: 2, packages: [pkg], deliveries: {} }),
  );
  let probeEntered = false,
    releaseProbe;
  const gate = new Promise((resolve) => {
    releaseProbe = resolve;
  });
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const address = new URL(url),
      ip = address.hostname,
      path = address.pathname;
    assert.ok([blocked.ip, other.ip].includes(ip));
    assert.equal(address.port, '8095');
    calls.push({ ip, path, method: options.method || 'GET' });
    if (path === '/health') {
      if (ip === blocked.ip) {
        probeEntered = true;
        await gate;
      }
      return response({
        apiVersion: 'v1',
        pid: ip === blocked.ip ? 91 : 92,
        firmwareRead: true,
        firmwareRaw: '0x13600007',
        serviceReport: {
          service: 'PackageFlowService-PS5',
          platform: 'ps5',
          consoleVerified: true,
          version: '0.1.30-dev',
          buildId: 'unified-test',
        },
      });
    }
    assert.equal(options.headers.Authorization, `Bearer ${keys[ip]}`);
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
      return response({ revision: 'c'.repeat(64), entries: [], next: 0, done: true });
    if (path === '/api/v1/transfers/begin') {
      assert.equal(ip, other.ip, 'the blocked device must never reach a transfer mutation');
      assert.match(options.headers['X-PackageFlow-Blake3'], /^[a-f0-9]{64}$/);
      assert.equal(Number(options.headers['X-PackageFlow-Size']), pkg.size);
      // Keep the real other-device worker in flight until this isolated process
      // ends. No real HTTP is ever restored while it is pending.
      return new Promise(() => {});
    }
    assert.fail(`Unexpected request: ${ip} ${path}`);
  };
  const pending = api.startPs5Queue({ consoleId: blocked.id, packageIds: [pkg.id] });
  await until(() => probeEntered);
  assert.equal(api.getPs5Queue(blocked.id).items.length, 0);
  if (scenario.startsWith('bootstrap')) {
    const directory = join(data, 'console-setup');
    mkdirSync(directory);
    writeFileSync(
      join(directory, `bootstrap-${blocked.id}.json`),
      JSON.stringify({
        consoleId: blocked.id,
        state: scenario === 'bootstrap-sending' ? 'sending' : 'unconfirmed',
      }),
    );
  } else {
    const directory = join(data, 'ps5-service-updates');
    mkdirSync(directory);
    writeFileSync(
      join(directory, `${blocked.id}.json`),
      JSON.stringify({
        consoleId: blocked.id,
        id: 'd'.repeat(32),
        ip: blocked.ip,
        sha256: 'e'.repeat(64),
        version: '0.1.30-dev',
        buildId: 'unified-test',
        startedAt: Date.now(),
        state: 'sending',
      }),
    );
  }
  const rejection = assert.rejects(pending, (error) => {
    assert.equal(error.statusCode, 409);
    assert.match(
      error.message,
      scenario.startsWith('bootstrap')
        ? /Запуск ELF пока не подтверждён/
        : /Обновление службы PS5 ещё не подтверждено/,
    );
    return true;
  });
  const otherQueue = await api.startPs5Queue({ consoleId: other.id, packageIds: [pkg.id] });
  assert.equal(otherQueue.items.length, 1);
  await until(() =>
    calls.some((call) => call.ip === other.ip && call.path === '/api/v1/transfers/begin'),
  );
  releaseProbe();
  await rejection;
  const blockedQueue = api.getPs5Queue(blocked.id);
  assert.equal(blockedQueue.status, 'idle');
  const blockedMutations = calls.filter(
    (call) => call.ip === blocked.ip && call.method === 'POST',
  ).length;
  assert.equal(blockedMutations, 0);
  const blockedQueueFileExists = existsSync(
    join(data, 'consoles', blocked.id, 'ps5-installation-queue.json'),
  );
  assert.equal(blockedQueueFileExists, false);
  return {
    blockedStatusCode: 409,
    blockedQueueItems: blockedQueue.items.length,
    blockedQueueFileExists,
    blockedMutations,
    otherQueueItems: api.getPs5Queue(other.id).items.length,
    otherTransferBegins: calls.filter(
      (call) => call.ip === other.ip && call.path === '/api/v1/transfers/begin',
    ).length,
  };
}
try {
  process.stdout.write(`${JSON.stringify(await run())}\n`);
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
