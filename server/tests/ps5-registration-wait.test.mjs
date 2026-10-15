import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const temp = await mkdtemp(join(tmpdir(), 'pf-register-wait-')),
  file = join(temp, 'api.mjs');
await build({
  stdin: {
    contents: "export * from './server/utils/ps5-registration-wait'",
    resolveDir: resolve('.'),
  },
  outfile: file,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});
const { ps5RegistrationWait } = await import(pathToFileURL(file).href);
const signal = new AbortController().signal;
test('all Folder/image waits defer behind PS5 app and receive a fresh idle timeout; never send mutations', async () => {
  const realNow = Date.now;
  let now = 1000000;
  Date.now = () => now;
  try {
    for (const kind of ['folder', 'image']) {
      const key = kind === 'folder' ? 'folderPublishedAt' : 'imagePublishedAt';
      const originalPublished = now - 600000,
        item = { transferId: 'a'.repeat(32), [key]: originalPublished },
        save = (p) => Object.assign(item, p),
        calls = [];
      let running = true;
      const request = async (id, path) => {
        calls.push(path);
        assert.equal(id, item.transferId);
        assert.equal(path, '/api/v1/console/activity');
        return {
          status: 200,
          body: {
            complete: true,
            running,
            appId: running ? 24 : 0,
            titleId: running ? 'PPSA95001' : '',
          },
        };
      };
      let r = await ps5RegistrationWait(
        item,
        kind,
        { registrationRequest: 'queued' },
        signal,
        request,
        save,
      );
      assert.equal(r.state, 'installing');
      assert.match(r.detail, /Закройте PackageFlow на PS5/);
      assert.equal(item[key], originalPublished);
      now += 300000;
      r = await ps5RegistrationWait(
        item,
        kind,
        { registrationRequest: 'queued' },
        signal,
        request,
        save,
      );
      assert.equal(r.state, 'installing');
      running = false;
      await ps5RegistrationWait(
        item,
        kind,
        { registrationRequest: 'queued' },
        signal,
        request,
        save,
      );
      const idle = item.registrationIdleSince;
      now += 120000;
      assert.equal(
        (
          await ps5RegistrationWait(
            item,
            kind,
            { registrationRequest: 'queued' },
            signal,
            request,
            save,
          )
        ).state,
        'installing',
      );
      now++;
      await assert.rejects(
        ps5RegistrationWait(item, kind, { registrationRequest: 'queued' }, signal, request, save),
        /не подтверждена/,
      );
      assert.equal(item.registrationIdleSince, idle);
      assert.ok(calls.every((p) => p.endsWith('/activity')));
    }
  } finally {
    Date.now = realNow;
  }
});
test('unavailable activity does not grant an indefinite wait and abort stays effective', async () => {
  const item = {
    transferId: 'b'.repeat(32),
    folderPublishedAt: Date.now() - 600000,
    registrationBlockedByApp: true,
  };
  await assert.rejects(
    ps5RegistrationWait(
      item,
      'folder',
      { registrationRequest: 'unknown' },
      signal,
      async () => ({ status: 503 }),
      () => {},
    ),
    /не подтверждена/,
  );
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(
    ps5RegistrationWait(
      item,
      'folder',
      { registrationRequest: 'queued' },
      controller.signal,
      async () => {
        throw Error('network');
      },
      () => {},
    ),
    /cancelled/,
  );
});
test.after(() => rm(temp, { recursive: true, force: true }));
