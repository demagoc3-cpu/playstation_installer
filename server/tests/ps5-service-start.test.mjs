import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const work = await mkdtemp(join(tmpdir(), 'pf-service-start-'));
const bundle = join(work, 'driver.mjs');
await build({
  entryPoints: ['server/utils/ps5-service-start-driver.ts'],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});
const { runPs5ServiceLaunch, ps5ServiceLaunchReceipt } = await import(pathToFileURL(bundle).href);

const entry = { path: '/data/payloads/PackageFlowService-PS5.elf', slot: '7' };
function record(id = 'a') {
  return {
    id: id.repeat(32),
    consoleId: `fixture-${id}`,
    ip: id === 'a' ? '192.0.2.5' : '192.0.2.6',
    version: '0.1.30-dev',
    buildId: 'unified-fixture',
    sha256: 'c'.repeat(64),
    firmware: '13.60',
    action: 'start',
    startedAt: 1,
    state: 'checking',
    message: '',
    dispatched: false,
  };
}
function receipt(flow) {
  return {
    status: 200,
    body: {
      apiVersion: 'v1',
      pid: 93,
      firmwareRead: true,
      firmwareRaw: '0x13600007',
      serviceReport: {
        service: 'PackageFlowService-PS5',
        platform: 'ps5',
        consoleVerified: true,
        version: flow.version,
        buildId: flow.buildId,
      },
    },
  };
}
function harness(flow, overrides = {}) {
  const calls = { connect: 0, send: 0, close: 0, register: 0, launch: 0, manager: 0 };
  const saves = [];
  const assertIntent = () => {
    assert.equal(saves.at(-1)?.state, 'starting', 'mutation requires a saved start intent');
    assert.equal(saves.at(-1)?.dispatched, true, 'intent is durable before the mutation');
  };
  const dependencies = {
    assertIdle() {},
    assertTarget() {},
    async health() {
      return calls.send || calls.launch ? receipt(flow) : null;
    },
    async manager() {
      calls.manager++;
      return { available: false, known: false };
    },
    async register() {
      calls.register++;
      assertIntent();
      return entry;
    },
    async launch(value) {
      calls.launch++;
      assertIntent();
      assert.deepEqual(value, entry);
    },
    async connect() {
      calls.connect++;
      return {
        async send() {
          calls.send++;
          assertIntent();
        },
        close() {
          calls.close++;
        },
      };
    },
    save(value) {
      saves.push(structuredClone(value));
    },
    async pause() {},
    ...overrides,
  };
  return { calls, saves, dependencies };
}

test('an already running exact service is reused without contacting a loader or mutating PLDMGR', async () => {
  const flow = record();
  const { dependencies, calls } = harness(flow, { health: async () => receipt(flow) });
  await runPs5ServiceLaunch(flow, dependencies);
  assert.equal(flow.state, 'completed');
  assert.equal(flow.method, 'running');
  assert.equal(flow.dispatched, false);
  assert.deepEqual(calls, { connect: 0, send: 0, close: 0, register: 0, launch: 0, manager: 0 });
});

test('a known saved payload is launched once with durable intent and no ELF upload', async () => {
  const flow = record();
  const { dependencies, calls } = harness(flow, {
    manager: async () => ({ available: true, known: true, entry }),
  });
  await runPs5ServiceLaunch(flow, dependencies);
  assert.equal(flow.state, 'completed');
  assert.equal(flow.method, 'pldmgr');
  assert.equal(calls.launch, 1);
  assert.equal(calls.register, 0, 'starting a known entry does not overwrite it');
  assert.equal(calls.connect, 0);
  assert.equal(calls.send, 0);
});

test('an explicit first installation saves the verified payload and launches that exact entry', async () => {
  const flow = { ...record(), action: 'install' };
  const { dependencies, calls } = harness(flow, {
    manager: async () => ({ available: true, known: false }),
  });
  await runPs5ServiceLaunch(flow, dependencies);
  assert.equal(flow.state, 'completed');
  assert.equal(calls.register, 1);
  assert.equal(calls.launch, 1);
  assert.equal(calls.send, 0);
});

