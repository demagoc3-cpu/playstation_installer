import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const buildDirectory = mkdtempSync(join(tmpdir(), 'pf-service-facade-build-'));
const output = join(buildDirectory, 'api.mjs');
await build({
  stdin: {
    contents: [
      "export * from './server/utils/ps5-service-start';",
      "export * from './server/utils/console-profiles';",
      "export * from './server/utils/console-worker-lock';",
      "export * from './server/utils/ps5-bootstrap-journal';",
      "export * from './server/utils/desktop-lifecycle';",
    ].join('\n'),
    resolveDir: resolve('.'),
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  banner: {
    js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);",
  },
  plugins: [
    {
      name: 'service-start-network-fixtures',
      setup(builder) {
        builder.onResolve({ filter: /ps5-payload-manager$/ }, () => ({
          path: 'payload-manager',
          namespace: 'service-start-fixture',
        }));
        builder.onResolve({ filter: /^node:net$/ }, (args) =>
          args.importer.endsWith('/ps5-service-start.ts')
            ? { path: 'loader', namespace: 'service-start-fixture' }
            : undefined,
        );
        builder.onLoad({ filter: /.*/, namespace: 'service-start-fixture' }, (args) => ({
          loader: 'js',
          contents:
            args.path === 'loader'
              ? 'export const createConnection = options => globalThis.__pfServiceStartFixture.connect(options);'
              : `
                export const readPs5PayloadManager = ip => globalThis.__pfServiceStartFixture.manager(ip);
                export const storePs5ServicePayload = (ip, artifact, transport, guard) => globalThis.__pfServiceStartFixture.store(ip, artifact, guard);
                export const launchPs5StoredPayload = (ip, path, transport, guard) => globalThis.__pfServiceStartFixture.launch(ip, path, guard);
                export const isPs5StoredServicePayload = value =>
                  value?.filename === 'PackageFlowService-PS5.elf' &&
                  value?.slot === 'local/PackageFlowService-PS5' &&
                  value?.path === '/data/pldmgr/payloads/local/PackageFlowService-PS5/PackageFlowService-PS5.elf';
              `,
        }));
      },
    },
  ],
});
const api = await import(pathToFileURL(output).href);

