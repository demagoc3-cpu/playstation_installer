import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createError } from 'h3';

test('app updates: compares with the latest GitHub release and keeps the setting', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-app-updates-')),
    previous = {
      data: process.env.PACKAGEFLOW_DATA_DIR,
      version: process.env.PACKAGEFLOW_VERSION,
      fetch: globalThis.fetch,
      error: globalThis.createError,
    };
  process.env.PACKAGEFLOW_DATA_DIR = join(work, 'data');
  mkdirSync(process.env.PACKAGEFLOW_DATA_DIR);
  process.env.PACKAGEFLOW_VERSION = '1.10.38';
  globalThis.createError = createError;
  try {
    const bundle = join(work, 'updates.mjs');
    await build({
      entryPoints: [resolve('server/utils/app-updates.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const api = await import(pathToFileURL(bundle).href);
    assert.equal(api.compareVersions('1.10.39', '1.10.38'), 1);
    assert.equal(api.compareVersions('1.9.99', '1.10.0'), -1);
    assert.equal(api.compareVersions('2.0.0', '2.0.0'), 0);

    let tag = 'v1.10.39';
    let status = 200;
    globalThis.fetch = async (url) => {
      assert.match(String(url), /\/releases\/latest$/);
      return new Response(
        JSON.stringify({
          tag_name: tag,
          html_url: `https://github.com/x/y/releases/tag/${tag}`,
          published_at: '2026-10-25T10:00:00Z',
        }),
        { status },
      );
    };
    const before = api.appUpdateState();
    assert.equal(before.installed, '1.10.38');
    assert.equal(before.available, false, 'nothing is known before a check');
    assert.equal(before.autoCheck, true, 'automatic checks are on by default');

    const newer = await api.checkAppUpdates();
    assert.equal(newer.available, true);
    assert.equal(newer.latest.version, '1.10.39');

    tag = 'v1.10.38';
    assert.equal((await api.checkAppUpdates()).available, false, 'same version: no notice');

    status = 500;
    const failed = await api.checkAppUpdates();
    assert.match(failed.error, /500/);
    assert.equal(failed.latest.version, '1.10.38', 'the last known release is kept');

    assert.equal(api.saveAppUpdateSettings({ autoCheck: false }).autoCheck, false);
    assert.equal(api.getAppUpdateSettings().autoCheck, false);
    assert.throws(() => api.saveAppUpdateSettings({ autoCheck: 'yes' }), /автоматически/);
  } finally {
    globalThis.fetch = previous.fetch;
    globalThis.createError = previous.error;
    for (const [key, env] of [
      ['PACKAGEFLOW_DATA_DIR', previous.data],
      ['PACKAGEFLOW_VERSION', previous.version],
    ])
      if (env === undefined) delete process.env[key];
      else process.env[key] = env;
    rmSync(work, { recursive: true, force: true });
  }
});
