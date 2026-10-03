import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
test('native actions use the production durable command handler', () => {
 const result = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./fixtures/console-commands-runner.mjs', import.meta.url))], { cwd:fileURLToPath(new URL('../../',import.meta.url)), timeout:10000, encoding:'utf8' })
 assert.equal(result.status,0,result.stdout+result.stderr)
})
