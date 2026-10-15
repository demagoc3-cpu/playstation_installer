import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, connect } from 'node:net';
import { build } from 'esbuild';

test('PS4 installer delivers the bundled payload from a portable launch directory', async () => {
  const work = await mkdtemp(join(tmpdir(), 'pf-ps4-payload-'));
  const originalCwd = process.cwd();
  const before = {
    fetch: globalThis.fetch,
    storage: globalThis.useStorage,
    data: process.env.PACKAGEFLOW_DATA_DIR,
    host: process.env.PACKAGEFLOW_HOST_IP,
  };
  const bytes = await readFile('server/assets/ps4-pkg-installer.bin');
  const marker = Buffer.from([0xb4, 0xb4, 0xb4, 0xb4, 0xb4, 0xb4]);
  const offset = bytes.indexOf(marker);
  assert.ok(offset >= 0);
  let api, callback, received;
  const sockets = new Set();
  const loader = createServer((socket) => {
    sockets.add(socket);
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => {
      received = Buffer.concat(chunks);
      const port = received.readUInt16BE(offset + 4);
      callback = connect({ host: '127.0.0.1', port });
    });
  });
  try {
    process.env.PACKAGEFLOW_DATA_DIR = work;
    process.env.PACKAGEFLOW_HOST_IP = '127.0.0.1';
    await new Promise((resolve, reject) => {
      loader.once('error', reject);
      loader.listen(9090, '127.0.0.1', resolve);
    });
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: 'ready' }) });
    globalThis.useStorage = (namespace) => {
      assert.equal(namespace, 'assets:server');
      return {
        getItemRaw: async (key) => {
          assert.equal(key, 'ps4-pkg-installer.bin');
          return new Uint8Array(bytes);
        },
      };
    };
    const source = await readFile('server/utils/ps4-installer.ts', 'utf8');
    const bundle = join(work, 'installer.mjs');
    await build({
      stdin: {
        contents:
          source +
          '\nexport function cleanupFixture() { session?.client?.destroy(); session?.server.close() }',
        resolveDir: resolve('server/utils'),
        loader: 'ts',
      },
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    process.chdir(work);
    api = await import(pathToFileURL(bundle).href);
    const result = await api.startInstaller('127.0.0.1');
    assert.equal(result.alreadyRunning, false);
    assert.equal(received.length, bytes.length);
    assert.deepEqual(received.subarray(0, offset), bytes.subarray(0, offset));
    assert.deepEqual(received.subarray(offset + 6), bytes.subarray(offset + 6));
    assert.deepEqual(received.subarray(offset, offset + 4), Buffer.from([127, 0, 0, 1]));
    assert.equal(received.readUInt16BE(offset + 4), result.port);
  } finally {
    api?.cleanupFixture();
    callback?.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => loader.close(resolve));
    process.chdir(originalCwd);
    globalThis.fetch = before.fetch;
    if (before.storage === undefined) delete globalThis.useStorage;
    else globalThis.useStorage = before.storage;
    for (const [key, value] of [
      ['PACKAGEFLOW_DATA_DIR', before.data],
      ['PACKAGEFLOW_HOST_IP', before.host],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(work, { recursive: true, force: true });
  }
});
