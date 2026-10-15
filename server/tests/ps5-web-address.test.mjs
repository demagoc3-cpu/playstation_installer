import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const bundle = resolve('node_modules/.cache/ps5-web-address-test.mjs');
await build({
  entryPoints: [resolve('server/utils/ps5-web-address.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
});
const { ps5WebAddressHeaders, ps5WebAddressAccepted } = await import(bundle);

test('PS5 announces the same published LAN WEB URL as PS4 and its own profile', () => {
  const headers = ps5WebAddressHeaders('http://192.168.0.5:3000', 'test-ps5');
  assert.deepEqual(headers, {
    'X-PackageFlow-Web-Host': '192.168.0.5',
    'X-PackageFlow-Web-Port': '3000',
    'X-PackageFlow-Console-Id': 'test-ps5',
  });
  for (const url of [
    'http://127.0.0.1:3000',
    'http://192.168.0.5:3000/x',
    'http://user:pass@192.168.0.5:3000',
    'https://192.168.0.5:3000',
    'http://localhost:3000',
    'http://192.168.0.5:3000#x',
  ])
    assert.throws(() => ps5WebAddressHeaders(url, 'test-ps5'));
  assert.throws(() => ps5WebAddressHeaders('http://192.168.0.5:3000', 'bad\r\nHeader'));
});
test('address update succeeds only on an exact service acknowledgement', () => {
  const headers = ps5WebAddressHeaders('http://192.168.0.5:3000', 'test-ps5');
  const response = {
    service: 'PackageFlowService-PS5',
    webConfigured: true,
    webHost: '192.168.0.5',
    webPort: 3000,
    webConsoleId: 'test-ps5',
  };
  assert.equal(ps5WebAddressAccepted(response, headers), true);
  for (const patch of [
    { service: 'other' },
    { webConfigured: false },
    { webHost: '10.0.0.1' },
    { webPort: '3000' },
    { webConsoleId: 'other' },
  ])
    assert.equal(ps5WebAddressAccepted({ ...response, ...patch }, headers), false);
});
