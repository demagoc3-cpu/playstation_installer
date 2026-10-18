import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier))
        return next(`${specifier}.ts`, context);
      throw error;
    }
  },
});

test('stale unconfirmed launch journals close as unconfirmed when a service answers', async () => {
  const data = mkdtempSync(join(tmpdir(), 'pf-start-reconcile-')),
    old = process.env.PACKAGEFLOW_DATA_DIR;
  process.env.PACKAGEFLOW_DATA_DIR = data;
  try {
    const { reconcileStalePs5StartJournals } = await import('../utils/ps5-bootstrap-journal.ts');
    const ip = '192.168.0.32';
    mkdirSync(join(data, 'consoles', ip), { recursive: true });
    mkdirSync(join(data, 'console-setup'), { recursive: true });
    const start = join(data, 'consoles', ip, 'service-start.json'),
      bootstrap = join(data, 'console-setup', 'bootstrap-a.json'),
      fresh = join(data, 'console-setup', 'bootstrap-b.json'),
      other = join(data, 'console-setup', 'bootstrap-c.json');
    writeFileSync(start, JSON.stringify({ id: 'x', ip, state: 'unconfirmed' }));
    writeFileSync(bootstrap, JSON.stringify({ ip, state: 'sending' }));
    writeFileSync(fresh, JSON.stringify({ ip, state: 'unconfirmed' }));
    writeFileSync(other, JSON.stringify({ ip: '192.168.0.127', state: 'unconfirmed' }));
    const hourAgo = Date.now() / 1000 - 3600;
    for (const path of [start, bootstrap, other]) utimesSync(path, hourAgo, hourAgo);

    assert.equal(reconcileStalePs5StartJournals(ip, 'ps5-service-runtime-routes-030c-sse2'), 2);
    for (const path of [start, bootstrap]) {
      const record = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(record.state, 'failed', 'closed, never turned into a success');
      assert.ok(record.previousState);
      assert.match(record.message, /не подтверждён.*030c/);
    }
    assert.equal(JSON.parse(readFileSync(fresh, 'utf8')).state, 'unconfirmed', 'recent: untouched');
    assert.equal(JSON.parse(readFileSync(other, 'utf8')).state, 'unconfirmed', 'other IP');
  } finally {
    if (old === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = old;
    rmSync(data, { recursive: true, force: true });
  }
});
