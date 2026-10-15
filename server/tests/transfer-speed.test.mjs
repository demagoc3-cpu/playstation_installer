import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

test('live acknowledged throughput excludes resume offsets, stalls and previous attempts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-speed-'));
  try {
    const out = join(dir, 'test.mjs');
    await build({
      stdin: {
        contents: `export * from './server/utils/transfer-speed'; export * from './shared/types/tasks'`,
        resolveDir: resolve('.'),
      },
      outfile: out,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const { TransferSpeed, installationTaskSpeed } = await import(pathToFileURL(out).href);
    let time = 0;
    const speed = new TransferSpeed(() => time);
    speed.observe(8 * 1024 ** 3); // A resumed transfer's existing bytes are not sent now.
    assert.equal(speed.read(), undefined);
    time = 1000;
    speed.observe(8 * 1024 ** 3 + 20 * 1024 ** 2);
    assert.equal(speed.read(), 20 * 1024 ** 2);
    time = 2000;
    speed.observe(8 * 1024 ** 3 + 40 * 1024 ** 2);
    assert.equal(speed.read(), 20 * 1024 ** 2);
    time = 4000;
    assert.equal(speed.read(), 10 * 1024 ** 2, 'elapsed time includes pauses');
    time = 8000;
    assert.equal(speed.read(), 0, 'stalled transfer is zero');
    speed.observe(8 * 1024 ** 3 + 44 * 1024 ** 2);
    assert.equal(
      speed.read(),
      (4 * 1024 ** 2) / 6,
      'a verification pause remains part of total throughput',
    );
    time = 9000;
    speed.observe(8 * 1024 ** 3 + 64 * 1024 ** 2);
    assert.equal(speed.read(), (24 * 1024 ** 2) / 7);
    speed.observe(0);
    assert.equal(speed.read(), undefined, 'rollback cannot generate a negative rate');
    speed.reset();
    assert.equal(speed.read(), undefined);
    const task = {
      state: 'sending',
      progressPhase: 'transfer',
      transferBytesPerSecond: 20 * 1024 ** 2,
      transferMeasuredAt: 10000,
    };
    assert.equal(installationTaskSpeed(task, 12000), 20 * 1024 ** 2);
    assert.equal(installationTaskSpeed(task, 16000), 0, 'stale browser data shows zero');
    for (const patch of [
      { state: 'installed' },
      { state: 'verifying', progressPhase: 'source-check' },
      { progressPhase: 'device-check' },
      { transferBytesPerSecond: NaN },
      { transferBytesPerSecond: -1 },
    ])
      assert.equal(installationTaskSpeed({ ...task, ...patch }, 12000), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prefetch overlaps reads with transfer, never sends before ACK, drains failed/aborted reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-prefetch-'));
  try {
    const out = join(dir, 'test.mjs');
    await build({
      stdin: {
        contents: `export * from './server/utils/ps5-send-chunks'`,
        resolveDir: resolve('.'),
      },
      outfile: out,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const { ps5SendChunks } = await import(pathToFileURL(out).href);
    await ps5SendChunks({
      size: 10,
      offset: 0,
      chunkSize: 128 * 1048576,
      signal: new AbortController().signal,
      read: async (buffer) => {
        assert.equal(buffer.length, 10);
        assert.equal(
          buffer.buffer.byteLength,
          10,
          'small Folder files must not allocate a full negotiated group',
        );
        buffer.fill(42);
        return 10;
      },
      validateSource: async () => true,
      send: async (offset, bytes) => {
        assert.equal(offset, 0);
        assert.deepEqual(bytes, Buffer.alloc(10, 42));
      },
      progress: (offset) => assert.equal(offset, 10),
    });

    const source = Buffer.from('abcdefghij'),
      events = [],
      sent = [],
      progress = [];
    const controller = new AbortController();
    let release,
      sending = false;
    const work = ps5SendChunks({
      size: 10,
      offset: 2,
      chunkSize: 3,
      signal: controller.signal,
      read: async (buffer, position) => {
        events.push(`read-${position}`);
        source.copy(buffer, 0, position, position + buffer.length);
        return buffer.length;
      },
      validateSource: async () => true,
      send: async (offset, bytes) => {
        assert.equal(sending, false, 'only one network request in flight');
        sending = true;
        if (offset === 2)
          await new Promise((resolve) => {
            release = resolve;
          });
        sent.push(Buffer.from(bytes));
        events.push(`ack-${offset}`);
        sending = false;
      },
      progress: (n) => progress.push(n),
    });
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      events,
      ['read-2', 'read-5'],
      'next source read is started before current ACK',
    );
    assert.deepEqual(progress, [], 'prefetched bytes are not reported as transferred');
    release();
    await work;
    assert.equal(Buffer.concat(sent).toString(), 'cdefghij');
    assert.deepEqual(progress, [5, 8, 10]);
    let readDone = false,
      sendCount = 0,
      finishRead;
    const failed = ps5SendChunks({
      size: 6,
      offset: 0,
      chunkSize: 3,
      signal: controller.signal,
      read: async (buffer, position) => {
        if (position)
          await new Promise((resolve) => {
            finishRead = resolve;
          });
        readDone = true;
        return buffer.length;
      },
      validateSource: async () => true,
      send: async () => {
        sendCount++;
        readDone = false;
        throw new Error('ACK lost');
      },
      progress: () => assert.fail('no durable ACK'),
    });
    while (!finishRead) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(readDone, false);
    finishRead();
    await assert.rejects(failed, /ACK lost/);
    assert.equal(readDone, true, 'pending read is drained before caller closes source');
    assert.equal(sendCount, 1);
    const abort = new AbortController();
    await assert.rejects(
      ps5SendChunks({
        size: 6,
        offset: 0,
        chunkSize: 3,
        signal: abort.signal,
        read: async (buffer) => buffer.length,
        validateSource: async () => true,
        send: async () => {
          abort.abort();
        },
        progress: () => assert.fail('cancelled ACK is not reported'),
      }),
      { name: 'AbortError' },
    );
    await assert.rejects(
      ps5SendChunks({
        size: 6,
        offset: 0,
        chunkSize: 3,
        signal: controller.signal,
        read: async () => 1,
        validateSource: async () => true,
        send: async () => assert.fail('short source'),
        progress: () => {},
      }),
      /Исходный файл изменился/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner publishes live speed only for its active transmission, without persisting it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-speed-runner-'));
  try {
    const out = join(dir, 'test.mjs');
    await build({
      stdin: {
        contents: `export * from './server/utils/ps5-queue-core'`,
        resolveDir: resolve('.'),
      },
      outfile: out,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const { Ps5QueueRunner, ps5BlankQueue } = await import(pathToFileURL(out).href);
    let time = 0,
      save,
      release,
      durable;
    const queue = ps5BlankQueue('one', '192.0.2.1');
    const runner = new Ps5QueueRunner(
      queue,
      (q) => {
        durable = structuredClone(q);
      },
      {
        async run(item, signal, checkpoint) {
          save = checkpoint;
          save({ state: 'sending', progressPhase: 'transfer', bytesSent: 100 });
          await new Promise((resolve) => {
            release = resolve;
          });
          return { state: 'installed' };
        },
        async cancel() {},
      },
      5,
      () => {},
      () => time,
    );
    runner.enqueue([
      {
        packageId: 'one',
        title: 'one',
        fileName: 'one.pkg',
        size: 1000,
        type: 'Игра',
        titleId: 'PPSA95001',
        platform: 'ps5',
        format: 'pkg',
        branch: 'ps5:PPSA95001',
        order: 0,
      },
    ]);
    const item = queue.items[0];
    assert.equal(runner.transferTelemetry(item).transferBytesPerSecond, 0);
    time = 1000;
    save({ bytesSent: 200 });
    assert.equal(runner.transferTelemetry(item).transferBytesPerSecond, 100);
    assert.deepEqual(
      runner.transferTelemetry({ ...item }),
      {},
      'another task cannot inherit the rate',
    );
    assert.equal('transferBytesPerSecond' in durable.items[0], false);
    time = 17000;
    assert.equal(runner.transferTelemetry(item).transferBytesPerSecond, 0);
    save({ state: 'verifying', progressPhase: 'device-check' });
    assert.deepEqual(runner.transferTelemetry(item), {});
    release();
    await runner.settled();
    assert.deepEqual(runner.transferTelemetry(item), {});
    assert.equal(queue.status, 'completed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('folder speed remains visible through an intermediate check and stops at final verification', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-folder-speed-'));
  try {
    const out = join(dir, 'test.mjs');
    await build({
      stdin: {
        contents: `export * from './server/utils/ps5-queue-core'; export * from './shared/types/tasks'`,
        resolveDir: resolve('.'),
      },
      outfile: out,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const { Ps5QueueRunner, ps5BlankQueue, installationTaskSpeed } = await import(
      pathToFileURL(out).href
    );
    let time = 0,
      save,
      release;
    const queue = ps5BlankQueue('folder', '192.0.2.1');
    const runner = new Ps5QueueRunner(
      queue,
      () => {},
      {
        async run(item, signal, checkpoint) {
          save = checkpoint;
          save({ state: 'sending', progressPhase: 'transfer', bytesSent: 0 });
          await new Promise((r) => {
            release = r;
          });
          return { state: 'installed' };
        },
        async cancel() {},
      },
      5,
      () => {},
      () => time,
    );
    runner.enqueue([
      {
        packageId: 'folder',
        title: 'folder',
        fileName: 'folder',
        size: 1000,
        type: 'Игра',
        titleId: 'PPSA95001',
        platform: 'ps5',
        format: 'folder',
        branch: 'ps5:PPSA95001',
        order: 0,
      },
    ]);
    const item = queue.items[0];
    time = 1000;
    save({ bytesSent: 200 });
    const rate = runner.transferTelemetry(item).transferBytesPerSecond;
    save({ state: 'verifying', progressPhase: 'device-check' });
    assert.equal(runner.transferTelemetry(item).transferBytesPerSecond, rate);
    assert.equal(installationTaskSpeed({ ...item, ...runner.transferTelemetry(item) }), rate);
    time = 4000;
    save({ state: 'sending', progressPhase: 'transfer', bytesSent: 400 });
    assert.equal(
      runner.transferTelemetry(item).transferBytesPerSecond,
      100,
      'elapsed verification pause is counted',
    );
    save({ state: 'verifying', progressPhase: 'device-check', bytesSent: 1000 });
    assert.deepEqual(runner.transferTelemetry(item), {});
    release();
    await runner.settled();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PS5 rate and ETA survive slow durable ACKs and fresh polls, but stop for stale polls, stalls and pause', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-live-rate-'));
  try {
    const out = join(dir, 'test.mjs');
    await build({
      stdin: {
        contents: `export * from './server/utils/ps5-queue-core'; export * from './shared/types/tasks'`,
        resolveDir: resolve('.'),
      },
      outfile: out,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const {
      Ps5QueueRunner,
      ps5BlankQueue,
      installationTaskSpeed,
      installationTaskRemainingMinutes,
    } = await import(pathToFileURL(out).href);
    let time = 0,
      save,
      finish,
      durable,
      attempts = 0;
    t.mock.method(Date, 'now', () => 100000 + time);
    const mib = 1048576,
      queue = ps5BlankQueue('slow-folder', '192.0.2.1');
    const runner = new Ps5QueueRunner(
      queue,
      (q) => {
        durable = structuredClone(q);
      },
      {
        async run(item, signal, checkpoint) {
          attempts++;
          save = checkpoint;
          save({ state: 'sending', progressPhase: 'transfer', bytesSent: item.bytesSent });
          await new Promise((resolve, reject) => {
            finish = resolve;
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          return { state: 'installed' };
        },
        async cancel() {},
      },
      5,
      () => {},
      () => time,
    );
    runner.enqueue([
      {
        packageId: 'folder',
        title: 'folder',
        fileName: 'folder',
        size: 1024 * mib,
        type: 'Игра',
        titleId: 'PPSA95001',
        platform: 'ps5',
        format: 'folder',
        branch: 'ps5:PPSA95001',
        order: 0,
      },
    ]);
    const item = queue.items[0];
    const snapshot = () => ({
      ...structuredClone(item),
      consolePlatform: 'ps5',
      ...runner.transferTelemetry(item),
    });
    assert.equal(
      installationTaskRemainingMinutes(snapshot(), Date.now()),
      undefined,
      'a baseline is not a measured rate',
    );
    time = 4000;
    save({ bytesSent: 128 * mib });
    assert.equal(installationTaskSpeed(snapshot(), Date.now()), 32 * mib);
    assert.equal(installationTaskRemainingMinutes(snapshot(), Date.now()), 1);
    save({ state: 'verifying', progressPhase: 'device-check' });
    // Replacing task objects on each two-second poll must not lose the meter.
    for (time = 6000; time <= 10000; time += 2000) {
      const task = snapshot();
      assert.equal(
        task.transferMeasuredAt,
        Date.now(),
        'the timestamp belongs to this rate sample',
      );
      assert.equal(
        installationTaskSpeed(task, Date.now()),
        (128 * mib) / (time / 1000),
        'elapsed ACK/check time remains in the rate',
      );
      assert.ok(
        installationTaskRemainingMinutes(task, Date.now()) > 0,
        'ETA remains available between ACKs',
      );
    }
    time = 12000;
    save({ state: 'sending', progressPhase: 'transfer', bytesSent: 256 * mib });
    assert.equal(
      installationTaskSpeed(snapshot(), Date.now()),
      16 * mib,
      'eight-second ACK interval is a measured rate',
    );
    const oldResponse = snapshot();
    time = 18000;
    assert.equal(
      installationTaskSpeed(oldResponse, Date.now()),
      0,
      'lost WEB connection does not retain an old positive rate',
    );
    assert.equal(installationTaskRemainingMinutes(oldResponse, Date.now()), undefined);
    assert.ok(
      installationTaskSpeed(snapshot(), Date.now()) > 0,
      'a fresh poll during the next slow batch remains live',
    );
    time = 28001;
    save({ bytesSent: item.bytesSent });
    assert.equal(
      installationTaskSpeed(snapshot(), Date.now()),
      0,
      'duplicate counters do not hide a real stall',
    );
    assert.equal(installationTaskRemainingMinutes(snapshot(), Date.now()), undefined);
    time = 29000;
    save({ bytesSent: 384 * mib });
    assert.ok(installationTaskSpeed(snapshot(), Date.now()) > 0, 'the next ACK recovers the rate');
    const pause = runner.pause(queue.id);
    assert.deepEqual(
      runner.transferTelemetry(item),
      {},
      'pause hides speed immediately before driver cleanup',
    );
    await pause;
    assert.equal(installationTaskRemainingMinutes(snapshot(), Date.now()), undefined);
    time = 30000;
    runner.resume(queue.id);
    assert.equal(attempts, 2);
    assert.equal(
      installationTaskSpeed(snapshot(), Date.now()),
      0,
      'resume starts from a byte baseline',
    );
    time = 34000;
    save({ bytesSent: 512 * mib });
    assert.equal(
      installationTaskSpeed(snapshot(), Date.now()),
      32 * mib,
      'previous-attempt time and bytes are excluded',
    );
    save({ state: 'verifying', progressPhase: 'device-check', bytesSent: 1024 * mib });
    assert.deepEqual(
      runner.transferTelemetry(item),
      {},
      'final verification is not a network transfer',
    );
    assert.equal(installationTaskRemainingMinutes(snapshot(), Date.now()), undefined);
    finish();
    await runner.settled();
    assert.deepEqual(runner.transferTelemetry(item), {});
    assert.equal(installationTaskRemainingMinutes(snapshot(), Date.now()), undefined);
    assert.equal(
      'transferBytesPerSecond' in durable.items[0],
      false,
      'rates are still never persisted',
    );
    assert.equal('transferMeasuredAt' in durable.items[0], false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PS4 live telemetry isolates consoles/attempts, survives download states, excludes restored bytes and local installation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-ps4-speed-'));
  try {
    const out = join(dir, 'test.mjs');
    await build({
      stdin: {
        contents: `export * from './server/utils/ps4-transfer-speed'; export * from './shared/types/tasks'`,
        resolveDir: resolve('.'),
      },
      outfile: out,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const { Ps4TransferSpeed, installationTaskSpeed } = await import(pathToFileURL(out).href);
    let time = 0;
    const meter = new Ps4TransferSpeed(() => time);
    const item = {
      packageId: 'game',
      requestId: 'attempt-one',
      state: 'receiving',
      size: 1000,
      bytesSent: 500,
    };
    const queue = {
      id: 'queue',
      psIp: '192.0.2.1',
      createdAt: 1,
      status: 'running',
      items: [item],
    };
    assert.deepEqual(meter.read(queue, item), {}, 'restored journal is not live speed');
    meter.observe(queue);
    assert.equal(meter.read(queue, item).transferBytesPerSecond, 0);
    const other = { ...queue, psIp: '192.0.2.2', items: [{ ...item }] };
    meter.observe(other);
    time = 1500;
    item.bytesSent = 650;
    meter.observe(queue);
    assert.equal(meter.read(queue, item).transferBytesPerSecond, 100);
    assert.equal(
      meter.read(other, other.items[0]).transferBytesPerSecond,
      0,
      'parallel console cannot inherit the rate',
    );
    assert.equal(
      installationTaskSpeed({ ...item, consolePlatform: 'ps4', ...meter.read(queue, item) }),
      100,
    );
    item.state = 'installing';
    time = 3000;
    item.bytesSent = 800;
    meter.observe(queue);
    assert.equal(
      installationTaskSpeed({ ...item, consolePlatform: 'ps4', ...meter.read(queue, item) }),
      100,
      'BGFT installing can still download',
    );
    time = 9000;
    meter.observe(queue);
    assert.equal(meter.read(queue, item).transferBytesPerSecond, 0, 'unchanged counter stalls');
    const restarted = new Ps4TransferSpeed(() => time);
    restarted.observe(queue);
    assert.equal(
      restarted.read(queue, item).transferBytesPerSecond,
      0,
      '800 resumed bytes are only a baseline',
    );
    item.requestId = 'attempt-two';
    meter.observe(queue);
    assert.equal(
      meter.read(queue, item).transferBytesPerSecond,
      0,
      'new request resets the samples',
    );
    time = 10500;
    item.bytesSent = 950;
    meter.observe(queue);
    assert.equal(meter.read(queue, item).transferBytesPerSecond, 100);
    item.bytesSent = 1000;
    meter.observe(queue);
    assert.deepEqual(
      meter.read(queue, item),
      {},
      'local installation after full download has no network speed',
    );
    assert.equal(
      installationTaskSpeed({
        ...item,
        consolePlatform: 'ps4',
        progressPhase: 'transfer',
        transferBytesPerSecond: 100,
        transferMeasuredAt: Date.now(),
      }),
      undefined,
    );
    item.state = 'failed';
    meter.observe(queue);
    assert.deepEqual(meter.read(queue, item), {});
    assert.equal(
      'transferBytesPerSecond' in item,
      false,
      'queue data stays free of live telemetry',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PS4 UI rejects stale rates and byte counters follow transfer versus source-check phase', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-task-bytes-'));
  try {
    const out = join(dir, 'test.mjs');
    await build({
      stdin: { contents: `export * from './shared/types/tasks'`, resolveDir: resolve('.') },
      outfile: out,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const { installationTaskSpeed, installationTaskMegabytes } = await import(
      pathToFileURL(out).href
    );
    const task = {
      consolePlatform: 'ps4',
      state: 'receiving',
      progressPhase: 'transfer',
      size: 15815 * 1048576,
      bytesSent: 150 * 1048576,
      transferBytesPerSecond: 20 * 1048576,
      transferMeasuredAt: 10000,
    };
    assert.deepEqual(installationTaskMegabytes(task), { transferred: 150, total: 15815 });
    assert.equal(installationTaskSpeed(task, 12000), 20 * 1048576);
    assert.equal(installationTaskSpeed(task, 16000), 0);
    for (const state of ['pending', 'waiting', 'verifying', 'installed', 'delivered', 'failed'])
      assert.equal(installationTaskSpeed({ ...task, state }, 12000), undefined);
    assert.deepEqual(
      installationTaskMegabytes({
        ...task,
        progressPhase: 'source-check',
        bytesChecked: 50 * 1048576,
      }),
      { transferred: 50, total: 15815 },
    );
    assert.deepEqual(installationTaskMegabytes({ ...task, bytesSent: -1 }), {
      transferred: 0,
      total: 15815,
    });
    assert.deepEqual(installationTaskMegabytes({ ...task, bytesSent: Infinity }), {
      transferred: 0,
      total: 15815,
    });
    assert.deepEqual(
      installationTaskMegabytes({ ...task, size: 1048577, bytesSent: 1048576 }),
      { transferred: 1, total: 2 },
      'do not round an unfinished transfer to its total',
    );
    assert.deepEqual(installationTaskMegabytes({ ...task, size: 1048577, bytesSent: 1048577 }), {
      transferred: 2,
      total: 2,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
