import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

test('reinstall tasks stay removable after an error; branch dismissal preserves console receipts and other queues', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-task-remove-')),
    previous = process.env.PACKAGEFLOW_DATA_DIR;
  process.env.PACKAGEFLOW_DATA_DIR = work;
  try {
    const ip = '10.1.10.32',
      other = '10.1.10.33',
      folder = join(work, 'consoles', ip);
    mkdirSync(folder, { recursive: true });
    mkdirSync(join(work, 'consoles', other), { recursive: true });
    writeFileSync(
      join(work, 'package-library.json'),
      JSON.stringify({ version: 2, packages: [], deliveries: {} }),
    );
    const item = (packageId, titleId, state) => ({
      packageId,
      titleId,
      state,
      title: packageId,
      fileName: packageId + '.pkg',
      type: 'Игра',
      size: 100,
      bytesSent: state === 'installed' ? 100 : 0,
      detail: '',
      url: 'http://192.168.1.2/pkg',
    });
    const queue = {
      version: 1,
      id: 'reinstall',
      maintenanceId: 'reinstall',
      transport: 'service',
      psIp: ip,
      status: 'failed',
      items: [
        item('installed', 'CUSA03887', 'installed'),
        item('failed', 'CUSA03887', 'failed'),
        item('waiting', 'CUSA03887', 'pending'),
        item('other-branch', 'CUSA07027', 'pending'),
      ],
    };
    const queueFile = join(folder, 'installation-queue.json'),
      otherFile = join(work, 'consoles', other, 'installation-queue.json');
    writeFileSync(queueFile, JSON.stringify(queue));
    writeFileSync(otherFile, JSON.stringify({ ...queue, psIp: other }));
    const untouched = readFileSync(otherFile, 'utf8');
    writeFileSync(
      join(folder, 'installation-history.json'),
      JSON.stringify([
        {
          ...queue,
          id: 'past',
          maintenanceId: undefined,
          status: 'completed',
          items: [item('past', 'CUSA03887', 'installed')],
        },
      ]),
    );
    const maintenance = join(work, 'console-maintenance.json');
    writeFileSync(
      maintenance,
      JSON.stringify({
        [ip]: {
          id: 'reinstall',
          kind: 'selected-reinstall',
          state: 'failed',
          message: 'Service busy',
        },
      }),
    );
    const bundle = join(work, 'api.mjs');
    await build({
      stdin: {
        contents:
          "export * from './server/utils/installation-tasks';export * from './server/utils/task-visibility';export * from './server/utils/installation-queue';export * from './server/utils/ps5-queue-core'",
        resolveDir: resolve('.'),
      },
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const api = await import(pathToFileURL(bundle).href);
    let tasks = api.getInstallationTasks({ ip, view: 'tree' });
    assert.equal(tasks.items.find((t) => t.packageId === 'waiting').canCancel, true);
    assert.equal(tasks.items.find((t) => t.packageId === 'failed').canDismiss, true);
    api.removeInstallationTasks(ip, queue.id, ['waiting']);
    assert.equal(
      api.peekInstallationQueue(ip).items.find((i) => i.packageId === 'waiting').state,
      'cancelled',
    );
    assert.equal(
      api.peekInstallationQueue(ip).items.find((i) => i.packageId === 'other-branch').state,
      'pending',
    );
    assert.ok(
      !api.getInstallationTasks({ ip, view: 'tree' }).items.some((i) => i.packageId === 'waiting'),
    );
    api.removeInstallationTasks(ip, queue.id, undefined, ['ps4:CUSA03887']);
    assert.equal(
      api.peekInstallationQueue(ip).items.find((i) => i.packageId === 'installed').state,
      'installed',
      'hiding history never uninstalls a game',
    );
    assert.ok(
      api
        .getInstallationTasks({ ip, view: 'tree' })
        .items.every((i) => i.titleId !== 'CUSA03887' || i.queueId === 'past'),
    );
    assert.equal(readFileSync(otherFile, 'utf8'), untouched);
    assert.throws(() => api.removeInstallationTasks(ip, 'wrong', ['other-branch']), /изменилась/);
    writeFileSync(
      maintenance,
      JSON.stringify({ [ip]: { id: 'reinstall', kind: 'update', state: 'installing' } }),
    );
    assert.equal(
      api
        .getInstallationTasks({ ip, view: 'tree' })
        .items.find((i) => i.packageId === 'other-branch').canCancel,
      false,
    );
    assert.throws(
      () => api.removeInstallationTasks(ip, queue.id, ['other-branch']),
      /подтверждения/,
    );
    writeFileSync(
      maintenance,
      JSON.stringify({ [ip]: { id: 'reinstall', kind: 'selected-reinstall', state: 'failed' } }),
    );
    api.cancelInstallationQueue(ip);
    assert.equal(api.peekInstallationQueue(ip).status, 'cancelled');
    assert.equal(
      api.peekInstallationQueue(ip).items.find((i) => i.packageId === 'other-branch').state,
      'cancelled',
    );
    api.removeInstallationTasks(ip, queue.id, ['other-branch']);
    assert.equal(
      api.getInstallationTasks({ ip, view: 'tree' }).maintenance,
      undefined,
      'dismissed stopped queue does not keep its maintenance banner',
    );
    // Starting a newer queue must not strand the old, never-dispatched tail.
    const live = {
      ...queue,
      id: 'new-queue',
      maintenanceId: undefined,
      status: 'completed',
      items: [item('new', 'CUSA07027', 'installed')],
    };
    const orphan = {
      ...queue,
      id: 'reinstall',
      items: [
        item('orphan-a', 'CUSA03887', 'pending'),
        item('orphan-b', 'CUSA03887', 'pending'),
        {
          ...item('accepted', 'CUSA07027', 'pending'),
          serviceDispatchedAt: 1,
          requestId: 'a'.repeat(36),
        },
      ],
    };
    writeFileSync(queueFile, JSON.stringify(live));
    writeFileSync(join(folder, 'installation-history.json'), JSON.stringify([orphan]));
    const liveBytes = readFileSync(queueFile, 'utf8');
    tasks = api.getInstallationTasks({ ip, view: 'tree' });
    assert.equal(tasks.items.find((t) => t.packageId === 'orphan-a').canCancel, true);
    assert.equal(tasks.items.find((t) => t.packageId === 'accepted').canCancel, false);
    api.cancelInstallationItem(orphan.id, 'orphan-a', ip);
    api.removeInstallationTasks(ip, orphan.id, undefined, ['ps4:CUSA03887']);
    assert.equal(
      readFileSync(queueFile, 'utf8'),
      liveBytes,
      'historical cancellation never overwrites the live queue',
    );
    assert.equal(readFileSync(otherFile, 'utf8'), untouched);
    assert.throws(() => api.cancelInstallationItem(orphan.id, 'accepted', ip), /изменилось/);
    assert.equal(
      JSON.parse(readFileSync(join(folder, 'installation-history.json')))[0].items.find(
        (i) => i.packageId === 'accepted',
      ).state,
      'pending',
    );
    // Selective PS5 history cleanup must not hide an active system installation.
    const q = api.ps5BlankQueue('ps5', '192.168.1.5');
    q.items = [
      { ...item('a', 'PPSA95001', 'installed') },
      { ...item('b', 'PPSA95002', 'failed') },
      { ...item('c', 'PPSA95003', 'installing'), installDispatched: true },
    ];
    const r = new api.Ps5QueueRunner(q, () => {}, { run: async () => {}, cancel: async () => {} });
    r.clear((i) => i.packageId === 'a' || i.packageId === 'c');
    assert.equal(q.items[0].hidden, true);
    assert.equal(q.items[1].hidden, undefined);
    assert.equal(q.items[2].hidden, undefined);
  } finally {
    if (previous === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = previous;
    rmSync(work, { recursive: true, force: true });
  }
});
