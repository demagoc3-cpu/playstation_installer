import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

test('live acknowledged throughput excludes resume offsets, stalls and previous attempts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-speed-'))
  try {
    const out = join(dir, 'test.mjs')
    await build({ stdin: { contents: `export * from './server/utils/transfer-speed'; export * from './shared/types/tasks'`, resolveDir: resolve('.') }, outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const { TransferSpeed, installationTaskSpeed } = await import(pathToFileURL(out).href)
    let time = 0
    const speed = new TransferSpeed(() => time)
    speed.observe(8 * 1024 ** 3) // A resumed transfer's existing bytes are not sent now.
    assert.equal(speed.read(), undefined)
    time = 1000; speed.observe(8 * 1024 ** 3 + 20 * 1024 ** 2)
    assert.equal(speed.read(), 20 * 1024 ** 2)
    time = 2000; speed.observe(8 * 1024 ** 3 + 40 * 1024 ** 2)
    assert.equal(speed.read(), 20 * 1024 ** 2)
    time = 4000; assert.equal(speed.read(), 10 * 1024 ** 2, 'elapsed time includes pauses')
    time = 8000; assert.equal(speed.read(), 0, 'stalled transfer is zero')
    speed.observe(8 * 1024 ** 3 + 44 * 1024 ** 2)
    assert.equal(speed.read(), 4 * 1024 ** 2 / 6, 'a verification pause remains part of total throughput')
    time = 9000; speed.observe(8 * 1024 ** 3 + 64 * 1024 ** 2); assert.equal(speed.read(), 24 * 1024 ** 2 / 7)
    speed.observe(0); assert.equal(speed.read(), undefined, 'rollback cannot generate a negative rate')
    speed.reset(); assert.equal(speed.read(), undefined)
    const task = { state: 'sending', progressPhase: 'transfer', transferBytesPerSecond: 20 * 1024 ** 2, transferMeasuredAt: 10000 }
    assert.equal(installationTaskSpeed(task, 12000), 20 * 1024 ** 2)
    assert.equal(installationTaskSpeed(task, 16000), 0, 'stale browser data shows zero')
    for (const patch of [{ state: 'installed' }, { state: 'verifying', progressPhase: 'source-check' }, { progressPhase: 'device-check' }, { transferBytesPerSecond: NaN }, { transferBytesPerSecond: -1 }]) assert.equal(installationTaskSpeed({ ...task, ...patch }, 12000), undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('prefetch overlaps reads with transfer, never sends before ACK, drains failed/aborted reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-prefetch-'))
  try {
    const out = join(dir, 'test.mjs')
    await build({ stdin: { contents: `export * from './server/utils/ps5-send-chunks'`, resolveDir: resolve('.') }, outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const { ps5SendChunks } = await import(pathToFileURL(out).href)
    const source = Buffer.from('abcdefghij'), events = [], sent = [], progress = []
    const controller = new AbortController()
    let release, sending = false
    const work = ps5SendChunks({ size: 10, offset: 2, chunkSize: 3, signal: controller.signal,
      read: async (buffer, position) => { events.push(`read-${position}`); source.copy(buffer, 0, position, position + buffer.length); return buffer.length },
      validateSource: async () => true,
      send: async (offset, bytes) => {
        assert.equal(sending, false, 'only one network request in flight'); sending = true
        if (offset === 2) await new Promise(resolve => { release = resolve })
        sent.push(Buffer.from(bytes)); events.push(`ack-${offset}`); sending = false
      }, progress: n => progress.push(n),
    })
    while (!release) await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(events, ['read-2', 'read-5'], 'next source read is started before current ACK')
    assert.deepEqual(progress, [], 'prefetched bytes are not reported as transferred')
    release(); await work
    assert.equal(Buffer.concat(sent).toString(), 'cdefghij'); assert.deepEqual(progress, [5, 8, 10])
    let readDone = false, sendCount = 0, finishRead
    const failed = ps5SendChunks({ size: 6, offset: 0, chunkSize: 3, signal: controller.signal,
      read: async (buffer, position) => { if (position) await new Promise(resolve => { finishRead = resolve }); readDone = true; return buffer.length },
      validateSource: async () => true,
      send: async () => { sendCount++; readDone = false; throw new Error('ACK lost') }, progress: () => assert.fail('no durable ACK'),
    })
    while (!finishRead) await new Promise(resolve => setImmediate(resolve))
    assert.equal(readDone, false); finishRead(); await assert.rejects(failed, /ACK lost/)
    assert.equal(readDone, true, 'pending read is drained before caller closes source'); assert.equal(sendCount, 1)
    const abort = new AbortController()
    await assert.rejects(ps5SendChunks({ size: 6, offset: 0, chunkSize: 3, signal: abort.signal,
      read: async buffer => buffer.length, validateSource: async () => true,
      send: async () => { abort.abort() }, progress: () => assert.fail('cancelled ACK is not reported'),
    }), { name: 'AbortError' })
    await assert.rejects(ps5SendChunks({ size: 6, offset: 0, chunkSize: 3, signal: controller.signal,
      read: async () => 1, validateSource: async () => true, send: async () => assert.fail('short source'), progress: () => {},
    }), /Исходный файл изменился/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


test('runner publishes live speed only for its active transmission, without persisting it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-speed-runner-'))
  try {
    const out = join(dir, 'test.mjs')
    await build({ stdin: { contents: `export * from './server/utils/ps5-queue-core'`, resolveDir: resolve('.') }, outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const { Ps5QueueRunner, ps5BlankQueue } = await import(pathToFileURL(out).href)
    let time = 0, save, release, durable
    const queue = ps5BlankQueue('one', '192.0.2.1')
    const runner = new Ps5QueueRunner(queue, q => { durable = structuredClone(q) }, {
      async run(item, signal, checkpoint) {
        save = checkpoint; save({ state: 'sending', progressPhase: 'transfer', bytesSent: 100 })
        await new Promise(resolve => { release = resolve }); return { state: 'installed' }
      }, async cancel() {},
    }, 5, () => {}, () => time)
    runner.enqueue([{ packageId: 'one', title: 'one', fileName: 'one.pkg', size: 1000, type: 'Игра', titleId: 'PPSA95001', platform: 'ps5', format: 'pkg', branch: 'ps5:PPSA95001', order: 0 }])
    const item = queue.items[0]
    assert.equal(runner.transferTelemetry(item).transferBytesPerSecond, 0)
    time = 1000; save({ bytesSent: 200 })
    assert.equal(runner.transferTelemetry(item).transferBytesPerSecond, 100)
    assert.deepEqual(runner.transferTelemetry({ ...item }), {}, 'another task cannot inherit the rate')
    assert.equal('transferBytesPerSecond' in durable.items[0], false)
    time = 7000; assert.equal(runner.transferTelemetry(item).transferBytesPerSecond, 0)
    save({ state: 'verifying', progressPhase: 'device-check' }); assert.deepEqual(runner.transferTelemetry(item), {})
    release(); await runner.settled(); assert.deepEqual(runner.transferTelemetry(item), {})
    assert.equal(queue.status, 'completed')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('folder speed remains visible through an intermediate check and stops at final verification', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-folder-speed-'))
  try {
    const out = join(dir, 'test.mjs')
    await build({ stdin: { contents: `export * from './server/utils/ps5-queue-core'; export * from './shared/types/tasks'`, resolveDir: resolve('.') }, outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const { Ps5QueueRunner, ps5BlankQueue, installationTaskSpeed } = await import(pathToFileURL(out).href)
    let time = 0, save, release
    const queue = ps5BlankQueue('folder', '192.0.2.1')
    const runner = new Ps5QueueRunner(queue, () => {}, {
      async run(item, signal, checkpoint) { save = checkpoint; save({ state: 'sending', progressPhase: 'transfer', bytesSent: 0 }); await new Promise(r => { release = r }); return { state: 'installed' } }, async cancel() {},
    }, 5, () => {}, () => time)
    runner.enqueue([{ packageId: 'folder', title: 'folder', fileName: 'folder', size: 1000, type: 'Игра', titleId: 'PPSA95001', platform: 'ps5', format: 'folder', branch: 'ps5:PPSA95001', order: 0 }])
    const item = queue.items[0]
    time = 1000; save({ bytesSent: 200 }); const rate = runner.transferTelemetry(item).transferBytesPerSecond
    save({ state: 'verifying', progressPhase: 'device-check' }); assert.equal(runner.transferTelemetry(item).transferBytesPerSecond, rate)
    assert.equal(installationTaskSpeed({ ...item, ...runner.transferTelemetry(item) }), rate)
    time = 4000; save({ state: 'sending', progressPhase: 'transfer', bytesSent: 400 }); assert.equal(runner.transferTelemetry(item).transferBytesPerSecond, 100, 'elapsed verification pause is counted')
    save({ state: 'verifying', progressPhase: 'device-check', bytesSent: 1000 }); assert.deepEqual(runner.transferTelemetry(item), {})
    release(); await runner.settled()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
