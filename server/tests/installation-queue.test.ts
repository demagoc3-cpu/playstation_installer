import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const runner = fileURLToPath(new URL('./fixtures/installation-runner.mjs', import.meta.url))
for (const scenario of ['service-speed', 'payload-speed', 'task-clear', 'task-remove-pending', 'task-cancel-payload-race', 'task-history', 'task-cancel-service', 'removed-job', 'preference', 'payload', 'payload-firmware', 'payload-firmware-unavailable', 'append', 'space', 'busy-wait', 'busy-restart', 'resume-tail', 'firmware', 'firmware-unverified', 'legacy', 'service', 'icon', 'interruption', 'restart', 'terminal-failure', 'silent-stall', 'already-installed', 'inventory-installed', 'busy-rejection', 'cancel', 'cancel-removed', 'cancel-stuck', 'cancel-one', 'cancel-one-before-dispatch', 'cancel-game', 'cancel-selected', 'cancel-branches', 'mini-app', 'mini-app-old-service']) {
  test(`production queue: ${scenario}`, () => {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', runner, scenario], { cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 12000, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr + result.stdout)
  })
}
