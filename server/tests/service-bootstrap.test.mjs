import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'

for (const mode of ['success', 'late-download', 'running-service', 'offline', 'changed', 'stopping', 'normal-no-service', 'changed-after-acceptance']) {
  test(`initial PS4 service installation: ${mode}`, () => {
    const result = execFileSync(process.execPath, ['server/tests/fixtures/service-bootstrap-runner.mjs', mode], { encoding: 'utf8', timeout: 20000 });
    assert.match(result, /PASS: service bootstrap/);
  });
}