async function until(condition, message) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((done) => setTimeout(done, 5));
  }
}
function savedEntry() {
  return {
    path: '/data/pldmgr/payloads/local/PackageFlowService-PS5/PackageFlowService-PS5.elf',
    slot: 'local/PackageFlowService-PS5',
    filename: 'PackageFlowService-PS5.elf',
    name: 'PackageFlowService-PS5',
    version: '0.1.30-dev',
    buildId: 'unified-fixture',
  };
}
async function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'pf-service-facade-'));
  const previousData = process.env.PACKAGEFLOW_DATA_DIR;
  const previousFetch = globalThis.fetch;
  const previousFixture = globalThis.__pfServiceStartFixture;
  process.env.PACKAGEFLOW_DATA_DIR = directory;
  const bytes = Buffer.alloc(8192);
  Buffer.from('7f454c460201', 'hex').copy(bytes);
  bytes.writeUInt16LE(62, 18);
  const release = {
    fileName: 'PackageFlowService-PS5.elf',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    version: '0.1.30-dev',
    buildId: 'unified-fixture',
    firmware: '13.60',
  };
  mkdirSync(join(directory, 'console-setup'));
  writeFileSync(join(directory, 'console-setup', release.fileName), bytes);
  writeFileSync(
    join(directory, 'console-setup', 'service-manifest.json'),
    JSON.stringify({ schemaVersion: 1, elf: release }),
  );
  const one = api.saveConsoleProfile({ name: 'First PS5', ip: '192.0.2.5', platform: 'ps5' })
    .consoles[0];
  const two = api.saveConsoleProfile({ name: 'Second PS5', ip: '192.0.2.6', platform: 'ps5' })
    .consoles[1];
  const four = api.saveConsoleProfile({ name: 'PS4', ip: '192.0.2.4', platform: 'ps4' })
    .consoles[2];
  const preserved = {
    'ps5-service-keys.json': JSON.stringify({ [one.ip]: 'e'.repeat(64), [two.ip]: 'f'.repeat(64) }),
    'ps4-service-keys.json': JSON.stringify({ [four.ip]: 'd'.repeat(32) }),
    'package-library.json': JSON.stringify({ version: 2, packages: [], deliveries: {} }),
    'library-selection.json': JSON.stringify({ packageIds: ['saved-user-selection'] }),
  };
  for (const [file, contents] of Object.entries(preserved))
    writeFileSync(join(directory, file), contents);
  const modes = new Map();
  const payloads = new Map();
  const gates = new Map();
  const actions = [];
  const connections = [];
  const managerReads = [];
  const healthReads = [];
  const beforeLaunchLists = new Map();
  const beforeStoreGuards = new Map();
  const guarded = async (guard, ...args) => {
    try {
      await guard?.(...args);
    } catch (error) {
      throw Object.assign(Error(error.message), { dispatched: false });
    }
  };
  const controller = {
    async manager(ip) {
      managerReads.push(ip);
      if (!payloads.has(ip)) throw Error('manager unavailable');
      return { payloads: structuredClone(payloads.get(ip)) };
    },
    async store(ip, artifact, guard) {
      assert.deepEqual(artifact.bytes, bytes);
      await beforeStoreGuards.get(ip)?.();
      await guarded(guard);
      actions.push({ kind: 'store', ip });
      const entry = savedEntry();
      payloads.set(ip, [entry]);
      return entry;
    },
    async launch(ip, path, guard) {
      await beforeLaunchLists.get(ip)?.();
      const freshList = await controller.manager(ip);
      const freshEntry = freshList.payloads.find(
        (value) => value.path === path || value.slot === path,
      );
      assert.ok(freshEntry, 'transport must re-read the selected payload before its launch guard');
      await guarded(guard, freshEntry);
      actions.push({ kind: 'launch', ip, path });
      const gate = gates.get(ip);
      if (gate) await gate.promise;
      modes.set(ip, 'running');
    },
    connect(options) {
      connections.push(options);
      const socket = new EventEmitter();
      let closed = false;
      socket.setTimeout = () => socket;
      socket.destroy = (error) => {
        if (closed) return socket;
        closed = true;
        if (error) socket.emit('error', error);
        socket.emit('close');
        return socket;
      };
      socket.end = (value, done) => {
        assert.deepEqual(value, bytes);
        actions.push({ kind: 'send', ip: options.host });
        modes.set(options.host, 'running');
        queueMicrotask(done);
      };
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    },
  };
  globalThis.__pfServiceStartFixture = controller;
  globalThis.fetch = async (url) => {
    const address = new URL(url);
    assert.equal(address.port, '8095');
    assert.equal(address.pathname, '/health', 'facade may only query the service health API');
    const ip = address.hostname;
    healthReads.push(ip);
    const mode = modes.get(ip) || 'refused';
    if (mode === 'refused')
      throw Object.assign(Error('refused fixture'), { cause: { code: 'ECONNREFUSED' } });
    if (mode === 'timeout') throw Object.assign(Error('health timeout'), { name: 'TimeoutError' });
    if (mode === 'malformed') return new Response('not json');
    return new Response(
      JSON.stringify({
        apiVersion: 'v1',
        pid: 93,
        firmwareRead: true,
        firmwareRaw: '0x13600007',
        serviceReport: {
          service: 'PackageFlowService-PS5',
          platform: 'ps5',
          consoleVerified: true,
          version: release.version,
          buildId: mode === 'other-build' ? 'other-build' : release.buildId,
        },
      }),
    );
  };
  const journalPath = (profile) => join(directory, 'console-setup', `bootstrap-${profile.id}.json`);
  const journal = (profile) => JSON.parse(readFileSync(journalPath(profile), 'utf8'));
  const requestPath = (profile, requestId) =>
    join(directory, 'console-setup', 'service-start', `${profile.id}-${requestId}.json`);
  const remember = (profile) => {
    payloads.set(profile.ip, [savedEntry()]);
    writeFileSync(
      join(directory, 'console-setup', `saved-service-${profile.id}.json`),
      JSON.stringify({ consoleId: profile.id, ip: profile.ip, release, entry: savedEntry() }),
    );
  };
  const hold = (profile) => {
    let releaseGate;
    const promise = new Promise((done) => (releaseGate = done));
    gates.set(profile.ip, { promise, release: releaseGate });
    return releaseGate;
  };
  const seedFlow = (profile, patch = {}) => {
    const flow = {
      id: 'a'.repeat(32),
      consoleId: profile.id,
      ip: profile.ip,
      version: release.version,
      buildId: release.buildId,
      sha256: release.sha256,
      firmware: release.firmware,
      state: 'sending',
      message: 'saved launch intent',
      startedAt: 1,
      ...patch,
    };
    writeFileSync(journalPath(profile), JSON.stringify(flow));
    return flow;
  };
  const seedQueue = (profile, patch = {}) => {
    const path = join(directory, 'consoles', profile.id, 'ps5-installation-queue.json');
    mkdirSync(join(directory, 'consoles', profile.id), { recursive: true });
    const queue = {
      version: 1,
      consoleId: profile.id,
      psIp: profile.ip,
      status: 'running',
      items: [{ state: 'installing', installDispatched: true }],
      ...patch,
    };
    writeFileSync(path, JSON.stringify(queue));
    return { path, contents: readFileSync(path, 'utf8') };
  };
  try {
    await run({
      directory,
      one,
      two,
      four,
      release,
      modes,
      payloads,
      actions,
      connections,
      managerReads,
      healthReads,
      beforeLaunchLists,
      beforeStoreGuards,
      journalPath,
      journal,
      requestPath,
      remember,
      hold,
      seedFlow,
      seedQueue,
      expectedUserFiles: preserved,
    });
    for (const [file, contents] of Object.entries(preserved))
      assert.equal(
        readFileSync(join(directory, file), 'utf8'),
        contents,
        `${file} must be preserved`,
      );
  } finally {
    for (const gate of gates.values()) gate.release();
    await until(() => api.desktopRequests() === 0, 'background service launch did not finish');
    globalThis.fetch = previousFetch;
    if (previousFixture === undefined) delete globalThis.__pfServiceStartFixture;
    else globalThis.__pfServiceStartFixture = previousFixture;
    if (previousData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = previousData;
    rmSync(directory, { recursive: true, force: true });
  }
}

