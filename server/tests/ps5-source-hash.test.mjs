import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { blake3 } from '@noble/hashes/blake3.js'

const dir = await mkdtemp(join(tmpdir(), 'pf-hash-progress-'))
const bundle = join(dir, 'api.mjs')
await build({ stdin: { contents: "export * from './server/utils/ps5-source-hash'; export * from './server/utils/ps5-queue-driver'; export * from './shared/types/tasks';", resolveDir: resolve('.') }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const api = await import(pathToFileURL(bundle).href)
test('source hashing reports partial progress independently of transferred bytes, keeps digest and cancels safely', async () => {
  try {
    const data = Buffer.alloc(3 * 1024 * 1024 + 19, 71), path = join(dir, 'own.pkg')
    await writeFile(path, data)
    const file = await open(path, 'r')
    try {
      const identity = api.ps5SourceStamp(await file.stat()), positions = []
      let time = 0
      const hash = await api.ps5SourceHash(file, data.length, identity, new AbortController().signal, bytes => positions.push(bytes), () => time += 1000)
      assert.equal(hash, Buffer.from(blake3(data)).toString('hex'))
      assert.ok(positions.some(n => n > 0 && n < data.length), 'large source shows measurable progress before completion')
      assert.equal(positions.at(-1), data.length)
      const task = { state: 'verifying', progressPhase: 'source-check', bytesChecked: positions[1], bytesSent: 0, size: data.length, platform: 'ps5' }
      assert.ok(api.installationTaskProgress(task) > 0)
      assert.equal(task.bytesSent, 0, 'checking bytes never masquerade as delivered bytes')
      assert.equal(api.installationTaskStateLabel(task), 'Проверка исходного файла')
      assert.equal(api.installationTaskProgress({ ...task, state: 'sending', progressPhase: 'transfer', bytesSent: 17 }), 17 / data.length * 100)
      const cancel = new AbortController()
      await assert.rejects(api.ps5SourceHash(file, data.length, identity, cancel.signal, n => { if (n > 0) cancel.abort(new Error('stop hash')) }, () => time += 1000), /stop hash/)
      await assert.rejects(api.ps5SourceHash(file, data.length, 'changed-source', new AbortController().signal, () => {}), /изменился/)
      assert.equal(api.ps5TransferChunkSize({}), 262144)
      assert.equal(api.ps5TransferChunkSize({ chunkMax: 4194304 }), 4194304)
      for (const chunkMax of [0, '4194304', 16777216, 300000, -1]) assert.equal(api.ps5TransferChunkSize({ chunkMax }), 262144)
      assert.equal(api.installationTaskStateLabel({ platform: 'ps5', state: 'waiting' }), 'Ожидание PS5')
      assert.equal(api.installationTaskStateLabel({ platform: 'ps4', state: 'waiting' }), 'Ожидаем загрузку PS4')
    } finally { await file.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
