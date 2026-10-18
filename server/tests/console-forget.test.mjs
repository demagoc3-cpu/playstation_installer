import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

test('removal is blocked only by live work on this device, not by stale records or other consoles', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-console-forget-')),
    oldData = process.env.PACKAGEFLOW_DATA_DIR,
    oldFetch = globalThis.fetch;
  const data = join(work, 'data');
  mkdirSync(data);
  process.env.PACKAGEFLOW_DATA_DIR = data;
  // Offline consoles: every request fails like an unreachable address.
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  try {
    const out = join(work, 'api.mjs');
    await build({
      stdin: {
        contents:
          "export * from './server/utils/console-forget'; export * from './server/utils/console-profiles'; export * from './server/utils/ps5-installation-queue';",
        resolveDir: resolve('.'),
      },
      outfile: out,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
      banner: {
        js: "import { createRequire as __pfRequire } from 'node:module'; const require = __pfRequire(import.meta.url);",
      },
    });
    const api = await import(pathToFileURL(out).href);
    api.saveConsoleProfile({ name: 'Waiting PS5', ip: '192.0.2.21', platform: 'ps5' });
    api.saveConsoleProfile({ name: 'Busy PS5', ip: '192.0.2.22', platform: 'ps5' });
    const [waiting, busy] = api.getConsoleProfiles().consoles;
    const queue = (consoleId, psIp, status, state, extra = {}) => {
      mkdirSync(join(data, 'consoles', consoleId), { recursive: true });
      writeFileSync(
        join(data, 'consoles', consoleId, 'ps5-installation-queue.json'),
        JSON.stringify({
          version: 1,
          consoleId,
          psIp,
          transport: 'service',
          status,
          createdAt: 1,
          updatedAt: 2,
          message: '',
          id: consoleId.slice(0, 8).padEnd(8, 'q'),
          history: [],
          items: [
            {
              packageId: 'pkg-1',
              title: 'Game',
              fileName: 'Game.pkg',
              size: 1,
              type: 'Игра',
              titleId: 'PPSA00001',
              branch: 'ps5:PPSA00001',
              order: 0,
              platform: 'ps5',
              format: 'pkg',
              appVersion: '01.000.000',
              contentId: 'EP0000-PPSA00001_00-GAME000000000000',
              transferId: 'a'.repeat(32),
              state,
              detail: '',
              bytesSent: 0,
              createdAt: 1,
              ...extra,
            },
          ],
        }),
      );
    };
    // The other console already runs a system installation (cannot be paused).
    queue(busy.id, busy.ip, 'running', 'installing', { installDispatched: true });
    // This console waits for its offline service: removal pauses it.
    queue(waiting.id, waiting.ip, 'running', 'pending');
    // A record left behind long ago by this console no longer blocks.
    mkdirSync(join(data, 'ps5-save-restores'), { recursive: true });
    const stale = join(data, 'ps5-save-restores', '5'.repeat(32) + '.json');
    writeFileSync(stale, JSON.stringify({ consoleId: waiting.id, state: 'pending' }));
    const hourAgo = Date.now() / 1000 - 3600;
    utimesSync(stale, hourAgo, hourAgo);

    const result = await api.forgetConsole(waiting.id, true);
    assert.deepEqual(
      result.profiles.consoles.map((c) => c.id),
      [busy.id],
    );
    assert.equal(
      JSON.parse(
        readFileSync(join(data, 'consoles', waiting.id, 'ps5-installation-queue.json'), 'utf8'),
      ).status,
      'paused',
      'sending stopped before removal',
    );

    await assert.rejects(api.forgetConsole(busy.id, true), {
      statusCode: 409,
      message: /системную установку/,
    });
    assert.equal(api.getConsoleProfiles().consoles.length, 1);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = oldData;
    rmSync(work, { recursive: true, force: true });
  }
});