test('GET checks are read-only and never open the ELF loader, including without an application image', async () => {
  await fixture(async ({ one, connections, actions, directory }) => {
    const info = await api.ps5ServiceStartInfo(one.id);
    assert.equal(info.state, 'stopped');
    assert.equal(info.canStart, true);
    assert.equal(info.artifact.fileName, 'PackageFlowService-PS5.elf');
    assert.equal(existsSync(join(directory, 'console-setup', 'manifest.json')), false);
    assert.deepEqual(connections, []);
    assert.deepEqual(actions, []);
  });
});

test('same-console retries deduplicate the saved launch and share the legacy bootstrap admission journal', async () => {
  await fixture(async ({ one, two, remember, hold, actions, journal, requestPath }) => {
    remember(one);
    const release = hold(one);
    const input = { consoleId: one.id, requestId: 'a'.repeat(32), action: 'start' };
    await api.beginPs5ServiceStart(input);
    await until(() => actions.length === 1, 'saved payload did not launch');
    const saved = journal(one);
    assert.equal(saved.state, 'sending', 'Windows admission must understand the new start intent');
    assert.equal(saved.dispatched, true);
    assert.throws(() => api.assertNoPs5Bootstrap(one.id), { statusCode: 409 });
    assert.doesNotThrow(
      () => api.assertNoPs5Bootstrap(two.id),
      'another PS5 has an independent gate',
    );
    const replay = await api.beginPs5ServiceStart(input);
    assert.equal(replay.operation.id, input.requestId);
    assert.equal(replay.operation.state, 'starting');
    await assert.rejects(
      api.beginPs5ServiceStart({ ...input, requestId: 'b'.repeat(32) }),
      /прежнего запуска/,
    );
    assert.equal(actions.length, 1);
    release();
    await until(() => api.desktopRequests() === 0, 'launch verification did not finish');
    assert.equal(journal(one).state, 'completed');
    assert.equal(
      JSON.parse(readFileSync(requestPath(one, input.requestId), 'utf8')).state,
      'completed',
    );
    assert.doesNotThrow(() => api.assertNoPs5Bootstrap(one.id));
  });
});

