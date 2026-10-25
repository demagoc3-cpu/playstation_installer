import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createError } from 'h3';

test('storage cleanup lists, removes once and only reads back an unknown result', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-cleanup-')),
    previousData = process.env.PACKAGEFLOW_DATA_DIR,
    previousFetch = globalThis.fetch,
    previousError = globalThis.createError;
  const data = join(work, 'data');
  mkdirSync(data);
  process.env.PACKAGEFLOW_DATA_DIR = data;
  globalThis.createError = createError;
  try {
    const bundle = join(work, 'cleanup.mjs');
    await build({
      stdin: {
        contents:
          "export * from './server/utils/ps5-storage-cleanup'; export * from './server/utils/console-profiles';",
        resolveDir: resolve('.'),
      },
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const api = await import(pathToFileURL(bundle).href);
    const ip = '192.168.1.91';
    const profile = api
      .saveConsoleProfile({ name: 'PS5', platform: 'ps5', ip })
      .consoles.find((c) => c.ip === ip);
    writeFileSync(join(data, 'ps5-service-keys.json'), JSON.stringify({ [ip]: 'a'.repeat(64) }));
    const openTransfer = 'b'.repeat(32);
    mkdirSync(join(data, 'consoles', profile.id), { recursive: true });
    writeFileSync(
      join(data, 'consoles', profile.id, 'ps5-installation-queue.json'),
      JSON.stringify({
        version: 1,
        id: 'c'.repeat(32),
        consoleId: profile.id,
        psIp: ip,
        transport: 'service',
        status: 'paused',
        items: [
          {
            packageId: 'astro',
            title: 'Astro Bot',
            fileName: 'astro.pkg',
            size: 10,
            type: 'Игра',
            titleId: 'PPSA01234',
            platform: 'ps5',
            format: 'pkg',
            branch: 'ps5:PPSA01234',
            order: 0,
            transferId: openTransfer,
            state: 'sending',
            detail: '',
            bytesSent: 5,
          },
        ],
        history: [],
        createdAt: 1,
        updatedAt: 1,
        message: '',
      }),
    );
    const item = (n, extra = {}) => ({
      id: String(n).repeat(64),
      kind: 'transfer-partial',
      bytes: 2097152,
      modifiedAt: 1790000000,
      transferId: '',
      titleId: '',
      removable: true,
      reason: 'stale_owned',
      ...extra,
    });
    const posts = [];
    let lose = false;
    const receipts = new Map();
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    globalThis.fetch = async (url, options = {}) => {
      const path = new URL(url).pathname;
      if (path === '/api/v1/capabilities')
        return json({ service: 'PackageFlowService-PS5', capabilities: { storageCleanup: true } });
      assert.equal(path, '/api/v1/storage/cleanup');
      const requestId = options.headers?.['X-PackageFlow-Request-Id'];
      if (options.method === 'GET' && requestId)
        return receipts.has(requestId) ? json(receipts.get(requestId)) : json({}, 404);
      if (options.method === 'GET')
        return json({
          schemaVersion: 1,
          complete: false,
          freeBytes: 5000,
          freeBytesKnown: true,
          items: [item(1), item(2, { transferId: openTransfer })],
        });
      const body = JSON.parse(Buffer.from(options.body).toString('utf8'));
      posts.push(body);
      const receipt = {
        schemaVersion: 1,
        requestId: body.requestId,
        state: 'completed',
        complete: true,
        freedBytes: 2097152,
        freeBytesAfter: 7097152,
        freeBytesKnown: true,
        items: body.ids.map((id) => ({
          id,
          state: 'removed',
          reason: 'removed',
          freedBytes: 2097152,
        })),
      };
      receipts.set(body.requestId, receipt);
      if (lose) throw new Error('reply lost');
      return json(receipt);
    };
    const list = await api.ps5CleanupInventory(profile.id);
    assert.equal(list.supported, true);
    assert.equal(list.complete, false);
    assert.equal(list.freeBytes, 5000);
    assert.equal(list.items[0].removable, true);
    assert.equal(list.items[1].removable, false, 'a transfer the open queue may resume stays');
    assert.equal(list.items[1].reason, 'queue_active');
    assert.equal(list.items[1].title, 'Astro Bot');
    assert.equal(list.items[1].transferId, undefined, 'internal ids stay private');

    const first = await api.ps5CleanupRun(profile.id, [item(1).id], []);
    assert.equal(first.pending, false);
    assert.equal(first.last.items[0].state, 'removed');
    assert.equal(posts.length, 1);

    // The reply is lost: the receipt is read back, the request is not sent again.
    lose = true;
    const second = await api.ps5CleanupRun(profile.id, [item(3).id], []);
    assert.equal(posts.length, 2);
    assert.equal(second.pending, false);
    assert.equal(second.last.items[0].id, item(3).id);

    // Neither the reply nor the receipt arrives: the request stays pending and
    // blocks a new one until the PS5 answers for it.
    globalThis.fetch = async () => {
      throw new Error('offline');
    };
    const third = await api.ps5CleanupRun(profile.id, [item(4).id], []).catch((e) => e);
    assert.ok(third.pending || third.statusCode, 'unknown outcome reported');
    const journal = JSON.parse(
      readFileSync(join(data, 'consoles', profile.id, 'ps5-storage-cleanup.json'), 'utf8'),
    );
    assert.ok(journal.pending, 'the unknown request is kept');
    await assert.rejects(api.ps5CleanupRun(profile.id, [item(5).id], []), /не подтверждён/);
    assert.equal(posts.length, 2, 'nothing was sent while the result is unknown');

    await assert.rejects(api.ps5CleanupRun(profile.id, ['bad'], []), /от 1 до 16/);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.createError = previousError;
    if (previousData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = previousData;
    rmSync(work, { recursive: true, force: true });
  }
});
