import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = mkdtempSync(join(tmpdir(), 'pf-adaptive-batch-'));
await build({
  stdin: { contents: "export * from './server/utils/ps5-send-chunks'", resolveDir: resolve('.') },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: join(dir, 'api.mjs'),
  logLevel: 'silent',
});
const { ps5AckRejected, ps5SendChunks, resetPs5BatchSizes } = await import(
  pathToFileURL(join(dir, 'api.mjs')).href
);
test.after(() => rmSync(dir, { recursive: true, force: true }));

const MiB = 1024 * 1024,
  batchMax = 128 * MiB;

/** Simulated PS5 batch route: the body must arrive within 60 s or nothing of
 * it becomes durable (receive.c). Time advances by bytes / bytesPerSecond. */
function link(bytesPerSecond, { lostAckAt } = {}) {
  const state = { clock: 0, durable: 0, sent: [], failed: [], lostAckAt };
  state.send = async (position, bytes) => {
    assert.equal(position, state.durable, 'batches always start at the durable offset');
    const ms = (bytes.length / bytesPerSecond) * 1000;
    if (ms >= 60000) {
      state.clock += 60000;
      state.failed.push(bytes.length);
      throw new Error('Chunk acknowledgement lost; reconcile durable offset');
    }
    state.clock += ms;
    state.durable += bytes.length;
    state.sent.push(bytes.length);
    if (state.lostAckAt === position) {
      state.lostAckAt = undefined;
      throw new Error('Chunk acknowledgement lost; reconcile durable offset');
    }
  };
  return state;
}
/** The queue driver retries from the durable offset after a failed batch. */
async function transfer(state, size, { key = 'console-a', chunkSize = batchMax } = {}) {
  let attempts = 0;
  while (state.durable < size) {
    assert.ok(++attempts <= 4, 'transfer must not loop on the same batch');
    await ps5SendChunks({
      read: async (buffer) => buffer.length,
      size,
      offset: state.durable,
      chunkSize,
      signal: new AbortController().signal,
      validateSource: async () => true,
      send: state.send,
      progress: () => {},
      adaptiveKey: key,
      now: () => state.clock,
    }).catch(() => {});
  }
  return attempts;
}

for (const rate of [2.2e6, 1.2e6, 0.3e6])
  test(`a ${rate / 1e6} MB/s route shrinks after one timed-out batch and then completes`, async () => {
    resetPs5BatchSizes();
    const state = link(rate),
      size = 733 * MiB;
    const attempts = await transfer(state, size);
    // Each timed-out batch shrinks the next at least fourfold; at ~2 MB/s only
    // the first full batch is lost.
    if (rate >= 1e6) assert.deepEqual(state.failed, [batchMax]);
    assert.ok(state.failed.length <= 3);
    for (let i = 1; i < state.failed.length; i++)
      assert.ok(state.failed[i] * 4 <= state.failed[i - 1]);
    assert.equal(attempts, state.failed.length + 1);
    assert.equal(state.durable, size);
    // Every completed batch stays well under the 60 s receive limit.
    for (const bytes of state.sent) assert.ok((bytes / rate) * 1000 <= 30000);
    // The fitted size is remembered: a later transfer to the same console does
    // not lose another batch.
    const next = link(rate);
    assert.equal(await transfer(next, 200 * MiB), 1);
    assert.deepEqual(next.failed, []);
  });

test('a slow batch that still fits shrinks the following batches to ~20 s', async () => {
  resetPs5BatchSizes();
  const rate = 2.6e6,
    state = link(rate);
  assert.equal(await transfer(state, 733 * MiB), 1);
  assert.deepEqual(state.failed, []);
  assert.equal(state.sent[0], batchMax);
  // The batch read ahead during the slow one keeps its size; then it fits.
  for (const bytes of state.sent.slice(2)) assert.ok((bytes / rate) * 1000 <= 20000);
});

test('a fast route keeps full qualified batches exactly as before', async () => {
  resetPs5BatchSizes();
  const state = link(80 * 1e6),
    size = 3 * batchMax + 19;
  assert.equal(await transfer(state, size), 1);
  assert.deepEqual(state.sent, [batchMax, batchMax, batchMax, 19]);
});

test('a quick lost acknowledgement keeps the batch size', async () => {
  resetPs5BatchSizes();
  const state = link(80 * 1e6, { lostAckAt: 0 }),
    size = 2 * batchMax;
  assert.equal(await transfer(state, size), 2);
  assert.deepEqual(state.sent, [batchMax, batchMax]);
});

test('a remembered small batch grows back on a fast route', async () => {
  resetPs5BatchSizes();
  await transfer(link(2.6 * 1e6), 300 * MiB);
  const fast = link(200 * 1e6);
  await transfer(fast, 1024 * MiB);
  assert.ok(fast.sent[0] < batchMax);
  assert.ok(fast.sent.includes(batchMax), 'the size returns to the qualified maximum');
  for (let i = 1; i < fast.sent.length; i++) assert.ok(fast.sent[i] <= fast.sent[i - 1] * 2);
});

test('consoles keep independent batch sizes', async () => {
  resetPs5BatchSizes();
  await transfer(link(2.6 * 1e6), 300 * MiB, { key: 'remote' });
  const local = link(80 * 1e6);
  await transfer(local, 2 * batchMax, { key: 'local' });
  assert.deepEqual(local.sent, [batchMax, batchMax]);
});

test('without an adaptive key (chunk route) sizes are unchanged', async () => {
  resetPs5BatchSizes();
  const sent = [];
  let clock = 0;
  await ps5SendChunks({
    read: async (buffer) => buffer.length,
    size: 10 * MiB + 7,
    offset: 0,
    chunkSize: 4 * MiB,
    signal: new AbortController().signal,
    validateSource: async () => true,
    send: async (_position, bytes) => {
      clock += 40000;
      sent.push(bytes.length);
    },
    progress: () => {},
    now: () => clock,
  });
  assert.deepEqual(sent, [4 * MiB, 4 * MiB, 2 * MiB + 7]);
});

test('a stalled tunnel (service receive timeout) halves the batch even when it fails early', async () => {
  resetPs5BatchSizes();
  const sent = [];
  let durable = 0,
    clock = 0,
    stalls = 2;
  const size = 96 * MiB;
  for (let attempt = 0; durable < size; attempt++) {
    assert.ok(attempt < 6);
    await ps5SendChunks({
      read: async (buffer) => buffer.length,
      size,
      offset: durable,
      chunkSize: 32 * MiB,
      signal: new AbortController().signal,
      validateSource: async () => true,
      send: async (position, bytes) => {
        clock += 12000;
        if (stalls-- > 0)
          throw ps5AckRejected(
            'Chunk',
            { status: 408, body: { error: 'transfer rejected', status: 408 } },
            position,
            bytes.length,
          );
        sent.push(bytes.length);
        durable += bytes.length;
      },
      progress: () => {},
      adaptiveKey: 'tunnel',
      now: () => clock,
    }).catch(() => {});
  }
  assert.equal(sent[0], 8 * MiB, '32 MiB → 16 MiB → 8 MiB after two stalls');
});

test('other rejections keep the batch size', async () => {
  resetPs5BatchSizes();
  const error = ps5AckRejected('Chunk', { status: 409, body: { error: 'busy' } }, 0, MiB);
  assert.equal(error.receiveTimeout, false);
});
