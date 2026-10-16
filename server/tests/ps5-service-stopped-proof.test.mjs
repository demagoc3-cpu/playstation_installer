import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const work = mkdtempSync(join(tmpdir(), 'pf-stopped-proof-'));
const inventory = JSON.parse(
  readFileSync('server/tests/fixtures/ps5-stopped-processes-1360.json', 'utf8'),
);
const output = join(work, 'api.mjs');
await build({
  stdin: {
    contents:
      "export * from './server/utils/ps5-service-start';export * from './server/utils/console-profiles';export * from './server/utils/desktop-lifecycle';export * from './server/utils/ps5-service-process-proof';",
    resolveDir: resolve('.'),
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  banner: {
    js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);",
  },
  plugins: [
    {
      name: 'mock-wire-and-verified-artifact-only',
      setup(builder) {
        builder.onResolve({ filter: /ps5-service-artifact$/ }, () => ({
          path: 'artifact',
          namespace: 'stopped-wire',
        }));
        builder.onResolve({ filter: /ps5-payload-manager$/ }, () => ({
          path: 'manager',
          namespace: 'stopped-wire',
        }));
        builder.onResolve({ filter: /^node:net$/ }, (args) =>
          args.importer.endsWith('/ps5-service-start.ts')
            ? { path: 'loader', namespace: 'stopped-wire' }
            : undefined,
        );
        builder.onLoad({ filter: /.*/, namespace: 'stopped-wire' }, (args) => ({
          loader: 'js',
          resolveDir: resolve('server/utils'),
          contents:
            args.path === 'artifact'
              ? `export const PS5_SERVICE_ELF_FILE_NAME='PackageFlowService-PS5.elf';export const readPs5ServiceArtifact=()=>globalThis.__stopped.artifact();`
              : args.path === 'loader'
                ? `export const createConnection=()=>{globalThis.__stopped.loader++;throw Error('No loader fallback permitted');};`
                : `import {checkedPs5StoppedProcesses} from './ps5-service-process-proof';
         export const readPs5PayloadManager=ip=>globalThis.__stopped.manager(ip);
         export const readPs5PayloadManagerProcesses=async ip=>checkedPs5StoppedProcesses(await globalThis.__stopped.processes(ip));
         export const isPs5StoredServicePayload=e=>e?.filename==='PackageFlowService-PS5.elf'&&e.slot==='local/packageflowservice'&&e.path==='/data/pldmgr/payloads/local/packageflowservice/PackageFlowService-PS5.elf';
         export const storePs5ServicePayload=()=>{globalThis.__stopped.stores++;throw Error('Do not store');};
         export const launchPs5StoredPayload=async(ip,path,transport,guard)=>{await globalThis.__stopped.beforeLaunch?.(ip);try{await guard(globalThis.__stopped.entry);}catch(e){throw Object.assign(Error(e.message),{dispatched:false});}await globalThis.__stopped.launch(ip,path);};`,
        }));
      },
    },
  ],
});
const api = await import(pathToFileURL(output).href);
const release = {
  fileName: 'PackageFlowService-PS5.elf',
  size: 4131968,
  sha256: '6cfe3a4898e4bbba7d3b7599b8baf2e8654d6e4c4ea3e3374742578bf01b735a',
  version: '0.1.29-dev',
  buildId: 'ps5-service-embedded-pkg-029-sse2',
  firmware: '13.60',
};
const entry = {
  filename: release.fileName,
  path: `/data/pldmgr/payloads/local/packageflowservice/${release.fileName}`,
  slot: 'local/packageflowservice',
  name: 'PackageFlowService-PS5',
  version: release.version,
  buildId: release.buildId,
};
const until = async (check) => {
  const end = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < end, 'launch did not settle');
    await new Promise((done) => setTimeout(done, 5));
  }
};