test('replaying an older request after a newer start cannot dispatch again or replace the latest receipt', async () => {
  await fixture(async ({ one, remember, modes, actions, journal, requestPath }) => {
    remember(one);
    const first = { consoleId: one.id, requestId: 'a'.repeat(32), action: 'start' };
    await api.beginPs5ServiceStart(first);
    await until(() => api.desktopRequests() === 0, 'first launch did not finish');
    const originalReceipt = readFileSync(requestPath(one, first.requestId), 'utf8');
    modes.set(one.ip, 'refused');
    const second = { ...first, requestId: 'b'.repeat(32) };
    await api.beginPs5ServiceStart(second);
    await until(() => api.desktopRequests() === 0, 'second launch did not finish');
    const latest = journal(one);
    assert.equal(actions.length, 2);
    await api.beginPs5ServiceStart(first);
    assert.equal(actions.length, 2, 'a historical request is not permission for a third launch');
    assert.deepEqual(journal(one), latest);
    assert.equal(readFileSync(requestPath(one, first.requestId), 'utf8'), originalReceipt);
    await assert.rejects(
      api.beginPs5ServiceStart({ ...first, action: 'install' }),
      /другой операции/,
    );
    assert.equal(actions.length, 2);
  });
});

test('an active queue on PS5 A does not block launching PS5 B or change either queue and pairing keys', async () => {
  await fixture(async ({ one, two, remember, actions, seedQueue }) => {
    const active = seedQueue(one);
    const finished = seedQueue(two, { status: 'completed', items: [{ state: 'installed' }] });
    remember(two);
    await assert.rejects(
      api.beginPs5ServiceStart({ consoleId: one.id, requestId: 'a'.repeat(32), action: 'start' }),
      /незавершённые задания/,
    );
    await api.beginPs5ServiceStart({
      consoleId: two.id,
      requestId: 'b'.repeat(32),
      action: 'start',
    });
    await until(() => api.desktopRequests() === 0, 'second PS5 launch did not finish');
    assert.deepEqual(
      actions.map((action) => action.ip),
      [two.ip],
    );
    assert.equal(readFileSync(active.path, 'utf8'), active.contents);
    assert.equal(readFileSync(finished.path, 'utf8'), finished.contents);
  });
});

test('the Windows bootstrap worker lock blocks WEB for that IP while another PS5 remains available', async () => {
  await fixture(async ({ one, two, remember, actions, journalPath }) => {
    remember(one);
    remember(two);
    const release = api.claimConsoleWorker('bootstrap', one.ip);
    assert.ok(release);
    try {
      await assert.rejects(
        api.beginPs5ServiceStart({ consoleId: one.id, requestId: 'a'.repeat(32), action: 'start' }),
        /Другой клиент уже работает/,
      );
      assert.equal(existsSync(journalPath(one)), false);
      await api.beginPs5ServiceStart({
        consoleId: two.id,
        requestId: 'b'.repeat(32),
        action: 'start',
      });
      await until(() => api.desktopRequests() === 0, 'independent PS5 launch did not finish');
      assert.deepEqual(
        actions.map((action) => action.ip),
        [two.ip],
      );
    } finally {
      release();
    }
  });
});

