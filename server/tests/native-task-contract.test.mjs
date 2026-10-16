import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

test('native PS4/PS5 task commands preserve receipts, destinations, queue attempts and accepted jobs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-native-task-')),
    previous = process.env.PACKAGEFLOW_DATA_DIR;
  process.env.PACKAGEFLOW_DATA_DIR = dir;
  try {
    const profiles = [
      { id: 'ps4-one', name: 'one', platform: 'ps4', ip: '192.168.1.4' },
      { id: 'ps4-two', name: 'two', platform: 'ps4', ip: '192.168.1.6' },
      { id: 'ps5-one', name: 'five', platform: 'ps5', ip: '192.168.1.5' },
    ];
    writeFileSync(
      join(dir, 'console-profiles.json'),
      JSON.stringify({ version: 1, activeId: null, consoles: profiles }),
    );
    writeFileSync(
      join(dir, 'package-library.json'),
      JSON.stringify({ version: 2, packages: [], deliveries: {} }),
    );
    const item = (packageId, state = 'installed') => ({
      packageId,
      titleId: 'CUSA95001',
      title: packageId,
      type: 'Игра',
      fileName: packageId + '.pkg',
      size: 100,
      bytesSent: 100,
      state,
      detail: 'receipt',
    });
    for (const ip of ['192.168.1.4', '192.168.1.6']) {
      const folder = join(dir, 'consoles', ip);
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, 'installation-queue.json'),
        JSON.stringify({
          version: 1,
          id: 'current',
          status: 'failed',
          transport: 'service',
          psIp: ip,
          items: [item('a'), item('b', 'failed'), { ...item('pending', 'pending'), bytesSent: 0 }],
        }),
      );
      writeFileSync(
        join(folder, 'installation-history.json'),
        JSON.stringify([
          {
            version: 1,
            id: 'past',
            status: 'completed',
            transport: 'service',
            psIp: ip,
            items: Array.from({ length: 61 }, (_, i) => item('past-' + i)),
          },
        ]),
      );
    }
    const bundle = join(dir, 'api.mjs');
    await build({
      stdin: {
        contents:
          "export * from './server/utils/console-app-commands'; export * from './server/utils/ps5-app-commands'; export * from './server/utils/native-task-contract'; export * from './server/utils/installation-tasks'; export * from './server/utils/installation-queue'; export * from './server/utils/ps5-installation-queue'; export * from './server/utils/ps5-queue-core';",
        resolveDir: resolve('.'),
      },
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const api = await import(pathToFileURL(bundle).href);
    const request = (n, action, extra = {}) => ({
      ip: profiles[0].ip,
      gameId: 'tasks',
      requestId: n.toString(16).padStart(32, '0'),
      action,
      ...extra,
    });
    const finish = async (body, ps5 = false) => {
      for (let n = 0; n < 100; n++) {
        const r = ps5
          ? api.ps5AppCommand(body.consoleId, body.requestId)
          : api.consoleCommand(body.requestId, body.ip);
        if (r.state !== 'pending') return r;
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.fail('receipt timed out');
    };
    const other = readFileSync(
      join(dir, 'consoles', profiles[1].ip, 'installation-queue.json'),
      'utf8',
    );
    const remove = request(1, 'remove-items', { queueId: 'current', packageIds: ['b', 'a', 'a'] });
    api.submitConsoleCommand(remove, '3000');
    assert.equal((await finish(remove)).state, 'accepted');
    assert.equal(api.peekInstallationQueue(remove.ip).items[0].state, 'installed');
    assert.equal(
      api
        .getInstallationTasks({ ip: remove.ip })
        .items.some((t) => t.packageId === 'a' || t.packageId === 'b'),
      false,
    );
    assert.equal(
      api.submitConsoleCommand({ ...remove, packageIds: ['a', 'b'] }, '3000').state,
      'accepted',
      'normalized replay reads original receipt',
    );
    assert.throws(
      () => api.submitConsoleCommand({ ...remove, packageIds: ['a'] }, '3000'),
      /другой командой/,
    );
    assert.throws(
      () => api.submitConsoleCommand({ ...remove, ip: profiles[1].ip }, '3000'),
      /другой командой/,
    );
    assert.equal(
      readFileSync(join(dir, 'consoles', profiles[1].ip, 'installation-queue.json'), 'utf8'),
      other,
    );
    assert.ok(
      api.getInstallationTasks({ ip: profiles[1].ip }).items.some((t) => t.packageId === 'a'),
      'same queue/package IDs on another console remain visible',
    );
    const branch = request(2, 'remove-games', { queueId: 'past', gameIds: ['ps4:CUSA95001'] });
    api.submitConsoleCommand(branch, '3000');
    assert.equal((await finish(branch)).state, 'accepted');
    assert.equal(
      api.getInstallationTasks({ ip: remove.ip }).items.some((t) => t.queueId === 'past'),
      false,
      'entire historical branch including unseen page is hidden',
    );
    const pending = request(3, 'cancel-all', { queueId: 'current' });
    api.submitConsoleCommand(pending, '3000');
    assert.equal((await finish(pending)).state, 'accepted');
    assert.equal(api.peekInstallationQueue(remove.ip).status, 'cancelled');
    const stale = request(4, 'remove-items', { queueId: 'stale', packageIds: ['a'] });
    api.submitConsoleCommand(stale, '3000');
    assert.equal((await finish(stale)).state, 'failed');
    const archived = {
      version: 1,
      id: 'archived',
      status: 'failed',
      transport: 'service',
      psIp: remove.ip,
      items: [{ ...item('orphan', 'pending'), bytesSent: 0 }],
    };
    writeFileSync(
      join(dir, 'consoles', remove.ip, 'installation-history.json'),
      JSON.stringify([archived]),
    );
    const liveQueue = readFileSync(
      join(dir, 'consoles', remove.ip, 'installation-queue.json'),
      'utf8',
    );
    const cancelOld = request(6, 'cancel-items', { queueId: 'archived', packageIds: ['orphan'] });
    api.submitConsoleCommand(cancelOld, '3000');
    assert.equal((await finish(cancelOld)).state, 'accepted');
    assert.equal(
      api.getInstallationHistory(remove.ip).find((q) => q.id === 'archived').items[0].state,
      'cancelled',
    );
    assert.equal(
      readFileSync(join(dir, 'consoles', remove.ip, 'installation-queue.json'), 'utf8'),
      liveQueue,
    );
    const stop = request(5, 'stop-reinstall', { maintenanceId: 'flow' });
    writeFileSync(
      join(dir, 'console-maintenance.json'),
      JSON.stringify({
        [remove.ip]: {
          id: 'flow',
          kind: 'selected-reinstall',
          state: 'removing',
          steps: [],
          index: 0,
          message: '',
        },
      }),
    );
    api.submitConsoleCommand(stop, '3000');
    assert.equal((await finish(stop)).state, 'accepted');
    assert.equal(
      JSON.parse(readFileSync(join(dir, 'console-maintenance.json')))[remove.ip].cancelRequested,
      true,
    );
    assert.throws(
      () => api.submitConsoleCommand({ ...stop, maintenanceId: 'changed' }, '3000'),
      /другой командой/,
    );
    for (const bad of [
      request(10, 'remove-items', { queueId: 'current', packageIds: [] }),
      request(11, 'remove-games', { queueId: 'current', gameIds: ['CUSA95001'] }),
      request(12, 'remove-items', { queueId: 'current', packageIds: ['../bad'] }),
      request(13, 'remove-items', {
        queueId: 'current',
        packageIds: ['a'],
        gameIds: ['ps4:CUSA95001'],
      }),
    ])
      assert.throws(() => api.submitConsoleCommand(bad, '3000'));
    const q = api.ps5BlankQueue('ps5-one', profiles[2].ip);
    q.id = 'five';
    q.status = 'failed';
    q.items = [
      {
        ...item('stable'),
        platform: 'ps5',
        format: 'pkg',
        branch: 'ps5:PPSA95001',
        order: 0,
        transferId: 'a'.repeat(32),
      },
      {
        ...item('accepted', 'unconfirmed'),
        titleId: 'PPSA95002',
        platform: 'ps5',
        format: 'pkg',
        branch: 'ps5:PPSA95002',
        order: 0,
        transferId: 'b'.repeat(32),
        installDispatched: true,
      },
    ];
    const fiveDir = join(dir, 'consoles', 'ps5-one');
    mkdirSync(fiveDir, { recursive: true });
    writeFileSync(join(fiveDir, 'ps5-installation-queue.json'), JSON.stringify(q));
    const five = (n, extra) => ({
      consoleId: 'ps5-one',
      gameId: 'tasks',
      requestId: n.toString(16).padStart(32, '0'),
      action: 'remove-items',
      queueId: 'five',
      ...extra,
    });
    const opaque = five(20, { packageIds: ['a'.repeat(32)] });
    api.submitPs5AppCommand(opaque);
    assert.equal(
      (await finish(opaque, true)).state,
      'failed',
      'transfer ID cannot masquerade as package ID',
    );
    const stable = five(21, { packageIds: ['stable'] });
    api.submitPs5AppCommand(stable);
    assert.equal((await finish(stable, true)).state, 'completed');
    assert.equal(api.submitPs5AppCommand(stable).state, 'completed');
    const accepted = five(22, { packageIds: ['accepted'] });
    api.submitPs5AppCommand(accepted);
    assert.equal((await finish(accepted, true)).state, 'failed');
    assert.equal(
      api.getPs5Tasks('ps5-one').active.some((t) => t.packageId === 'accepted'),
      true,
    );
    const row = api.nativeTaskRow(api.getPs5Tasks('ps5-one').active[0], 'ps5');
    assert.equal(row.id, 'b'.repeat(32));
    assert.equal(row.packageId, 'accepted');
    assert.equal(row.branchId, 'ps5:PPSA95002');
    assert.equal(row.canDismiss, false);
    assert.equal(api.nativeTaskControls('ps5').actions.includes('stop-reinstall'), false);
    assert.throws(() =>
      api.submitPs5AppCommand({ ...accepted, action: 'stop-reinstall', maintenanceId: 'flow' }),
    );
    // Interrupted command journal reads uncertainty after a module restart; no dispatch.
    const records = JSON.parse(readFileSync(join(fiveDir, 'ps5-command-receipts.json')));
    records[stable.requestId].state = 'pending';
    writeFileSync(join(fiveDir, 'ps5-command-receipts.json'), JSON.stringify(records));
    copyFileSync(bundle, join(dir, 'restarted.mjs'));
    const restarted = await import(pathToFileURL(join(dir, 'restarted.mjs')).href);
    assert.equal(restarted.submitPs5AppCommand(stable).state, 'uncertain');
  } finally {
    if (previous === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
