import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

test('a service bootstrap or update started during PS5 preflight closes admission only on that device', async () => {
  const work = await mkdtemp(join(tmpdir(), 'pf-start-admission-'));
  try {
    const bundle = join(work, 'api.mjs');
    await build({
      stdin: {
        contents:
          "export * from './server/utils/ps5-installation-queue';export * from './server/utils/console-profiles';",
        resolveDir: resolve('.'),
      },
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    for (const scenario of ['bootstrap-sending', 'bootstrap-unconfirmed', 'update-sending']) {
      const result = spawnSync(
        process.execPath,
        ['server/tests/fixtures/ps5-service-start-admission-runner.mjs', bundle, work, scenario],
        {
          encoding: 'utf8',
          timeout: 12000,
          env: {
            ...process.env,
            NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --experimental-transform-types`.trim(),
          },
        },
      );
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, `${scenario}: ${result.stderr || result.stdout}`);
      const proof = JSON.parse(result.stdout.trim().split('\n').at(-1));
      assert.equal(proof.blockedStatusCode, 409);
      assert.equal(proof.blockedQueueItems, 0);
      assert.equal(proof.blockedQueueFileExists, false);
      assert.equal(proof.blockedMutations, 0);
      assert.equal(proof.otherQueueItems, 1);
      assert.equal(
        proof.otherTransferBegins,
        1,
        'another console reaches the real transfer driver',
      );
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