test('a legacy uncertain bootstrap is reconciled after restart without a second launch', async () => {
  await fixture(async ({ one, seedFlow, modes, actions, connections, journal }) => {
    const original = seedFlow(one);
    const stopped = await api.ps5ServiceStartInfo(one.id);
    assert.equal(stopped.state, 'stopped');
    assert.equal(stopped.operation.state, 'starting');
    assert.equal(stopped.canStart, false);
    await api.beginPs5ServiceStart({ consoleId: one.id, requestId: original.id, action: 'start' });
    await assert.rejects(
      api.beginPs5ServiceStart({ consoleId: one.id, requestId: 'b'.repeat(32), action: 'start' }),
      /прежнего запуска/,
    );
    assert.deepEqual(actions, []);
    assert.deepEqual(connections, []);
    modes.set(one.ip, 'running');
    const reconciled = await api.ps5ServiceStartInfo(one.id);
    assert.equal(reconciled.operation.state, 'completed');
    assert.equal(journal(one).state, 'completed');
    assert.doesNotThrow(() => api.assertNoPs5Bootstrap(one.id));
    assert.deepEqual(actions, []);
  });
});

test('an uncertain launch remains bound to its IP after a profile is deleted and recreated', async () => {
  for (const journalKind of ['legacy', 'per-IP']) {
    await fixture(
      async ({
        one,
        two,
        directory,
        seedFlow,
        journalPath,
        expectedUserFiles,
        actions,
        connections,
      }) => {
        const original = seedFlow(one, {
          state: 'unconfirmed',
          dispatched: true,
          action: 'start',
        });
        if (journalKind === 'per-IP') {
          const ipDirectory = join(directory, 'consoles', one.ip);
          mkdirSync(ipDirectory, { recursive: true });
          writeFileSync(join(ipDirectory, 'service-start.json'), JSON.stringify(original));
          rmSync(journalPath(one));
        }
        api.removeConsoleProfile(one.id);
        const keysPath = join(directory, 'ps5-service-keys.json');
        const keysAfterRemoval = readFileSync(keysPath, 'utf8');
        assert.equal(
          JSON.parse(keysAfterRemoval)[one.ip],
          undefined,
          'profile deletion removes its own key',
        );
        assert.equal(
          JSON.parse(keysAfterRemoval)[two.ip],
          'f'.repeat(64),
          'other console key is retained',
        );
        expectedUserFiles['ps5-service-keys.json'] = keysAfterRemoval;
        const recreated = api
          .saveConsoleProfile({ name: 'Recreated PS5', ip: one.ip, platform: 'ps5' })
          .consoles.find((profile) => profile.ip === one.ip);
        assert.notEqual(recreated.id, one.id);
        const info = await api.ps5ServiceStartInfo(recreated.id);
        assert.equal(info.consoleId, recreated.id);
        assert.equal(
          info.canStart,
          false,
          `${journalKind} uncertain launch cannot be bypassed with a new profile ID`,
        );
        assert.equal(info.canInstall, false);
        assert.equal(
          info.operation.consoleId,
          one.id,
          'the original operation keeps its captured identity',
        );
        assert.equal(info.operation.state, 'unconfirmed');
        assert.throws(() => api.assertNoPs5Bootstrap(recreated.id, one.ip), { statusCode: 409 });
        assert.doesNotThrow(() => api.assertNoPs5Bootstrap(two.id, two.ip));
        await assert.rejects(
          api.beginPs5ServiceStart({
            consoleId: recreated.id,
            requestId: 'b'.repeat(32),
            action: 'start',
          }),
          { statusCode: 409 },
        );
        assert.equal(
          (await api.ps5ServiceStartInfo(two.id)).canStart,
          true,
          'another IP stays independent',
        );
        assert.deepEqual(actions, []);
        assert.deepEqual(connections, []);
        assert.equal(readFileSync(keysPath, 'utf8'), keysAfterRemoval);
      },
    );
  }
});