test('a service started while its saved payload is being registered is reused without a second launch', async () => {
  const flow = { ...record(), action: 'install' };
  const { dependencies, calls } = harness(flow, {
    manager: async () => ({ available: true, known: false }),
  });
  dependencies.health = async () => (calls.register ? receipt(flow) : null);
  await runPs5ServiceLaunch(flow, dependencies);
  assert.equal(flow.state, 'completed');
  assert.equal(flow.method, 'running');
  assert.equal(calls.register, 1);
  assert.equal(calls.launch + calls.send, 0, 'an exact running process needs no second launch');
});

test('a saved payload is not launched when another service appears after manager preflight', async () => {
  const flow = record();
  let healthReads = 0;
  const { dependencies, calls } = harness(flow, {
    manager: async () => ({ available: true, known: true, entry }),
    health: async () => (++healthReads > 2 ? receipt(flow) : null),
  });
  await runPs5ServiceLaunch(flow, dependencies);
  assert.equal(flow.state, 'completed');
  assert.equal(flow.dispatched, false);
  assert.equal(calls.register + calls.launch + calls.send, 0);
});

test('a different running build after registration stays unconfirmed without starting another process', async () => {
  const flow = { ...record(), action: 'install' };
  const { dependencies, calls } = harness(flow, {
    manager: async () => ({ available: true, known: false }),
  });
  dependencies.health = async () => {
    if (!calls.register) return null;
    const response = receipt(flow);
    response.body.serviceReport.buildId = 'other-build';
    return response;
  };
  await runPs5ServiceLaunch(flow, dependencies);
  assert.equal(flow.state, 'unconfirmed');
  assert.equal(flow.dispatched, true);
  assert.equal(calls.register, 1);
  assert.equal(calls.launch + calls.send, 0);
});

test('a definitely unsent manager launch cannot erase an earlier successful payload registration', async () => {
  for (const registered of [false, true]) {
    const flow = { ...record(), action: registered ? 'install' : 'start' };
    const { dependencies, calls } = harness(flow, {
      health: async () => null,
      manager: async () => ({
        available: true,
        known: !registered,
        ...(!registered ? { entry } : {}),
      }),
      async launch() {
        calls.launch++;
        throw Object.assign(Error('launch connection refused before request'), {
          dispatched: false,
        });
      },
    });
    await runPs5ServiceLaunch(flow, dependencies);
    assert.equal(flow.state, registered ? 'unconfirmed' : 'failed');
    assert.equal(flow.dispatched, registered);
    assert.equal(calls.register, registered ? 1 : 0);
    assert.equal(calls.launch, 1);
    assert.equal(calls.send, 0);
  }
});

test('queue activity appearing after registration prevents launch and preserves the sent registration', async () => {
  const flow = { ...record(), action: 'install' };
  const { dependencies, calls } = harness(flow, {
    health: async () => null,
    manager: async () => ({ available: true, known: false }),
  });
  dependencies.assertIdle = () => {
    if (calls.register) throw Error('queue became active while saving the payload');
  };
  await runPs5ServiceLaunch(flow, dependencies);
  assert.equal(flow.state, 'unconfirmed');
  assert.equal(flow.dispatched, true);
  assert.equal(calls.register, 1);
  assert.equal(calls.launch + calls.send, 0);
});

test('an unverified saved entry is not launched, replaced, or bypassed during a start request', async () => {
  const flow = record();
  const { dependencies, calls } = harness(flow, {
    manager: async () => ({ available: true, known: false, entry }),
  });
  await runPs5ServiceLaunch(flow, dependencies);
  assert.equal(flow.state, 'failed');
  assert.equal(flow.dispatched, false);
  assert.match(flow.message, /Версия сохранённой нагрузки не подтверждена/);
  assert.equal(calls.launch + calls.register + calls.connect + calls.send, 0);
});

test('explicit installation with an unknown existing manager entry uses the loader and preserves the entry', async () => {
  const flow = { ...record(), action: 'install' };
  const previousEntry = structuredClone(entry);
  const { dependencies, calls } = harness(flow, {
    manager: async () => ({ available: true, known: false, entry }),
  });
  await runPs5ServiceLaunch(flow, dependencies);
  assert.equal(flow.state, 'completed');
  assert.equal(flow.method, 'loader');
  assert.equal(calls.send, 1);
  assert.equal(calls.register + calls.launch, 0, 'unknown manager files must not be replaced');
  assert.deepEqual(entry, previousEntry);
});

