import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, open, rm, utimes, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { blake3 } from '@noble/hashes/blake3.js';
const root = await mkdtemp(join(tmpdir(), 'pf-hash-cache-')),
  previous = process.env.PACKAGEFLOW_DATA_DIR;
process.env.PACKAGEFLOW_DATA_DIR = join(root, 'data');
const bundle = join(root, 'test.mjs');
await build({
  stdin: {
    contents:
      "export * from './server/utils/ps5-source-hash-cache'; export * from './server/utils/ps5-source-hash-history'; export * from './server/utils/ps5-source-hash'; export * from './server/utils/ps5-folder-driver';",
    resolveDir: resolve('.'),
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});
const api = await import(pathToFileURL(bundle).href),
  signal = new AbortController().signal;
const digest = (data) => Buffer.from(blake3(data)).toString('hex');
const counted = (file) => {
  let reads = 0;
  return {
    handle: {
      stat: file.stat.bind(file),
      read: async (...args) => {
        reads++;
        return file.read(...args);
      },
    },
    count: () => reads,
  };
};
test('PKG cache survives a new instance and serves another console without bulk rereads', async () => {
  const source = join(root, 'own.pkg'),
    data = Buffer.alloc(2 * 1024 * 1024 + 13, 11);
  await writeFile(source, data);
  const file = await open(source, 'r');
  try {
    const view = counted(file),
      identity = api.ps5SourceStamp(await file.stat()),
      cache = new api.Ps5SourceHashCache(source);
    assert.equal(
      await api.cachedPs5SourceHash(
        cache,
        '.',
        view.handle,
        data.length,
        identity,
        signal,
        () => {},
      ),
      digest(data),
    );
    assert.equal(view.count(), 3);
    cache.flush();
    const savedAt = (await stat(cache.path)).mtimeMs;
    const second = new api.Ps5SourceHashCache(source),
      positions = [];
    assert.equal(
      await api.cachedPs5SourceHash(second, '.', view.handle, data.length, identity, signal, (n) =>
        positions.push(n),
      ),
      digest(data),
    );
    second.flush();
    assert.equal(view.count(), 3);
    assert.deepEqual(positions, [data.length]);
    assert.equal(
      (await stat(cache.path)).mtimeMs,
      savedAt,
      'cache hits do not rewrite the database',
    );
    await writeFile(cache.path, '{broken');
    assert.equal(
      await api.cachedPs5SourceHash(
        new api.Ps5SourceHashCache(source),
        '.',
        view.handle,
        data.length,
        identity,
        signal,
        () => {},
      ),
      digest(data),
    );
    assert.equal(view.count(), 6, 'invalid cache falls back to a real hash');
  } finally {
    await file.close();
  }
});
test('same-length edit with restored mtime invalidates the cache; aborted hashes are not saved', async () => {
  const source = join(root, 'changed.pkg'),
    data = Buffer.alloc(2 * 1024 * 1024, 12);
  await writeFile(source, data);
  let file = await open(source, 'r'),
    initial = await file.stat();
  const cache = new api.Ps5SourceHashCache(source);
  try {
    await api.cachedPs5SourceHash(
      cache,
      '.',
      file,
      data.length,
      api.ps5SourceStamp(initial),
      signal,
      () => {},
    );
    cache.flush();
  } finally {
    await file.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  const modified = Buffer.alloc(data.length, 42);
  await writeFile(source, modified);
  await utimes(source, initial.atime, initial.mtime);
  file = await open(source, 'r');
  try {
    const view = counted(file),
      current = await file.stat(),
      fresh = new api.Ps5SourceHashCache(source);
    assert.equal(
      await api.cachedPs5SourceHash(
        fresh,
        '.',
        view.handle,
        modified.length,
        api.ps5SourceStamp(current),
        signal,
        () => {},
      ),
      digest(modified),
    );
    assert.equal(view.count(), 2);
    const cancel = new AbortController(),
      cancelledCache = new api.Ps5SourceHashCache(join(root, 'cancelled'));
    await assert.rejects(
      api.cachedPs5SourceHash(
        cancelledCache,
        '.',
        view.handle,
        modified.length,
        api.ps5SourceStamp(current),
        cancel.signal,
        () => cancel.abort(new Error('cancel hash')),
      ),
      /cancel hash/,
    );
    cancelledCache.flush();
    assert.equal(cancelledCache.get('.', current), undefined);
  } finally {
    await file.close();
  }
});
test('Folder keeps per-file hashes, rehashes only changed files and creates fresh transfer IDs', async () => {
  const source = join(root, 'folder');
  await mkdir(join(source, 'sce_sys'), { recursive: true });
  const param = JSON.stringify({
    titleId: 'PPSA95001',
    contentId: 'IV0000-PPSA95001_00-PACKAGEFLOWUI001',
    contentVersion: '01.000.001',
  });
  const boot = join(source, 'eboot.bin');
  await writeFile(boot, Buffer.alloc(700000, 3));
  await writeFile(join(source, 'sce_sys/param.json'), param);
  await writeFile(join(source, 'empty'), '');
  const item = {
    platform: 'ps5',
    format: 'folder',
    order: 0,
    size: 700000 + Buffer.byteLength(param),
    titleId: 'PPSA95001',
    contentId: 'IV0000-PPSA95001_00-PACKAGEFLOWUI001',
    appVersion: '01.000.001',
    transferId: 'a'.repeat(32),
  };
  const first = await api.createFolderPlan(source, item, signal, () => {});
  const probe = await open(boot, 'r'),
    proto = Object.getPrototypeOf(probe),
    original = proto.read;
  await probe.close();
  let bulkReads = 0;
  proto.read = async function (...args) {
    if ((await this.stat()).size === 700000) bulkReads++;
    return original.apply(this, args);
  };
  try {
    const nextItem = { ...item, transferId: 'b'.repeat(32) },
      next = await api.createFolderPlan(source, nextItem, signal, () => {});
    assert.equal(bulkReads, 0);
    assert.deepEqual(
      next.entries.map((e) => e.hash),
      first.entries.map((e) => e.hash),
    );
    assert.notEqual(
      next.entries.find((e) => e.path === 'eboot.bin').id,
      first.entries.find((e) => e.path === 'eboot.bin').id,
    );
    assert.notEqual(next.manifestHash, first.manifestHash);
    const before = await stat(boot);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(boot, Buffer.alloc(700000, 5));
    await utimes(boot, before.atime, before.mtime);
    const changed = await api.createFolderPlan(
      source,
      { ...item, transferId: 'c'.repeat(32) },
      signal,
      () => {},
    );
    assert.equal(bulkReads, 1);
    assert.notEqual(
      changed.entries.find((e) => e.path === 'eboot.bin').hash,
      first.entries.find((e) => e.path === 'eboot.bin').hash,
    );
    assert.equal(
      changed.entries.find((e) => e.path === 'sce_sys/param.json').hash,
      first.entries.find((e) => e.path === 'sce_sys/param.json').hash,
    );
  } finally {
    proto.read = original;
  }
});
test('historical installed PKG digest is imported only for an unchanged source predating the installation', async () => {
  const source = join(root, 'historic.pkg'),
    data = Buffer.alloc(1024, 18);
  await writeFile(source, data);
  const file = await open(source, 'r');
  try {
    const initial = await file.stat(),
      timestamp = Date.now() + 1,
      folder = join(process.env.PACKAGEFLOW_DATA_DIR, 'consoles', 'old');
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, 'ps5-installation-queue.json'),
      JSON.stringify({
        version: 1,
        createdAt: timestamp,
        items: [
          {
            state: 'installed',
            format: 'pkg',
            packageId: 'old',
            sourceStamp: api.ps5SourceStamp(initial),
            hash: digest(data),
          },
        ],
        history: [],
      }),
    );
    const cache = new api.Ps5SourceHashCache(source),
      view = counted(file);
    await api.seedPs5SourceHashHistory(cache, signal, 'old');
    assert.equal(
      await api.cachedPs5SourceHash(
        cache,
        '.',
        view.handle,
        data.length,
        api.ps5SourceStamp(initial),
        signal,
        () => {},
      ),
      digest(data),
    );
    assert.equal(view.count(), 0);
    const edited = Buffer.alloc(1024, 19);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(source, edited);
    await utimes(source, initial.atime, initial.mtime);
    const current = await file.stat(),
      stale = new api.Ps5SourceHashCache(source);
    await api.seedPs5SourceHashHistory(stale, signal, 'old');
    assert.equal(
      await api.cachedPs5SourceHash(
        stale,
        '.',
        view.handle,
        data.length,
        api.ps5SourceStamp(current),
        signal,
        () => {},
      ),
      digest(edited),
    );
    assert.equal(view.count(), 1);
  } finally {
    await file.close();
  }
});
test.after(async () => {
  if (previous === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
  else process.env.PACKAGEFLOW_DATA_DIR = previous;
  await rm(root, { recursive: true, force: true });
});

test('historical Folder hashes migrate without reusing old manifest IDs; history without a date is not trusted', async () => {
  const source = join(root, 'historic-folder');
  await mkdir(join(source, 'sce_sys'), { recursive: true });
  const param = JSON.stringify({
    titleId: 'PPSA95002',
    contentId: 'IV0000-PPSA95002_00-PACKAGEFLOWUI001',
    contentVersion: '01.000.001',
  });
  const boot = join(source, 'eboot.bin');
  await writeFile(boot, Buffer.alloc(700000, 8));
  await writeFile(join(source, 'sce_sys/param.json'), param);
  const item = {
    platform: 'ps5',
    format: 'folder',
    state: 'installed',
    order: 0,
    size: 700000 + Buffer.byteLength(param),
    titleId: 'PPSA95002',
    contentId: 'IV0000-PPSA95002_00-PACKAGEFLOWUI001',
    appVersion: '01.000.001',
    transferId: 'd'.repeat(32),
    createdAt: Date.now() + 1,
  };
  const first = await api.createFolderPlan(source, item, signal, () => {});
  const cache = new api.Ps5SourceHashCache(source);
  await rm(cache.path);
  const folder = join(process.env.PACKAGEFLOW_DATA_DIR, 'consoles', 'historic-folder');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${item.transferId}.folder-plan.json`), JSON.stringify(first));
  await writeFile(
    join(folder, 'ps5-installation-queue.json'),
    JSON.stringify({
      version: 1,
      createdAt: item.createdAt,
      items: [{ ...item, hash: first.manifestHash }],
      history: [],
    }),
  );
  const file = await open(boot, 'r');
  try {
    const view = counted(file),
      fresh = new api.Ps5SourceHashCache(source),
      initial = await file.stat();
    await api.seedPs5SourceHashHistory(fresh, signal);
    assert.equal(
      await api.cachedPs5SourceHash(
        fresh,
        'eboot.bin',
        view.handle,
        initial.size,
        api.ps5SourceStamp(initial),
        signal,
        () => {},
      ),
      first.entries.find((e) => e.path === 'eboot.bin').hash,
    );
    assert.equal(view.count(), 0);
    await writeFile(
      join(folder, 'ps5-installation-queue.json'),
      JSON.stringify({
        version: 1,
        createdAt: Date.now() + 1000,
        items: [],
        history: [[{ ...item, createdAt: undefined, hash: first.manifestHash }]],
      }),
    );
    const uncertain = new api.Ps5SourceHashCache(source);
    await api.seedPs5SourceHashHistory(uncertain, signal);
    assert.equal(
      uncertain.get('eboot.bin', initial),
      undefined,
      'a new queue date cannot be attributed to older history',
    );
    const tampered = {
      ...first,
      entries: first.entries.map((e) =>
        e.path === 'eboot.bin' ? { ...e, hash: 'f'.repeat(64) } : e,
      ),
    };
    await writeFile(join(folder, `${item.transferId}.folder-plan.json`), JSON.stringify(tampered));
    await writeFile(
      join(folder, 'ps5-installation-queue.json'),
      JSON.stringify({
        version: 1,
        createdAt: item.createdAt,
        items: [{ ...item, hash: first.manifestHash }],
        history: [],
      }),
    );
    const invalid = new api.Ps5SourceHashCache(source);
    await api.seedPs5SourceHashHistory(invalid, signal);
    assert.equal(
      invalid.get('eboot.bin', initial),
      undefined,
      'corrupt saved plans cannot seed the cache',
    );
  } finally {
    await file.close();
  }
});
