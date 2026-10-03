import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
for (const mode of ['reinstall', 'reinstall-bundle', 'firmware-reinstall', 'partial', 'recovery', 'control', 'update', 'recover_update', 'replace_update', 'manual_update', 'stage', 'release']) test(`production console maintenance: ${mode}`, () => {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./fixtures/maintenance-runner.mjs', import.meta.url)), mode], { cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 12000, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
