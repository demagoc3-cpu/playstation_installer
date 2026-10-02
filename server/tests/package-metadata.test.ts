import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('PKG table and header distinguish application from patch with the same Content ID', () => {
  const runner = fileURLToPath(new URL('./fixtures/package-metadata-runner.mjs', import.meta.url))
  const cwd = fileURLToPath(new URL('../../', import.meta.url))
  const result = spawnSync(process.execPath, ['--experimental-strip-types', runner], { cwd, encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