test('a missing manager uses exactly one loader upload and waits for an exact running receipt', async () => {
  const flow = record();
  let sent = false;
  const { dependencies, calls } = harness(flow, {
    health: async () => (sent ? receipt(flow) : null),
  });
  const connect = dependencies.connect;
  dependencies.connect = async () => {
    const connection = await connect();
    const send = connection.send;
    connection.send = async () => {
      await send();
      sent = true;
    };
    return connection;
  };
  await runPs5ServiceLaunch(flow, dependencies);
  assert.equal(flow.state, 'completed');
  assert.equal(flow.method, 'loader');
  assert.equal(calls.connect, 1);
  assert.equal(calls.send, 1);
  assert.equal(calls.close, 1);
  assert.equal(calls.register + calls.launch, 0);
});

for (const method of ['loader', 'saved-payload', 'registration']) {
  test(`a lost ${method} acknowledgement never retries a mutation or switches transports`, async () => {
    const flow = { ...record(), action: method === 'registration' ? 'install' : 'start' };
    const { dependencies, calls } = harness(flow, {
      health: async () => null,
      manager: async () => ({
        available: method !== 'loader',
        known: method === 'saved-payload',
        ...(method === 'saved-payload' ? { entry } : {}),
      }),
    });
    const mutation =
      method === 'loader' ? 'send' : method === 'registration' ? 'register' : 'launch';
    if (method === 'loader') {
      const connect = dependencies.connect;
      dependencies.connect = async () => {
        const connection = await connect();
        const send = connection.send;
        connection.send = async () => {
          await send();
          throw Error('response lost after ELF delivery');
        };
        return connection;
      };
    } else {
      const operation = dependencies[mutation];
      dependencies[mutation] = async (...args) => {
        await operation(...args);
        throw Error('response lost after manager mutation');
      };
    }
    await runPs5ServiceLaunch(flow, dependencies);
    assert.equal(flow.state, 'unconfirmed');
    assert.equal(flow.dispatched, true);
    assert.equal(calls[mutation], 1);
    assert.equal(calls.send + calls.register + calls.launch, 1);
    assert.equal(calls.connect, method === 'loader' ? 1 : 0);
    assert.equal(calls.close, method === 'loader' ? 1 : 0);
  });
}

for (const method of ['loader', 'saved-payload', 'registration']) {
  test(`failure to persist ${method} intent prevents the corresponding remote mutation`, async () => {
    const flow = { ...record(), action: method === 'registration' ? 'install' : 'start' };
    const { dependencies, calls } = harness(flow, {
      health: async () => null,
      manager: async () => ({
        available: method !== 'loader',
        known: method === 'saved-payload',
        ...(method === 'saved-payload' ? { entry } : {}),
      }),
      save(value) {
        if (value.dispatched) throw Error('disk full before dispatch');
      },
    });
    await assert.rejects(runPs5ServiceLaunch(flow, dependencies), /disk full before dispatch/);
    assert.equal(calls.send + calls.register + calls.launch, 0);
    assert.equal(calls.close, method === 'loader' ? 1 : 0);
  });
}

test('busy, changed-target, malformed and unknown running services never trigger a launch', async () => {
  for (const scenario of ['busy', 'changed-target', 'malformed', 'different-version', 'timeout']) {
    const flow = record();
    const { dependencies, calls } = harness(flow, {
      assertIdle() {
        if (scenario === 'busy') throw Error('queue has an unfinished system installation');
      },
      assertTarget() {
        if (scenario === 'changed-target') throw Error('profile IP changed');
      },
      async health() {
        if (scenario === 'timeout') throw Error('health timeout');
        if (scenario === 'malformed') return { status: 200, body: { unknown: true } };
        const value = receipt(flow);
        value.body.serviceReport.buildId = 'other-build';
        return value;
      },
    });
    await runPs5ServiceLaunch(flow, dependencies);
    assert.equal(flow.state, 'failed', scenario);
    assert.equal(flow.dispatched, false, scenario);
    assert.equal(calls.connect + calls.send + calls.register + calls.launch, 0, scenario);
  }
});

