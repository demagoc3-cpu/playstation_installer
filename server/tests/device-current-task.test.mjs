import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createError } from 'h3';

test('device activity carries the task in progress for a collapsed device heading', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-device-current-')),
    previousData = process.env.PACKAGEFLOW_DATA_DIR,
    previousError = globalThis.createError,
    previousFetch = globalThis.fetch;
  process.env.PACKAGEFLOW_DATA_DIR = join(work, 'data');
  mkdirSync(process.env.PACKAGEFLOW_DATA_DIR);
  globalThis.createError = createError;
  // Nothing here may reach a console.
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  try {
    const bundle = join(work, 'activity.mjs');
    await build({
      stdin: {
        contents:
          "export * from './server/utils/device-installation'; export * from './server/utils/console-profiles';",
        resolveDir: resolve('.'),
      },
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const api = await import(pathToFileURL(bundle).href);
    const ip = '192.168.1.77';
    const profile = api
      .saveConsoleProfile({ name: 'PS5 test', platform: 'ps5', ip })
      .consoles.find((c) => c.ip === ip);
    const item = (packageId, state, bytesSent, extra = {}) => ({
      packageId,
      title: packageId,
      fileName: `${packageId}.pkg`,
      size: 1000,
      type: 'Игра',
      titleId: 'PPSA95001',
      platform: 'ps5',
      format: 'pkg',
      branch: `ps5:${packageId}`,
      order: 0,
      transferId: packageId
        .padEnd(32, '0')
        .slice(0, 32)
        .replace(/[^0-9a-f]/g, 'a'),
      state,
      detail: '',
      bytesSent,
      ...extra,
    });
    mkdirSync(join(process.env.PACKAGEFLOW_DATA_DIR, 'consoles', profile.id), { recursive: true });
    writeFileSync(
      join(process.env.PACKAGEFLOW_DATA_DIR, 'consoles', profile.id, 'ps5-installation-queue.json'),
      JSON.stringify({
        version: 1,
        id: 'q'.repeat(32),
        consoleId: profile.id,
        psIp: ip,
        transport: 'service',
        status: 'running',
        items: [
          item('first', 'sending', 620, { progressPhase: 'transfer' }),
          item('second', 'pending', 0),
        ],
        history: [],
        createdAt: 1,
        updatedAt: 1,
        message: '',
      }),
    );
    const entry = (await api.deviceActivitiesLive([])).find((e) => e.consoleId === profile.id);
    assert.equal(entry.counts.active, 1);
    assert.equal(entry.current?.title, 'first', 'the heading shows the transfer in progress');
    assert.equal(entry.current.bytesSent, 620);
    assert.equal(entry.current.size, 1000);
    assert.equal(entry.current.state, 'sending');
    assert.equal(entry.current.transferId, undefined, 'internal ids stay private');
    // Both unfinished packages wait; a PKG needs room for two copies.
    assert.equal(entry.space?.waitingBytes, 2000);
    assert.equal(entry.space.requiredBytes, 4000);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.createError = previousError;
    if (previousData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = previousData;
    rmSync(work, { recursive: true, force: true });
  }
});
