import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

test('one PS4 and two PS5 keep independent production queues, cancellation, progress and approved reinstallation', async () => {
  const work = await mkdtemp(join(tmpdir(), 'pf-mixed-install-'));
  try {
    const bundle = join(work, 'api.mjs');
    await build({
      stdin: {
        contents: [
          'device-installation',
          'console-profiles',
          'installation-queue',
          'ps5-installation-queue',
          'selected-reinstallation',
          'maintenance-store',
        ]
          .map((name) => `export * from './server/utils/${name}';`)
          .join('\n'),
        resolveDir: resolve('.'),
      },
      outfile: bundle,
      platform: 'node',
      format: 'esm',
      bundle: true,
      logLevel: 'silent',
    });
    // A separate process keeps simulated console HTTP in force even if an assertion
    // fails while a production worker is awaiting its next poll.
    const result = spawnSync(
      process.execPath,
      ['server/tests/fixtures/mixed-device-installation-runner.mjs', bundle, work],
      {
        encoding: 'utf8',
        timeout: 45000,
        env: {
          ...process.env,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --experimental-transform-types`.trim(),
        },
      },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const proof = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(proof.devices, 3);
    assert.equal(new Set(proof.initialQueueIds).size, 3);
    assert.deepEqual(proof.initialPs5Bytes, [262144, 524288]);
    assert.equal(proof.cancelledDestinations, 1);
    assert.equal(
      proof.ps4Installs,
      4,
      'base and patch both installed before and after approved replacement',
    );
    assert.equal(
      proof.ps5AInstalls,
      2,
      'cancelled transfer was not installed; retry and approved reinstall were',
    );
    assert.equal(proof.ps5BInstalls, 1);
    assert.equal(proof.ps4Removals, 1);
    assert.equal(proof.keysPreserved, true);
    assert.equal(proof.allFinished, true);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
