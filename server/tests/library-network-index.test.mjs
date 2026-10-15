import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createError } from 'h3';

test('575-game pages and cached covers never probe 2895 network sources; delivery still validates its source', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-network-index-')),
    oldData = process.env.PACKAGEFLOW_DATA_DIR;
  const fs = createRequire(import.meta.url)('node:fs'),
    oldExists = fs.existsSync;
  const names = ['createError', 'defineEventHandler', 'getQuery', 'setHeader'];
  const previous = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  process.env.PACKAGEFLOW_DATA_DIR = join(work, 'data');
  mkdirSync(process.env.PACKAGEFLOW_DATA_DIR);
  let probes = 0;
  try {
    fs.existsSync = (path) => {
      if (String(path).startsWith('/offline-nas/')) {
        probes++;
        return false;
      }
      return oldExists(path);
    };
    syncBuiltinESMExports();
    Object.assign(globalThis, { createError: createError });
    Object.assign(globalThis, { defineEventHandler: (handler) => handler });
    Object.assign(globalThis, { getQuery: (event) => event.query });
    Object.assign(globalThis, { setHeader: () => {} });
    const cover = join(work, 'cover.png'),
      empty = join(work, 'empty.png'),
      png = Buffer.from('89504e470d0a1a0a', 'hex');
    writeFileSync(cover, png);
    writeFileSync(empty, '');
    const packages = Array.from({ length: 2895 }, (_, i) => {
      const game = i < 2875 ? Math.floor(i / 5) : 0,
        part = i < 2875 ? i % 5 : i - 2875 + 5;
      return {
        id: `pkg-${i}`,
        path: `/offline-nas/game-${i}.pkg`,
        libraryRoot: '/offline-nas',
        fileName: `game-${i}.pkg`,
        title: part ? 'DLC' : `Game ${game}`,
        titleId: `CUSA${String(game).padStart(5, '0')}`,
        contentId: `CONTENT-${i}`,
        platform: 'ps4',
        format: 'pkg',
        contentType: part ? 'PS4AC' : 'PS4GD',
        type: part ? 'DLC' : 'Игра',
        installOrder: part ? 2 : 0,
        appVersion: '01.00',
        size: 1024,
        sourceModifiedAt: 1,
        packageDigest: String(i),
        iconSize: part ? 0 : png.length,
        icon: { offset: 0, size: part ? 0 : png.length },
        coverPath: part ? undefined : game === 1 ? empty : cover,
      };
    });
    writeFileSync(
      join(process.env.PACKAGEFLOW_DATA_DIR, 'package-library.json'),
      JSON.stringify({ version: 2, packages, deliveries: {} }),
    );
    const bundle = join(work, 'integration.mjs');
    await build({
      stdin: {
        contents: `export * from './server/utils/package-library'; export * from './server/utils/console-profiles'; export { default as catalog } from './server/api/catalog/v2/index.get';`,
        resolveDir: resolve('.'),
      },
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const api = await import(pathToFileURL(bundle).href);
    const profile = api.saveConsoleProfile({ name: 'PS5', ip: '192.168.1.5', platform: 'ps5' })
      .consoles[0];
    const ids = [];
    for (let offset = 0; offset < 575; offset += 10) {
      const page = api.catalog({ query: { consoleId: profile.id, offset, limit: 10 } });
      assert.equal(page.offset, offset);
      assert.equal(page.total, 575);
      assert.equal(page.games.length, Math.min(10, 575 - offset));
      assert.equal(page.nextOffset, offset + page.games.length);
      assert.equal(page.hasMore, offset + page.games.length < 575);
      ids.push(...page.games.map((game) => game.id));
      assert.ok(!JSON.stringify(page).includes('/offline-nas'), 'private paths stay server-side');
    }
    assert.equal(new Set(ids).size, 575);
    assert.equal(probes, 0, 'all pages use the scan index without live NAS calls');
    const stream = api.getPackageIconStream('pkg-0'),
      chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), png);
    assert.deepEqual(await api.readPackageIcon('pkg-0'), png);
    assert.equal(probes, 0, 'cached cover serves while its source is offline');
    assert.throws(
      () => api.getPackageIconStream('pkg-5'),
      (error) => error.statusCode === 404,
      'empty PNG cache never returns HTTP 200 with no body',
    );
    assert.equal(await api.readPackageIcon('pkg-5'), undefined);
    assert.throws(
      () => api.getPackage('pkg-0'),
      (error) => error.statusCode === 404,
    );
    assert.ok(probes > 0, 'actual delivery still checks source availability');
    api.removePackageFromLibrary('pkg-0');
    assert.ok(
      !api.getLibraryPackages().some((item) => item.id === 'pkg-0'),
      'index edits invalidate display data',
    );
  } finally {
    fs.existsSync = oldExists;
    syncBuiltinESMExports();
    for (const name of names) {
      if (previous[name] === undefined) delete globalThis[name];
      else globalThis[name] = previous[name];
    }
    if (oldData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = oldData;
    rmSync(work, { recursive: true, force: true });
  }
});
