import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'pf-orphan-clear-'));
await build({
  stdin: { contents: "export * from './server/utils/ps5-queue-driver'", resolveDir: resolve('.') },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: join(dir, 'api.mjs'),
  logLevel: 'silent',
  banner: {
    js: "import { createRequire as __pfRequire } from 'node:module'; const require = __pfRequire(import.meta.url);",
  },
});
const { ps5ClearOwnOrphanRegistration } = await import(pathToFileURL(join(dir, 'api.mjs')).href);
test.after(() => rmSync(dir, { recursive: true, force: true }));

const item = () => ({ titleId: 'PPSA95002', transferId: 'a'.repeat(32) });
const signal = new AbortController().signal,
  noWait = async () => {};
function console(options = {}) {
  const state = { installed: true, source: false, commands: [], ...options };
  state.call = async (path, headers) => {
    if (path === '/api/v1/console/info' && state.unknown)
      return { status: 404, body: { error: 'console data unavailable or changed', status: 404 } };
    if (path === '/api/v1/console/info')
      return {
        status: 200,
        body: {
          title_id: 'PPSA95002',
          installed: state.installed,
          source_available: state.source,
          sourceIdentity: 'e'.repeat(64),
        },
      };
    if (path === '/api/v1/console/command') {
      state.commands.push(headers);
      if (state.refuse) return { status: 409, body: { error: 'console rejected operation' } };
      state.installed = false;
      return { status: 200, body: { state: 'accepted' } };
    }
    assert.fail(`unexpected ${path}`);
  };
  return state;
}

test('an own orphaned registration is uninstalled once and confirmed before publication', async () => {
  const ps5 = console(),
    target = item(),
    saved = [];
  await ps5ClearOwnOrphanRegistration(
    ps5.call,
    target,
    signal,
    (p) => {
      saved.push(p);
      Object.assign(target, p);
    },
    noWait,
  );
  assert.equal(ps5.commands.length, 1);
  const h = ps5.commands[0];
  assert.equal(h['X-PackageFlow-Action'], 'uninstall');
  assert.equal(h['X-PackageFlow-Title'], 'PPSA95002');
  assert.equal(h['X-PackageFlow-Confirm-Title'], 'PPSA95002');
  assert.equal(h['X-PackageFlow-Source-Identity'], 'e'.repeat(64));
  assert.match(h['X-PackageFlow-Request-Id'], /^[a-f0-9]{32}$/);
  assert.equal(target.orphanClearId, h['X-PackageFlow-Request-Id'], 'the request id is durable');
  assert.match(saved.at(-1).detail, /снята/);

  // A retry after a restart reuses the same request id (the service replays it).
  const again = console();
  await ps5ClearOwnOrphanRegistration(again.call, target, signal, () => {}, noWait);
  assert.equal(again.commands[0]['X-PackageFlow-Request-Id'], target.orphanClearId);
});

test('nothing is uninstalled when the source is present or the title is not registered', async () => {
  for (const options of [{ source: true }, { installed: false }, { unknown: true }]) {
    const ps5 = console(options);
    await ps5ClearOwnOrphanRegistration(ps5.call, item(), signal, () => {}, noWait);
    assert.equal(ps5.commands.length, 0);
  }
});

test('a refused uninstall fails clearly and an unconfirmed one stays uncertain', async () => {
  const refused = console({ refuse: true });
  await assert.rejects(
    ps5ClearOwnOrphanRegistration(refused.call, item(), signal, () => {}, noWait),
    /не сняла прежнюю регистрацию этой игры \(409\)/,
  );
  const stuck = console();
  const call = stuck.call;
  stuck.call = async (path, headers) => {
    const r = await call(path, headers);
    stuck.installed = true;
    return r;
  };
  await assert.rejects(
    ps5ClearOwnOrphanRegistration(stuck.call, item(), signal, () => {}, noWait),
    /не подтверждено/,
  );
  assert.equal(stuck.commands.length, 1, 'the uninstall is never resent');
});