test('corrupt per-IP journals block only the matching console and never authorize a new send', async () => {
  await fixture(async ({ one, two, directory, seedFlow, actions, connections }) => {
    const original = seedFlow(one, { state: 'unconfirmed', dispatched: true, action: 'start' });
    const ipDirectory = join(directory, 'consoles', one.ip);
    mkdirSync(ipDirectory, { recursive: true });
    const ipPath = join(ipDirectory, 'service-start.json');
    for (const contents of [
      '{broken',
      JSON.stringify({ ...original, ip: two.ip }),
      JSON.stringify({ ...original, state: 'unknown-future-state' }),
    ]) {
      writeFileSync(ipPath, contents);
      await assert.rejects(api.ps5ServiceStartInfo(one.id), { statusCode: 503 });
      await assert.rejects(
        api.beginPs5ServiceStart({ consoleId: one.id, requestId: 'b'.repeat(32), action: 'start' }),
        { statusCode: 503 },
      );
      assert.throws(() => api.assertNoPs5Bootstrap(one.id, one.ip), { statusCode: 409 });
      assert.equal((await api.ps5ServiceStartInfo(two.id)).canStart, true);
      assert.doesNotThrow(() => api.assertNoPs5Bootstrap(two.id, two.ip));
      assert.equal(readFileSync(ipPath, 'utf8'), contents);
    }
    assert.deepEqual(actions, []);
    assert.deepEqual(connections, []);
  });
});

test('an unrelated malformed legacy bootstrap never blocks a different IP globally', async () => {
  await fixture(async ({ one, two, journalPath, actions, connections }) => {
    for (const contents of [
      '{broken',
      JSON.stringify({ consoleId: two.id, ip: two.ip, state: 'unknown-future-state' }),
    ]) {
      writeFileSync(journalPath(two), contents);
      assert.equal((await api.ps5ServiceStartInfo(one.id)).canStart, true);
      assert.doesNotThrow(() => api.assertNoPs5Bootstrap(one.id, one.ip));
      assert.equal(readFileSync(journalPath(two), 'utf8'), contents);
    }
    assert.deepEqual(actions, []);
    assert.deepEqual(connections, []);
  });
});

test('an abandoned unsent intent can be closed locally only after acquiring the shared worker lock', async () => {
  await fixture(async ({ one, seedFlow, journal, actions, connections }) => {
    seedFlow(one, { state: 'checking', dispatched: false, action: 'start' });
    const release = api.claimConsoleWorker('bootstrap', one.ip);
    assert.ok(release);
    try {
      const locked = await api.ps5ServiceStartInfo(one.id);
      assert.equal(
        locked.operation.state,
        'checking',
        'a live owner may still be preparing dispatch',
      );
      assert.equal(locked.canStart, false);
      assert.equal(journal(one).state, 'checking');
    } finally {
      release();
    }
    const abandoned = await api.ps5ServiceStartInfo(one.id);
    assert.equal(abandoned.operation.state, 'failed');
    assert.equal(abandoned.canStart, true);
    assert.equal(journal(one).dispatched, false);
    assert.deepEqual(actions, []);
    assert.deepEqual(connections, []);
  });
});

test('a zero-byte authorized waiting queue is preserved when its missing service is started', async () => {
  await fixture(async ({ one, remember, seedQueue, actions }) => {
    remember(one);
    const queue = seedQueue(one, {
      status: 'running',
      items: [
        { state: 'waiting', bytesSent: 0 },
        { state: 'pending', bytesSent: 0 },
      ],
    });
    await api.beginPs5ServiceStart({
      consoleId: one.id,
      requestId: 'a'.repeat(32),
      action: 'start',
    });
    await until(() => api.desktopRequests() === 0, 'waiting queue service launch did not finish');
    assert.equal(actions.length, 1);
    assert.equal(actions[0].kind, 'launch');
    assert.equal(
      readFileSync(queue.path, 'utf8'),
      queue.contents,
      'start must not replace or reset the queue',
    );
  });
});