async function fixture(t) {
  const directory = mkdtempSync(join(work, 'data-'));
  const previous = {
    data: process.env.PACKAGEFLOW_DATA_DIR,
    fetch: globalThis.fetch,
    fixture: globalThis.__stopped,
  };
  process.env.PACKAGEFLOW_DATA_DIR = directory;
  const profiles = ['192.0.2.5', '192.0.2.6'].map((ip) =>
    api.saveConsoleProfile({ name: ip, ip, platform: 'ps5' }).consoles.find((p) => p.ip === ip),
  );
  const stored = JSON.parse(readFileSync(join(directory, 'console-profiles.json'), 'utf8'));
  for (const profile of stored.consoles)
    Object.assign(profile, { verified: true, firmware: '13.60' });
  writeFileSync(join(directory, 'console-profiles.json'), JSON.stringify(stored));
  const keys = JSON.stringify(
    Object.fromEntries(profiles.map((p, i) => [p.ip, String(i + 1).repeat(64)])),
  );
  writeFileSync(join(directory, 'ps5-service-keys.json'), keys);
  mkdirSync(join(directory, 'console-setup'));
  writeFileSync(
    join(directory, 'console-setup', 'service-manifest.json'),
    JSON.stringify({ schemaVersion: 1, elf: release }),
  );
  for (const p of profiles)
    writeFileSync(
      join(directory, 'console-setup', `saved-service-${p.id}.json`),
      JSON.stringify({ consoleId: p.id, ip: p.ip, release, entry }),
    );
  const modes = new Map();
  const actions = [];
  const state = {
    entry: structuredClone(entry),
    inventory: structuredClone(inventory),
    managerReads: 0,
    processReads: 0,
    loader: 0,
    stores: 0,
    async artifact() {
      return { manifest: structuredClone(release), bytes: Buffer.alloc(8192) };
    },
    async manager() {
      state.managerReads++;
      return { version: '0.6.1', payloads: [structuredClone(state.entry)] };
    },
    async processes() {
      state.processReads++;
      return state.inventory;
    },
    async launch(ip, path) {
      actions.push({ ip, path });
      modes.set(ip, 'running');
    },
  };
  globalThis.__stopped = state;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    assert.ok(profiles.some((p) => p.ip === u.hostname));
    assert.equal(u.port, '8095');
    assert.equal(u.pathname, '/health');
    const mode = modes.get(u.hostname) || 'timeout';
    if (mode === 'timeout')
      throw Object.assign(Error('no health listener response'), { name: 'TimeoutError' });
    if (mode === 'malformed') return new Response('invalid JSON');
    if (mode === 'partial-body')
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
            queueMicrotask(() =>
              controller.error(
                Object.assign(Error('body read timed out'), { name: 'TimeoutError' }),
              ),
            );
          },
        }),
      );
    if (mode === 'http-error') return new Response('{}', { status: 503 });
    if (mode === 'unreachable')
      throw Object.assign(Error('unreachable'), { cause: { code: 'EHOSTUNREACH' } });
    return new Response(
      JSON.stringify({
        apiVersion: 'v1',
        pid: 95,
        firmwareRead: true,
        firmwareRaw: '0x13600007',
        serviceReport: {
          ...release,
          service: 'PackageFlowService-PS5',
          platform: 'ps5',
          consoleVerified: true,
        },
      }),
    );
  };
  t.after(async () => {
    await until(() => api.desktopRequests() === 0);
    globalThis.fetch = previous.fetch;
    globalThis.__stopped = previous.fixture;
    if (previous.data === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = previous.data;
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, profiles, state, modes, actions, keys };
}

test('the actual full 13.60 process snapshot proves absence while malformed, partial, ambiguous and possible services fail closed', () => {
  assert.equal(api.checkedPs5StoppedProcesses(inventory).length, inventory.processes.length);
  const possible = (name) => ({ pid: 98, name, memory: 1, is_daemon: true });
  for (const changed of [
    {},
    { processes: [] },
    { processes: inventory.processes.slice(0, 10) },
    { ...inventory, complete: false },
    { processes: [...inventory.processes, possible('PackageFlow.elf')] },
    { processes: [...inventory.processes, possible('PackageFlowService')] },
    { processes: [...inventory.processes, possible('payload.elf')] },
    { processes: [...inventory.processes, possible('other.elf')] },
    { processes: [...inventory.processes, possible('ftpsrv.elf')] },
    { processes: inventory.processes.map((p, i) => (i === 0 ? { ...p, pid: 85 } : p)) },
    { processes: inventory.processes.map((p, i) => (i === 0 ? { ...p, is_daemon: 'true' } : p)) },
    { processes: inventory.processes.map((p, i) => (i === 0 ? { ...p, memory: -1 } : p)) },
  ])
    assert.throws(() => api.checkedPs5StoppedProcesses(changed), /полный список/);
});

test('GET uses the known saved 029 plus process proof but never launches; explicit start dispatches once', async (t) => {
  const f = await fixture(t),
    [p] = f.profiles;
  const info = await api.ps5ServiceStartInfo(p.id);
  assert.equal(info.state, 'stopped');
  assert.equal(info.canStart, true);
  assert.equal(f.actions.length, 0);
  assert.ok(f.state.processReads >= 2);
  const input = { consoleId: p.id, requestId: 'a'.repeat(32), action: 'start' };
  await api.beginPs5ServiceStart(input);
  await until(() => api.desktopRequests() === 0);
  assert.equal(f.actions.length, 1);
  assert.equal(f.state.loader, 0);
  assert.equal((await api.ps5ServiceStartInfo(p.id)).state, 'running');
  await api.beginPs5ServiceStart(input);
  assert.equal(f.actions.length, 1);
  assert.equal(readFileSync(join(f.directory, 'ps5-service-keys.json'), 'utf8'), f.keys);
});

test('timeout without receipt/artifact/process proof, malformed health and received HTTP never authorize a launch', async (t) => {
  for (const scenario of [
    'missing-receipt',
    'missing-artifact',
    'partial-processes',
    'possible-process',
    'malformed',
    'http-error',
    'unreachable',
    'partial-body',
  ])
    await t.test(scenario, async (t) => {
      const f = await fixture(t),
        [p] = f.profiles;
      if (scenario === 'missing-receipt')
        rmSync(join(f.directory, 'console-setup', `saved-service-${p.id}.json`));
      if (scenario === 'missing-artifact')
        f.state.artifact = async () => {
          throw Error('missing');
        };
      if (scenario === 'partial-processes') f.state.inventory = { processes: [] };
      if (scenario === 'possible-process')
        f.state.inventory.processes.push({
          pid: 98,
          name: 'payload.elf',
          memory: 1,
          is_daemon: true,
        });
      if (['malformed', 'http-error', 'unreachable', 'partial-body'].includes(scenario))
        f.modes.set(p.ip, scenario);
      const info = await api.ps5ServiceStartInfo(p.id);
      assert.equal(info.canStart, false);
      try {
        await api.beginPs5ServiceStart({
          consoleId: p.id,
          requestId: 'b'.repeat(32),
          action: 'start',
        });
      } catch {
        /* Missing artifact is rejected before the worker. */
      }
      await until(() => api.desktopRequests() === 0);
      assert.equal(f.actions.length, 0);
      assert.equal(f.state.loader, 0);
      if (['malformed', 'http-error', 'unreachable', 'partial-body'].includes(scenario))
        assert.equal(
          f.state.processReads,
          0,
          'a received or interrupted response never becomes a stopped-service proof',
        );
    });
});

test('a process appearing during the awaited metadata recheck is caught by the final fresh inventory', async (t) => {
  const f = await fixture(t),
    [p] = f.profiles;
  f.state.manager = async () => {
    f.state.managerReads++;
    if (f.state.managerReads === 2)
      f.state.inventory.processes.push({
        pid: 98,
        name: 'payload.elf',
        memory: 1,
        is_daemon: true,
      });
    return { version: '0.6.1', payloads: [structuredClone(f.state.entry)] };
  };
  const info = await api.ps5ServiceStartInfo(p.id);
  assert.equal(info.state, 'unknown');
  assert.equal(info.canStart, false);
  assert.equal(f.actions.length, 0);
  assert.equal(f.state.processReads, 2);
});

test('a possible process or changed saved metadata at the final launch guard prevents the POST', async (t) => {
  for (const changed of ['process', 'metadata'])
    await t.test(changed, async (t) => {
      const f = await fixture(t),
        [p] = f.profiles;
      f.state.beforeLaunch = async () => {
        if (changed === 'process')
          f.state.inventory.processes.push({
            pid: 98,
            name: 'PackageFlow.elf',
            memory: 1,
            is_daemon: true,
          });
        else f.state.entry.version = 'changed';
      };
      await api.beginPs5ServiceStart({
        consoleId: p.id,
        requestId: 'c'.repeat(32),
        action: 'start',
      });
      await until(() => api.desktopRequests() === 0);
      assert.equal(f.actions.length, 0);
      assert.equal(f.state.loader, 0);
    });
});

test('a stale manager snapshot after process proof cannot switch to loader or registration', async (t) => {
  for (const scenario of ['unavailable', 'empty'])
    await t.test(scenario, async (t) => {
      const f = await fixture(t),
        [p] = f.profiles;
      f.state.manager = async () => {
        f.state.managerReads++;
        // The first proof succeeds. Only the driver's intermediate route snapshot changes.
        if (f.state.managerReads === 3) {
          if (scenario === 'unavailable') throw Error('transient manager list failure');
          return { version: '0.6.1', payloads: [] };
        }
        return { version: '0.6.1', payloads: [structuredClone(f.state.entry)] };
      };
      await api.beginPs5ServiceStart({
        consoleId: p.id,
        requestId: 'f'.repeat(32),
        action: scenario === 'empty' ? 'install' : 'start',
      });
      await until(() => api.desktopRequests() === 0);
      assert.ok(f.state.managerReads >= 5, 'the later process proof succeeds after recovery');
      assert.ok(f.state.processReads >= 4);
      assert.equal(f.state.loader, 0, 'no loader connection after a PM-only absence proof');
      assert.equal(f.state.stores, 0, 'no registration after a saved-service-only proof');
      assert.equal(f.actions.length, 0);
      const journal = JSON.parse(
        readFileSync(join(f.directory, 'console-setup', `bootstrap-${p.id}.json`), 'utf8'),
      );
      assert.equal(journal.state, 'failed');
      assert.equal(journal.dispatched, false);
    });
});

test('status does not offer another route when its manager snapshot fails after process proof', async (t) => {
  const f = await fixture(t),
    [p] = f.profiles;
  f.state.manager = async () => {
    f.state.managerReads++;
    if (f.state.managerReads === 3) throw Error('transient manager list failure');
    return { version: '0.6.1', payloads: [structuredClone(f.state.entry)] };
  };
  const info = await api.ps5ServiceStartInfo(p.id);
  assert.equal(info.state, 'stopped');
  assert.equal(info.managerAvailable, false);
  assert.equal(info.canStart, false);
  assert.equal(info.canInstall, false);
  assert.equal(f.state.loader, 0);
  assert.equal(f.state.stores, 0);
  assert.equal(f.actions.length, 0);
});

test('a blocked process proof on one PS5 does not block the other PS5', async (t) => {
  const f = await fixture(t),
    [a, b] = f.profiles;
  f.state.processes = async (ip) => (ip === a.ip ? { processes: [] } : inventory);
  await Promise.all([
    api.beginPs5ServiceStart({ consoleId: a.id, requestId: 'd'.repeat(32), action: 'start' }),
    api.beginPs5ServiceStart({ consoleId: b.id, requestId: 'e'.repeat(32), action: 'start' }),
  ]);
  await until(() => api.desktopRequests() === 0);
  assert.deepEqual(
    f.actions.map((a) => a.ip),
    [b.ip],
  );
});
test.after(() => rmSync(work, { recursive: true, force: true }));
