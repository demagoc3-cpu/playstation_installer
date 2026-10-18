import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

test('a PS5 patch is confirmed by the live game version, a DLC by a clean installer job', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-component-'));
  try {
    const f = join(dir, 'test.mjs');
    await build({
      stdin: {
        contents: "export { ps5ComponentConfirmation } from './server/utils/ps5-queue-driver';",
        resolveDir: resolve('.'),
      },
      outfile: f,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
      banner: {
        js: "import { createRequire as __pfRequire } from 'node:module'; const require = __pfRequire(import.meta.url);",
      },
    });
    const { ps5ComponentConfirmation: confirm } = await import(pathToFileURL(f));
    const patch = {
      order: 1,
      type: 'Патч',
      titleId: 'CUSA42879',
      contentId: 'EP0700-CUSA42879_00-LITTLENIGHTMARE3',
      appVersion: '01.02',
    };
    const info = (version, extra = {}) => ({
      status: 200,
      body: {
        title_id: patch.titleId,
        installed: true,
        content_id: patch.contentId,
        version,
        ...extra,
      },
    });
    const done = { phase: 'done', code: 0 };
    assert.equal(confirm(patch, done, info('01.02')).confirmation, 'service-version');
    assert.equal(confirm(patch, done, info('01.10')).confirmation, 'service-version', 'newer');
    assert.equal(confirm(patch, done, info('01.00')), undefined, 'not applied yet');
    assert.equal(confirm(patch, done, info('01.02', { content_id: 'OTHER' })), undefined);
    assert.equal(confirm(patch, done, info('01.02', { installed: false })), undefined);
    assert.equal(confirm(patch, done, info('bad')), undefined);
    assert.equal(confirm(patch, done, { status: 503, body: {} }), undefined);
    assert.equal(confirm(patch, done, undefined), undefined);

    const dlc = { ...patch, type: 'DLC', order: 2, size: 100 };
    assert.equal(confirm(dlc, done).confirmation, 'installer-result');
    assert.equal(
      confirm(dlc, { phase: 'serving', code: 0, total: 100, bytes_served: 40 }),
      undefined,
      'still reading',
    );
    assert.equal(
      confirm(dlc, { phase: 'serving', code: 0, total: 100, bytes_served: 100 }).confirmation,
      'installer-result',
      'the last job in a queue keeps serving after a whole read',
    );
    assert.equal(confirm(dlc, { phase: 'done', code: 0x80990001 }), undefined, 'error code');

    assert.equal(
      confirm({ ...patch, order: 0 }, done, info('01.02')),
      undefined,
      'base has its own rule',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