for (const scenario of ['busy', 'changed-target', 'service-started']) {
  test(`a ${scenario} change while connecting closes the loader without sending ELF`, async () => {
    const flow = record();
    let connected = false;
    const { dependencies, calls } = harness(flow, {
      assertIdle() {
        if (connected && scenario === 'busy') throw Error('queue became busy');
      },
      assertTarget() {
        if (connected && scenario === 'changed-target') throw Error('profile changed');
      },
      health: async () => (connected && scenario === 'service-started' ? receipt(flow) : null),
    });
    const connect = dependencies.connect;
    dependencies.connect = async () => {
      const connection = await connect();
      connected = true;
      return connection;
    };
    await runPs5ServiceLaunch(flow, dependencies);
    assert.equal(flow.dispatched, false);
    assert.equal(calls.send, 0);
    assert.equal(calls.close, 1);
    assert.equal(calls.launch + calls.register, 0);
    assert.notEqual(flow.state, 'unconfirmed', 'nothing was sent');
  });
}

test('an unfinished launch on one console does not block another console or inherit its state', async () => {
  const one = record('a');
  const two = record('b');
  let releaseOne;
  let sentOne = false;
  let sentTwo = false;
  const first = harness(one, { health: async () => (sentOne ? receipt(one) : null) });
  const second = harness(two, { health: async () => (sentTwo ? receipt(two) : null) });
  const connectOne = first.dependencies.connect;
  first.dependencies.connect = async () => {
    const connection = await connectOne();
    const send = connection.send;
    connection.send = async () => {
      await send();
      await new Promise((resolve) => (releaseOne = resolve));
      sentOne = true;
    };
    return connection;
  };
  const connectTwo = second.dependencies.connect;
  second.dependencies.connect = async () => {
    const connection = await connectTwo();
    const send = connection.send;
    connection.send = async () => {
      await send();
      sentTwo = true;
    };
    return connection;
  };
  const pending = runPs5ServiceLaunch(one, first.dependencies);
  const deadline = Date.now() + 1000;
  while (!releaseOne) {
    assert.ok(Date.now() < deadline, 'first console never reached the loader');
    await new Promise((resolve) => setImmediate(resolve));
  }
  try {
    await runPs5ServiceLaunch(two, second.dependencies);
    assert.equal(two.state, 'completed');
    assert.equal(one.state, 'starting');
    assert.equal(first.calls.send, 1);
    assert.equal(second.calls.send, 1);
    assert.ok(first.saves.every((value) => value.consoleId === one.consoleId));
    assert.ok(second.saves.every((value) => value.consoleId === two.consoleId));
  } finally {
    releaseOne();
    await pending;
  }
  assert.equal(one.state, 'completed');
});

test('launch completion requires the exact build, actual process, platform and qualified firmware', () => {
  const flow = record();
  assert.equal(ps5ServiceLaunchReceipt(flow, receipt(flow)), true);
  for (const mutate of [
    (value) => (value.status = 503),
    (value) => (value.body.apiVersion = 'v2'),
    (value) => (value.body.pid = 0),
    (value) => (value.body.firmwareRead = false),
    (value) => (value.body.firmwareRaw = '0x12600000'),
    (value) => (value.body.serviceReport.service = 'different'),
    (value) => (value.body.serviceReport.platform = 'ps4'),
    (value) => (value.body.serviceReport.consoleVerified = false),
    (value) => (value.body.serviceReport.version = 'old'),
    (value) => (value.body.serviceReport.buildId = 'old-build'),
  ]) {
    const response = receipt(flow);
    mutate(response);
    assert.equal(ps5ServiceLaunchReceipt(flow, response), false);
  }
});

test('a delivered ELF remains unconfirmed when the responding process cannot prove its release', async () => {
  for (const scenario of ['wrong-build', 'wrong-firmware', 'malformed']) {
    const flow = record();
    let sent = false;
    const { dependencies, calls } = harness(flow, {
      async health() {
        if (!sent) return null;
        if (scenario === 'malformed') return { status: 200, body: {} };
        const response = receipt(flow);
        if (scenario === 'wrong-build') response.body.serviceReport.buildId = 'other-build';
        if (scenario === 'wrong-firmware') response.body.firmwareRaw = '0x12600000';
        return response;
      },
    });
    const connect = dependencies.connect;
    dependencies.connect = async () => {
      const connection = await connect();
      const send = connection.send;
      connection.send = async () => {
        await send();
        sent = true;
      };
      return connection;
    };
    await runPs5ServiceLaunch(flow, dependencies);
    assert.equal(flow.state, 'unconfirmed', scenario);
    assert.equal(calls.send, 1, scenario);
    assert.equal(calls.register + calls.launch, 0, scenario);
  }
});

test.after(() => rm(work, { recursive: true, force: true }));
