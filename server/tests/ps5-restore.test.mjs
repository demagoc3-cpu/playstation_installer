import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createBLAKE3 } from 'hash-wasm';
const id = () => randomBytes(16).toString('hex');
test('PS5 restore verifies backup, binds profile/layout, stages bytes, reconciles a lost apply response and preserves rollback', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-restore-web-')),
    previous = process.env.PACKAGEFLOW_DATA_DIR;
  process.env.PACKAGEFLOW_DATA_DIR = join(work, 'data');
  const target = { userId: 'abcdef01', titleId: 'PPSA00001', kind: 'native' },
    data = Buffer.from('encrypted container fixture'),
    transfers = new Map(),
    receipts = new Map();
  let applyCount = 0,
    lose = false,
    corruptReceipt = false;
  const entry = {
    path: 'sdimg_slot',
    fileId: 'a'.repeat(64),
    directory: false,
    bytes: data.length,
  };
  globalThis.pfRestoreFixture = {
    profile: (id) => ({ id, platform: 'ps5', ip: id === 'a' ? '192.168.1.5' : '192.168.1.6' }),
    chunk: async () => data,
    operation: async (consoleId, path, h, body) => {
      assert.equal(consoleId, 'a');
      const key = h?.['X-PackageFlow-Transfer-Id'],
        request = h?.['X-PackageFlow-Request-Id'];
      if (path === '/api/v1/management/status')
        return {
          status: 200,
          body: {
            protocol: 'ps5-management-v1',
            ready: true,
            catalog: true,
            savesList: true,
            savesBackup: true,
            savesRestore: true,
          },
        };
      if (path === '/api/v1/saves/manifest')
        return {
          status: 200,
          body: {
            snapshot: 'c'.repeat(64),
            offset: 0,
            total: 1,
            bytes: data.length,
            next: 1,
            done: true,
            entries: [entry],
          },
        };
      if (path === '/api/v1/transfers/begin') {
        transfers.set(key, {
          id: key,
          size: Number(h['X-PackageFlow-Size']),
          blake3: h['X-PackageFlow-Blake3'],
          bytesDurable: 0,
          cancelled: false,
          verified: false,
          data: Buffer.alloc(0),
        });
        return { status: 200, body: transfers.get(key) };
      }
      if (path === '/api/v1/transfers/chunk') {
        const v = transfers.get(key);
        assert.equal(Number(h['X-PackageFlow-Offset']), v.bytesDurable);
        v.data = Buffer.concat([v.data, body]);
        v.bytesDurable = v.data.length;
        return { status: 200, body: v };
      }
      if (path === '/api/v1/transfers/commit') {
        const v = transfers.get(key),
          b3 = await createBLAKE3(256);
        b3.init();
        b3.update(v.data);
        assert.equal(b3.digest('hex'), v.blake3);
        v.verified = true;
        return { status: 202, body: { accepted: true } };
      }
      if (path === '/api/v1/transfers/status') return { status: 200, body: transfers.get(key) };
      if (path === '/api/v1/saves/restore') {
        applyCount++;
        assert.match(
          body.toString(),
          /^PFSAVERESTORE1 abcdef01 PPSA00001 native c{64} 1\nF [a-f0-9]{32} [a-f0-9]{64} \d+ 7364696d675f736c6f74\n$/,
        );
        const v = { requestId: request, ...target, state: 'pending' };
        receipts.set(request, v);
        if (lose) throw Error('lost response');
        return { status: 200, body: v };
      }
      if (path === '/api/v1/saves/restore/status')
        return {
          status: 200,
          body: { ...receipts.get(request), ...(corruptReceipt ? { titleId: 'PPSA99999' } : {}) },
        };
      if (path === '/api/v1/saves/rollback' || path === '/api/v1/saves/finalize') {
        const v = {
          requestId: request,
          ...target,
          state: path.endsWith('/rollback') ? 'rolled-back' : 'finalized',
        };
        receipts.set(request, v);
        return { status: 200, body: v };
      }
      throw Error('Unknown route ' + path);
    },
  };
  try {
    const outfile = join(work, 'api.cjs');
    await build({
      entryPoints: ['server/utils/ps5-management.ts'],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
      plugins: [
        {
          name: 'fixture',
          setup(b) {
            b.onResolve(
              {
                filter:
                  /^\.\/(console-profiles|package-library|ps5-installation-queue|ps5-service-updates)$/,
              },
              (args) => ({ path: args.path, namespace: 'fixture' }),
            );
            b.onLoad({ filter: /.*/, namespace: 'fixture' }, (a) => ({
              contents: a.path.endsWith('console-profiles')
                ? 'export const getConsoleProfile=(...a)=>globalThis.pfRestoreFixture.profile(...a);export const ps5OperationRequest=(...a)=>globalThis.pfRestoreFixture.operation(...a);export const ps5SaveChunk=(...a)=>globalThis.pfRestoreFixture.chunk(...a)'
                : a.path.endsWith('package-library')
                  ? 'export const getLibraryPackages=()=>[]'
                  : a.path.endsWith('ps5-installation-queue')
                    ? 'export const getPs5Queue=()=>({items:[]})'
                    : 'export const assertNoPs5ServiceUpdate=()=>{}',
              loader: 'js',
            }));
          },
        },
      ],
    });
    const api = createRequire(import.meta.url)(outfile);
    async function waitJob(request, type) {
      for (let i = 0; i < 300; i++) {
        const j =
          type === 'copy' ? api.ps5BackupJob('a', request) : await api.ps5RestoreJob('a', request);
        if (
          type === 'copy'
            ? j.state !== 'running'
            : !['checking', 'uploading', 'applying'].includes(j.state)
        )
          return j;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw Error('timeout');
    }
    const copyId = id();
    api.startPs5Backup('a', target, copyId);
    const copy = await waitJob(copyId, 'copy');
    assert.equal(copy.state, 'complete');
    assert.throws(
      () => api.startPs5Restore('b', copy.backupId, id(), target.titleId),
      /другой приставке/,
    );
    assert.throws(() => api.startPs5Restore('a', copy.backupId, id(), 'PPSA99999'), /Подтвердите/);
    const file = join(
      process.env.PACKAGEFLOW_DATA_DIR,
      'ps5-save-backups',
      copy.backupId,
      'files',
      entry.path,
    );
    writeFileSync(file, 'broken');
    const bad = id();
    api.startPs5Restore('a', copy.backupId, bad, target.titleId);
    assert.equal((await waitJob(bad)).state, 'failed');
    assert.equal(applyCount, 0);
    writeFileSync(file, data);
    const first = id();
    lose = true;
    api.startPs5Restore('a', copy.backupId, first, target.titleId);
    const restored = await waitJob(first);
    assert.equal(restored.state, 'pending');
    assert.equal(applyCount, 1);
    assert.equal(restored.bytes, data.length);
    assert.throws(() => api.startPs5Backup('a', target, id()), /восстановление/);
    assert.equal(api.startPs5Restore('a', copy.backupId, first, target.titleId).id, first);
    assert.equal(applyCount, 1, 'repeat reads the durable job only');
    assert.equal(
      (await api.finishPs5Restore('a', first, 'rollback', target.titleId)).state,
      'rolled-back',
    );
    const last = id();
    lose = false;
    api.startPs5Restore('a', copy.backupId, last, target.titleId);
    assert.equal((await waitJob(last)).state, 'pending');
    assert.equal(
      (await api.finishPs5Restore('a', last, 'finalize', target.titleId)).state,
      'confirmed',
    );
    assert.deepEqual(readFileSync(file), data, 'backup survives finalize');
    const manifest = JSON.parse(
      readFileSync(
        join(process.env.PACKAGEFLOW_DATA_DIR, 'ps5-save-backups', copy.backupId, 'metadata.json'),
        'utf8',
      ),
    );
    assert.throws(
      () =>
        api.buildPs5RestoreManifest(
          target,
          { snapshot: 'c'.repeat(64), entries: [], bytes: 0 },
          manifest,
          [],
        ),
      /Состав/,
    );
    const uncertain = id();
    lose = true;
    corruptReceipt = true;
    api.startPs5Restore('a', copy.backupId, uncertain, target.titleId);
    assert.equal((await waitJob(uncertain)).state, 'uncertain');
    assert.equal(applyCount, 3);
    corruptReceipt = false;
    assert.equal((await api.ps5RestoreJob('a', uncertain)).state, 'pending');
    await api.finishPs5Restore('a', uncertain, 'rollback', target.titleId);
  } finally {
    delete globalThis.pfRestoreFixture;
    if (previous === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = previous;
    rmSync(work, { recursive: true, force: true });
  }
});
