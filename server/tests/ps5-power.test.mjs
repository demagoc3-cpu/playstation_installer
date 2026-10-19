import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const work = mkdtempSync(join(tmpdir(), 'pf-ps5-power-')),
  bundle = join(work, 'power.mjs');
await build({
  entryPoints: [resolve('server/utils/ps5-power.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});
const { ps5PowerState } = await import(pathToFileURL(bundle).href);

test('an address that is not IPv4 is not probed', async () => {
  assert.equal(await ps5PowerState('console.local'), 'unknown');
});

test('rest mode and awake replies are told apart without other requests', async (t) => {
  const reply = { value: '' };
  const fake = createSocket('udp4');
  const bound = await new Promise((done) =>
    fake.bind(9302, '127.0.0.1', () => done(true)).once('error', () => done(false)),
  );
  if (!bound) return t.skip('UDP 9302 is busy on this host');
  const requests = [];
  fake.on('message', (message, remote) => {
    requests.push(message.toString());
    fake.send(reply.value, remote.port, remote.address);
  });
  try {
    reply.value = 'HTTP/1.1 620 Server Standby\nhost-type:PS5\n';
    assert.equal(await ps5PowerState('127.0.0.1'), 'rest');
    reply.value = 'HTTP/1.1 200 Ok\nhost-type:PS5\n';
    assert.equal(await ps5PowerState('127.0.0.1'), 'awake');
    assert.ok(requests.every((text) => text.startsWith('SRCH * HTTP/1.1\n')));
  } finally {
    fake.close();
  }
});

test('silence is unknown, not rest mode', async () => {
  assert.equal(await ps5PowerState('127.0.0.1', 100), 'unknown');
});
