import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

test('service capability flags decide orphan cleanup; a present false is final', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-qualified-builds-'));
  try {
    const f = join(dir, 'test.mjs');
    await build({
      entryPoints: [resolve('server/utils/ps5-qualified-builds.ts')],
      outfile: f,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const { ps5ClearsOwnOrphans: clears, ps5ManifestFirmware: firmware } = await import(
      pathToFileURL(f)
    );
    const b030 = 'ps5-service-capabilities-030b-sse2',
      b029e = 'ps5-service-pkg-context-029e-sse2';
    assert.equal(clears(b030, { orphanCleanup: true, systemUninstall: false }), true);
    assert.equal(clears(b030, { orphanCleanup: false, systemUninstall: true }), true);
    assert.equal(clears(b030, { orphanCleanup: false, systemUninstall: false }), false);
    assert.equal(
      clears(b029e, { orphanCleanup: false, systemUninstall: false }),
      false,
      'a present false wins over the legacy build list',
    );
    assert.equal(clears(b029e, {}), true, 'legacy build without flags');
    assert.equal(clears(b030, {}), false, 'unknown build without flags');

    for (const value of [undefined, '', '13.60', '12.20,13.60'])
      assert.equal(firmware(value), true);
    for (const value of ['any', '13.6', '13.60;', 13.6, ['13.60']])
      assert.equal(firmware(value), false, String(value));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