test('a queue with completed items and a zero-byte waiting item can start its service without losing history', async () => {
  await fixture(async ({ one, remember, seedQueue, actions }) => {
    remember(one);
    const queue = seedQueue(one, {
      status: 'running',
      items: [
        {
          state: 'installed',
          bytesSent: 8192,
          installDispatched: true,
          confirmation: 'service-registration',
          confirmedAt: 1,
        },
        { state: 'waiting', bytesSent: 0 },
      ],
    });
    await api.beginPs5ServiceStart({
      consoleId: one.id,
      requestId: 'a'.repeat(32),
      action: 'start',
    });
    await until(
      () => api.desktopRequests() === 0,
      'mixed completed/waiting queue launch did not finish',
    );
    assert.deepEqual(
      actions.map((action) => action.kind),
      ['launch'],
    );
    assert.equal(
      readFileSync(queue.path, 'utf8'),
      queue.contents,
      'completed receipts and pending work stay intact',
    );
  });
});

test('metadata changed in the final PLDMGR list blocks launch and preserves the saved ownership receipt', async () => {
  for (const field of ['version', 'buildId']) {
    await fixture(
      async ({
        one,
        remember,
        payloads,
        beforeLaunchLists,
        actions,
        connections,
        journal,
        directory,
      }) => {
        remember(one);
        const receiptPath = join(directory, 'console-setup', `saved-service-${one.id}.json`);
        const original = readFileSync(receiptPath, 'utf8');
        beforeLaunchLists.set(one.ip, async () => {
          await new Promise((done) => setImmediate(done));
          payloads.set(one.ip, [{ ...savedEntry(), [field]: 'changed-after-preflight' }]);
        });
        await api.beginPs5ServiceStart({
          consoleId: one.id,
          requestId: 'a'.repeat(32),
          action: 'start',
        });
        await until(
          () => api.desktopRequests() === 0,
          'changed saved metadata did not stop launch',
        );
        assert.equal(journal(one).state, 'failed');
        assert.equal(journal(one).dispatched, false);
        assert.equal(readFileSync(receiptPath, 'utf8'), original);
        assert.deepEqual(actions, []);
        assert.deepEqual(connections, []);
      },
    );
  }
});

test('a service appearing while the final PLDMGR list is read prevents the launch POST', async () => {
  await fixture(
    async ({
      one,
      remember,
      modes,
      beforeLaunchLists,
      actions,
      connections,
      journal,
      directory,
    }) => {
      remember(one);
      const receiptPath = join(directory, 'console-setup', `saved-service-${one.id}.json`);
      const original = readFileSync(receiptPath, 'utf8');
      beforeLaunchLists.set(one.ip, async () => {
        await new Promise((done) => setImmediate(done));
        modes.set(one.ip, 'running');
      });
      await api.beginPs5ServiceStart({
        consoleId: one.id,
        requestId: 'a'.repeat(32),
        action: 'start',
      });
      await until(
        () => api.desktopRequests() === 0,
        'newly running service was not observed by the guard',
      );
      assert.equal(journal(one).state, 'failed');
      assert.equal(journal(one).dispatched, false);
      assert.equal((await api.ps5ServiceStartInfo(one.id)).state, 'running');
      assert.equal(readFileSync(receiptPath, 'utf8'), original);
      assert.deepEqual(actions, []);
      assert.deepEqual(connections, []);
    },
  );
});

test('a service appearing at the final upload guard prevents payload storage and leaves existing data alone', async () => {
  await fixture(
    async ({
      one,
      payloads,
      modes,
      beforeStoreGuards,
      actions,
      connections,
      journal,
      directory,
    }) => {
      payloads.set(one.ip, []);
      beforeStoreGuards.set(one.ip, async () => {
        await new Promise((done) => setImmediate(done));
        modes.set(one.ip, 'running');
      });
      await api.beginPs5ServiceStart({
        consoleId: one.id,
        requestId: 'a'.repeat(32),
        action: 'install',
      });
      await until(
        () => api.desktopRequests() === 0,
        'newly running service was not observed before upload',
      );
      assert.equal(journal(one).state, 'failed');
      assert.equal(journal(one).dispatched, false);
      assert.equal(
        existsSync(join(directory, 'console-setup', `saved-service-${one.id}.json`)),
        false,
      );
      assert.deepEqual(payloads.get(one.ip), []);
      assert.deepEqual(actions, []);
      assert.deepEqual(connections, []);
    },
  );
});

