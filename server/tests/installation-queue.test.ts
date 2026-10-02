import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const runner = fileURLToPath(new URL('./fixtures/installation-runner.mjs', import.meta.url))
for (const scenario of ['preference', 'payload', 'append', 'space', 'firmware', 'firmware-unverified', 'legacy', 'service', 'icon', 'interruption', 'restart', 'terminal-failure', 'silent-stall', 'already-installed', 'busy-rejection', 'cancel', 'cancel-removed', 'cancel-stuck']) {
  test(`production queue: ${scenario}`, () => {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', runner, scenario], { cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 12000, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr + result.stdout)
  })
}
