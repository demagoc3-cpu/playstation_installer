import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBLAKE3 } from 'hash-wasm';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier))
        return next(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const { ps5SourceHash, ps5SourceStamp } = await import('../utils/ps5-source-hash.ts');
const { ps5HashFileInWorker } = await import('../utils/ps5-hash-worker.ts');

test('BLAKE3 of a package is computed off the main thread with the same digest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-hash-worker-'));
  try {
    const path = join(dir, 'game.pkg'),
      bytes = randomBytes(48 * 1024 * 1024 + 123);
    writeFileSync(path, bytes);
    const direct = await createBLAKE3(256);
    direct.update(bytes);
    const expected = direct.digest('hex');

    const file = await open(path);
    try {
      let ticks = 0;
      const timer = setInterval(() => ticks++, 1);
      const seen: number[] = [];
      const digest = await ps5SourceHash(
        file,
        bytes.length,
        ps5SourceStamp(await file.stat()),
        new AbortController().signal,
        (n) => seen.push(n),
      );
      clearInterval(timer);
      assert.equal(digest, expected);
      assert.equal(seen[0], 0);
      assert.equal(seen.at(-1), bytes.length);
      assert.ok(ticks > 5, `the main thread kept running during hashing (${ticks} ticks)`);

      const aborted = new AbortController();
      const pending = ps5HashFileInWorker(file.fd, bytes.length, aborted.signal, () => {})!;
      assert.ok(pending, 'a worker starts in this environment');
      aborted.abort(new Error('cancelled'));
      await assert.rejects(pending, /cancelled/);

      await assert.rejects(
        ps5HashFileInWorker(file.fd, bytes.length + 10, new AbortController().signal, () => {})!,
        /обрезан/,
      );
    } finally {
      await file.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
