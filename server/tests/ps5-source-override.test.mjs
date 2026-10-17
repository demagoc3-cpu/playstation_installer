import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

test('the owner can allow unverified game file changes on one PS5 only, and turn it off', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-ps5-source-override-')),
    previous = process.env.PACKAGEFLOW_DATA_DIR;
  process.env.PACKAGEFLOW_DATA_DIR = join(work, 'data');
  mkdirSync(process.env.PACKAGEFLOW_DATA_DIR);
  let reported = { consoleControl: true, consoleSourceControl: false };
  globalThis.pfOverrideTest = {
    profile(id) {
      if (id === 'ps4') return { id, platform: 'ps4', ip: '192.168.1.4' };
      return { id, platform: 'ps5', ip: id === 'a' ? '192.168.1.5' : '192.168.1.6' };
    },
    async operation(_id, path) {
      assert.equal(path, '/api/v1/management/status');
      return {
        status: 200,
        body: { protocol: 'ps5-management-v1', ready: true, ...reported },
      };
    },
  };
  try {
    const bundle = join(work, 'api.cjs');
    await build({
      entryPoints: ['server/utils/ps5-management.ts'],
      outfile: bundle,
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
            b.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
              contents: args.path.endsWith('console-profiles')
                ? 'export const getConsoleProfile=id=>globalThis.pfOverrideTest.profile(id);export const ps5OperationRequest=(...args)=>globalThis.pfOverrideTest.operation(...args);export const ps5SaveChunk=()=>{throw Error("unused")}'
                : args.path.endsWith('package-library')
                  ? 'export const getLibraryPackages=()=>[]'
                  : args.path.endsWith('ps5-installation-queue')
                    ? 'export const getPs5Queue=()=>({items:[]})'
                    : 'export const assertNoPs5ServiceUpdate=()=>{}',
              loader: 'js',
            }));
          },
        },
      ],
    });
    const api = createRequire(import.meta.url)(bundle);

    let status = await api.managementStatus('a');
    assert.equal(status.consoleSourceControl, false);
    assert.equal(status.consoleSourceControlOverride, false);

    assert.throws(() => api.setPs5SourceControlOverride('a', 'yes'));
    assert.throws(() => api.setPs5SourceControlOverride('ps4', true));

    assert.deepEqual(api.setPs5SourceControlOverride('a', true), {
      consoleId: 'a',
      consoleSourceControlOverride: true,
    });
    status = await api.managementStatus('a');
    assert.equal(status.consoleSourceControl, true);
    assert.equal(status.consoleSourceControlVerified, false);
    assert.equal(status.consoleSourceControlOverride, true);
    // Launch control and image unpacking keep their own service checks.
    assert.equal(status.consoleUnpack, false);

    // Another PS5 is unaffected.
    status = await api.managementStatus('b');
    assert.equal(status.consoleSourceControl, false);
    assert.equal(status.consoleSourceControlOverride, false);

    // A verified service needs no override and does not report one.
    reported = { consoleControl: true, consoleSourceControl: true };
    status = await api.managementStatus('a');
    assert.equal(status.consoleSourceControl, true);
    assert.equal(status.consoleSourceControlVerified, true);
    assert.equal(status.consoleSourceControlOverride, false);

    reported = { consoleControl: true, consoleSourceControl: false };
    api.setPs5SourceControlOverride('a', false);
    status = await api.managementStatus('a');
    assert.equal(status.consoleSourceControl, false);
    assert.equal(status.consoleSourceControlOverride, false);
  } finally {
    delete globalThis.pfOverrideTest;
    if (previous === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = previous;
    rmSync(work, { recursive: true, force: true });
  }
});
