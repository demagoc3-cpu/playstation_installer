import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { packageConsoleBundle } from '../../scripts/package-console-bundle.mjs';
const work = await mkdtemp(join(tmpdir(), 'pf-setup-bundle-'));
process.env.PACKAGEFLOW_DATA_DIR = join(work, 'data');
const outfile = join(work, 'api.mjs');
await build({
  stdin: {
    contents:
      "export * from './server/utils/console-setup-artifacts';export * from './server/utils/ps5-bootstrap-journal'",
    resolveDir: resolve('.'),
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});
const api = await import(pathToFileURL(outfile).href);
const param = Buffer.from(
  JSON.stringify({
    titleId: 'PPSA95001',
    contentId: 'IV0000-PPSA95001_00-PACKAGEFLOWUI001',
    contentVersion: '01.000.041',
    applicationCategoryType: 0,
    requiredSystemSoftwareVersion: '0x0800000000000000',
    localizedParameters: { defaultLanguage: 'en-US', 'en-US': { titleName: 'PackageFlow' } },
  }),
);
function exfat() {
  const b = Buffer.alloc(1024 * 1024);
  b.write('EXFAT   ', 3);
  b.writeUInt16LE(0xaa55, 510);
  b[108] = 9;
  b[109] = 0;
  b[110] = 1;
  b.writeBigUInt64LE(BigInt(b.length / 512), 72);
  b.writeUInt32LE(24, 80);
  b.writeUInt32LE(16, 84);
  b.writeUInt32LE(128, 88);
  b.writeUInt32LE(1792, 92);
  b.writeUInt32LE(2, 96);
  function entry(at, name, dir, cluster, size) {
    b[at] = 0x85;
    b[at + 1] = 2;
    b.writeUInt16LE(dir ? 0x10 : 0, at + 4);
    b[at + 32] = 0xc0;
    b[at + 33] = 2;
    b[at + 35] = name.length;
    b.writeUInt32LE(cluster, at + 52);
    b.writeBigUInt64LE(BigInt(size), at + 56);
    b[at + 64] = 0xc1;
    b.write(name, at + 66, 'utf16le');
  }
  entry(65536, 'sce_sys', true, 3, 512);
  entry(65536 + 96, 'eboot.bin', false, 5, 16);
  entry(65536 + 512, 'param.json', false, 4, param.length);
  param.copy(b, 65536 + 1024);
  b.write('owned SELF bytes', 65536 + 1536);
  return b;
}

test('only a complete hashed ELF + matching PackageFlow PARAM can be staged and read', async () => {
  const source = join(work, 'source');
  await mkdir(source);
  const elf = Buffer.alloc(8192);
  Buffer.from('7f454c460201', 'hex').copy(elf);
  elf.writeUInt16LE(62, 18);
  const image = exfat();
  const artifact = (fileName, bytes) => ({
    fileName,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  const manifest = {
    schemaVersion: 1,
    elf: {
      ...artifact('PackageFlowService-PS5.elf', elf),
      firmware: '13.60',
      version: '0.1.15-dev',
      buildId: 'fixture',
    },
    app: {
      ...artifact('PackageFlow.exfat', image),
      name: 'PackageFlow',
      titleId: 'PPSA95001',
      contentId: 'IV0000-PPSA95001_00-PACKAGEFLOWUI001',
      version: '01.000.041',
      format: 'exfat',
    },
  };
  await writeFile(join(source, manifest.elf.fileName), elf);
  await writeFile(join(source, manifest.app.fileName), image);
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest));
  const target = join(process.env.PACKAGEFLOW_DATA_DIR, 'console-setup');
  assert.equal(await packageConsoleBundle(source, target), true);
  assert.equal((await api.consoleSetupBundle()).manifest.app.name, 'PackageFlow');
  const cached = await api.consoleSetupBundle({ verifyFiles: false });
  cached.manifest.app.name = 'tampered';
  cached.elf.fill(0);
  assert.equal(
    (await api.consoleSetupBundle({ verifyFiles: false })).manifest.app.name,
    'PackageFlow',
    'status callers cannot alter the verified manifest',
  );
  assert.equal(
    (await api.consoleSetupBundle({ verifyFiles: false })).elf[0],
    0x7f,
    'status callers cannot alter the verified ELF',
  );
  await writeFile(join(target, manifest.elf.fileName), Buffer.alloc(8192));
  await assert.rejects(
    api.consoleSetupBundle({ verifyFiles: false }),
    /сумма/,
    'changed artifact invalidates status cache',
  );
  await writeFile(join(target, manifest.elf.fileName), elf);
  const wrong = structuredClone(manifest);
  wrong.app.version = '01.000.040';
  await writeFile(join(target, 'manifest.json'), JSON.stringify(wrong));
  await assert.rejects(api.consoleSetupBundle(), /PARAM/);
  wrong.app.fileName = '../outside.exfat';
  assert.throws(() => api.validateSetupManifest(wrong), /манифест/);
  wrong.app.fileName = manifest.app.fileName;
  wrong.app.name = 'PackageFlow WEB 040';
  assert.throws(() => api.validateSetupManifest(wrong), /приложение/);
  await writeFile(join(source, manifest.elf.fileName), Buffer.alloc(8192));
  await assert.rejects(packageConsoleBundle(source, target), /checksum/);
  assert.equal(
    JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8')).app.version,
    '01.000.040',
    'failed packaging preserves the existing complete destination',
  );
  await packageConsoleBundle('', target);
  await assert.rejects(readFile(join(target, 'manifest.json')), { code: 'ENOENT' });
});
test('unresolved bootstrap prevents ordinary queue or update operations after WEB restart', async () => {
  const folder = join(process.env.PACKAGEFLOW_DATA_DIR, 'console-setup');
  await mkdir(folder, { recursive: true });
  for (const state of ['checking', 'sending', 'verifying', 'unconfirmed']) {
    await writeFile(
      join(folder, 'bootstrap-fixture.json'),
      JSON.stringify({ consoleId: 'fixture', state }),
    );
    assert.throws(() => api.assertNoPs5Bootstrap('fixture'), { statusCode: 409 });
  }
  for (const state of ['completed', 'failed']) {
    await writeFile(
      join(folder, 'bootstrap-fixture.json'),
      JSON.stringify({ consoleId: 'fixture', state }),
    );
    api.assertNoPs5Bootstrap('fixture');
  }
  await writeFile(join(folder, 'bootstrap-fixture.json'), 'broken');
  assert.throws(() => api.assertNoPs5Bootstrap('fixture'), { statusCode: 409 });
});
test.after(() => rm(work, { recursive: true, force: true }));