test('corrupt or unknown durable journals fail closed without rewriting the saved bytes', async () => {
  await fixture(async ({ one, journalPath, actions, connections }) => {
    for (const contents of [
      '{broken',
      JSON.stringify({ consoleId: one.id, state: 'new-unknown-state' }),
    ]) {
      writeFileSync(journalPath(one), contents);
      await assert.rejects(api.ps5ServiceStartInfo(one.id), /журнал|Журнал/);
      await assert.rejects(
        api.beginPs5ServiceStart({ consoleId: one.id, requestId: 'a'.repeat(32), action: 'start' }),
        /журнал|Журнал/,
      );
      assert.equal(readFileSync(journalPath(one), 'utf8'), contents);
    }
    assert.deepEqual(actions, []);
    assert.deepEqual(connections, []);
  });
});

test('timeouts and malformed health are uncertainty; only a refused listener is stopped', async () => {
  await fixture(async ({ one, modes, actions, connections, journal }) => {
    for (const mode of ['timeout', 'malformed']) {
      modes.set(one.ip, mode);
      const info = await api.ps5ServiceStartInfo(one.id);
      assert.equal(info.state, 'unknown');
      assert.equal(info.canStart, false);
      assert.equal(info.canInstall, false);
      await api.beginPs5ServiceStart({
        consoleId: one.id,
        requestId: (mode === 'timeout' ? 'a' : 'b').repeat(32),
        action: 'start',
      });
      await until(() => api.desktopRequests() === 0, 'uncertain preflight did not terminate');
      assert.equal(journal(one).state, 'failed');
      assert.equal(journal(one).dispatched, false);
    }
    modes.set(one.ip, 'refused');
    const refused = await api.ps5ServiceStartInfo(one.id);
    assert.equal(refused.state, 'stopped');
    assert.equal(refused.canStart, true);
    assert.deepEqual(actions, []);
    assert.deepEqual(connections, []);
  });
});

test('public service state omits saved paths and credentials while retaining the correct console identity', async () => {
  await fixture(async ({ one, remember, modes, actions, connections, directory }) => {
    remember(one);
    modes.set(one.ip, 'running');
    const info = await api.ps5ServiceStartInfo(one.id);
    assert.equal(info.state, 'running');
    assert.equal(info.savedPayloadKnown, true);
    const started = await api.beginPs5ServiceStart({
      consoleId: one.id,
      requestId: 'a'.repeat(32),
      action: 'start',
    });
    await until(() => api.desktopRequests() === 0, 'running service check did not finish');
    const reconciled = await api.ps5ServiceStartInfo(one.id);
    for (const value of [info, started, reconciled]) {
      assert.equal(value.consoleId, one.id);
      const text = JSON.stringify(value);
      for (const secret of [
        directory,
        savedEntry().path,
        'e'.repeat(64),
        'f'.repeat(64),
        'd'.repeat(32),
      ])
        assert.equal(text.includes(secret), false, 'public reply exposed a local path or key');
    }
    assert.deepEqual(actions, []);
    assert.deepEqual(connections, []);
  });
});

test('a stopped observation of a dispatched system job does not authorize restarting its serving process', async () => {
  await fixture(async ({ one, seedQueue, actions, connections }) => {
    const queue = seedQueue(one, {
      status: 'failed',
      items: [{ state: 'failed', installDispatched: true, observationStoppedAt: 1 }],
    });
    await assert.rejects(
      api.beginPs5ServiceStart({ consoleId: one.id, requestId: 'a'.repeat(32), action: 'start' }),
      /незавершённые задания|системн/,
    );
    assert.equal(readFileSync(queue.path, 'utf8'), queue.contents);
    assert.deepEqual(actions, []);
    assert.deepEqual(connections, []);
  });
});

test.after(() => rmSync(buildDirectory, { recursive: true, force: true }));
