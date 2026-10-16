import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

test('two WEB processes cannot run the same console worker; a dead owner is recoverable', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-worker-lock-')),
    previous = process.env.PACKAGEFLOW_DATA_DIR;
  process.env.PACKAGEFLOW_DATA_DIR = work;
  try {
    const bundle = join(work, 'lock.mjs');
    await build({
      entryPoints: [resolve('server/utils/console-worker-lock.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const url = pathToFileURL(bundle).href,
      { claimConsoleWorker } = await import(url);
    const release = claimConsoleWorker('installation', '192.168.1.4');
    assert.ok(release);
    const child = (code) =>
      spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {claimConsoleWorker} from ${JSON.stringify(url)};${code}`,
        ],
        { encoding: 'utf8', timeout: 10000 },
      );
    const blocked = child(
      "console.log(!!claimConsoleWorker('installation','192.168.1.4'));const other=claimConsoleWorker('installation','192.168.1.5');console.log(!!other);other?.()",
    );
    assert.equal(blocked.status, 0, blocked.stderr);
    assert.equal(blocked.stdout.trim(), 'false\ntrue');
    release();
    const dead = child("console.log(!!claimConsoleWorker('installation','192.168.1.4'))");
    assert.equal(dead.status, 0, dead.stderr);
    assert.equal(dead.stdout.trim(), 'true');
    const recovered = claimConsoleWorker('installation', '192.168.1.4');
    assert.ok(recovered);
    recovered();
  } finally {
    if (previous === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = previous;
    rmSync(work, { recursive: true, force: true });
  }
});
