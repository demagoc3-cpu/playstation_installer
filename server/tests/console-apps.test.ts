import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
for (const mode of ['recovery', 'restart', 'reject', 'busy', 'corrupt']) test(`production console manager: ${mode}`, () => {
  const runner = fileURLToPath(new URL('./fixtures/console-apps-runner.mjs', import.meta.url))
  const result = spawnSync(process.execPath, ['--experimental-strip-types', runner, mode], { cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 10000, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
