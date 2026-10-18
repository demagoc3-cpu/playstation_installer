import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const work = await mkdtemp(join(tmpdir(), 'pf-service-artifact-'));
const outfile = join(work, 'api.mjs');
await build({
  entryPoints: ['server/utils/ps5-service-artifact.ts'],
  outfile,
  platform: 'node',
  format: 'esm',
  bundle: true,
  logLevel: 'silent',
});
const api = await import(pathToFileURL(outfile).href);
const data = join(work, 'data');
const directory = join(data, 'console-setup');
const standalone = join(data, 'ps5-service-artifacts');
const fileName = 'PackageFlowService-PS5.elf';
const bytes = Buffer.alloc(8192);
Buffer.from('7f454c460201', 'hex').copy(bytes);
bytes.writeUInt16LE(62, 18);
const elf = {
  fileName,
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  version: '0.1.29-dev',
  buildId: 'fixture-unified',
  firmware: '13.60',
};
const manifest = { schemaVersion: 1, elf };
const previousData = process.env.PACKAGEFLOW_DATA_DIR;
process.env.PACKAGEFLOW_DATA_DIR = data;
test.beforeEach(async () => {
  await rm(data, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, fileName), bytes);
});

async function writeStandalone() {
  const hashDirectory = join(standalone, elf.sha256);
  await mkdir(hashDirectory, { recursive: true });
  await writeFile(join(hashDirectory, fileName), bytes);
  await writeFile(join(standalone, 'manifest.json'), JSON.stringify(manifest));
  return hashDirectory;
}

test('legacy console-setup accepts a hashed canonical ELF without an app and prefers the dedicated manifest', async () => {
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  assert.deepEqual(await api.readPs5ServiceArtifact(), { manifest: elf, bytes });
  await writeFile(join(directory, 'manifest.json'), 'legacy application manifest unavailable');
  await writeFile(join(directory, 'service-manifest.json'), JSON.stringify(manifest));
  const info = await api.getPs5ServiceArtifactInfo();
  assert.deepEqual(info, elf);
  info.buildId = 'tampered';
  assert.equal((await api.getPs5ServiceArtifactInfo()).buildId, elf.buildId);
  await writeFile(join(directory, 'service-manifest.json'), '{}');
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(
    api.readPs5ServiceArtifact(),
    /манифест/,
    'bad dedicated manifest never falls back',
  );
});

test('immutable standalone service takes priority without requiring a console bundle or native app', async () => {
  await rm(directory, { recursive: true });
  await writeStandalone();
  assert.deepEqual(await api.readPs5ServiceArtifact(), { manifest: elf, bytes });
  assert.deepEqual(await api.getPs5ServiceArtifactInfo(), elf);
});

test('a stale launcher rewriting console-setup cannot replace the immutable service selected by WEB', async () => {
  await writeStandalone();
  const olderBytes = Buffer.from(bytes);
  olderBytes[64] = 42;
  const older = {
    schemaVersion: 1,
    elf: {
      ...elf,
      version: '0.1.1-dev',
      buildId: 'legacy-launcher',
      sha256: createHash('sha256').update(olderBytes).digest('hex'),
    },
    app: { fileName: 'legacy-app.exfat' },
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(older));
  await writeFile(join(directory, 'service-manifest.json'), JSON.stringify(older));
  await writeFile(join(directory, fileName), olderBytes);
  assert.deepEqual(await api.readPs5ServiceArtifact(), { manifest: elf, bytes });
  await writeFile(join(directory, fileName), 'launcher is currently copying an old ELF');
  assert.deepEqual(await api.readPs5ServiceArtifact(), { manifest: elf, bytes });
});

test('a damaged standalone release never silently falls back to an otherwise valid legacy service', async () => {
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  const hashDirectory = await writeStandalone();
  const standaloneManifest = join(standalone, 'manifest.json');
  await writeFile(standaloneManifest, 'invalid JSON');
  await assert.rejects(api.readPs5ServiceArtifact(), SyntaxError);
  await writeFile(standaloneManifest, '{}');
  await assert.rejects(api.readPs5ServiceArtifact(), /манифест/);
  await writeFile(standaloneManifest, JSON.stringify(manifest));
  await rm(join(hashDirectory, fileName));
  await assert.rejects(api.readPs5ServiceArtifact(), /Комплект службы PS5 отсутствует/);
  const changed = Buffer.from(bytes);
  changed[64] = 1;
  await writeFile(join(hashDirectory, fileName), changed);
  await assert.rejects(api.readPs5ServiceArtifact(), /сумма/);
});

test('an empty standalone directory retains compatibility with the legacy console bundle', async () => {
  await mkdir(standalone);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  assert.deepEqual(await api.readPs5ServiceArtifact(), { manifest: elf, bytes });
});

test('service artifact rejects altered bytes, non-x64 ELF, firmware, filename and oversized declarations', async () => {
  for (const mutate of [
    (value) => (value.elf.fileName = '../PackageFlowService-PS5.elf'),
    (value) => (value.elf.fileName = 'PackageFlowInstaller-PS5.elf'),
    (value) => (value.elf.firmware = 'any'),
    (value) => (value.elf.firmware = '13.60;rm'),
    (value) => (value.elf.size = 4 * 1024 ** 2 + 1),
    (value) => (value.elf.sha256 = 'x'.repeat(64)),
    (value) => (value.elf.sha256 = '../outside'),
    (value) => (value.elf.buildId = '../unsafe'),
  ]) {
    const changed = structuredClone(manifest);
    mutate(changed);
    await writeFile(join(directory, 'service-manifest.json'), JSON.stringify(changed));
    await assert.rejects(api.readPs5ServiceArtifact(), /манифест/);
  }
  await writeFile(join(directory, 'service-manifest.json'), JSON.stringify(manifest));
  const changed = Buffer.from(bytes);
  changed[64] = 1;
  await writeFile(join(directory, fileName), changed);
  await assert.rejects(api.getPs5ServiceArtifactInfo(), /сумма/);
  changed.writeUInt16LE(3, 18);
  await writeFile(join(directory, fileName), changed);
  await assert.rejects(api.readPs5ServiceArtifact(), /ELF x64/);
});

test('standalone manifest, ELF, hash directory and storage root reject symlink redirection', async () => {
  const hashDirectory = await writeStandalone();
  const outsideElf = join(work, 'outside-standalone.elf');
  await writeFile(outsideElf, bytes);
  await rm(join(hashDirectory, fileName));
  await symlink(outsideElf, join(hashDirectory, fileName));
  await assert.rejects(api.readPs5ServiceArtifact(), /путь/);

  await rm(hashDirectory, { recursive: true });
  const outsideDirectory = join(work, 'outside-hash-directory');
  await mkdir(outsideDirectory);
  await writeFile(join(outsideDirectory, fileName), bytes);
  await symlink(outsideDirectory, hashDirectory);
  await assert.rejects(api.readPs5ServiceArtifact(), /ссылкой/);

  await rm(hashDirectory);
  await mkdir(hashDirectory);
  await writeFile(join(hashDirectory, fileName), bytes);
  const outsideManifest = join(work, 'outside-standalone.json');
  await writeFile(outsideManifest, JSON.stringify(manifest));
  await rm(join(standalone, 'manifest.json'));
  await symlink(outsideManifest, join(standalone, 'manifest.json'));
  await assert.rejects(api.readPs5ServiceArtifact(), /путь/);

  await rm(standalone, { recursive: true });
  const outsideRoot = join(work, 'outside-artifacts');
  await mkdir(outsideRoot);
  await symlink(outsideRoot, standalone);
  await assert.rejects(api.readPs5ServiceArtifact(), /ссылкой/);
});

test('a symlink in an ancestor of the configured data directory cannot redirect service reads', async () => {
  const actualParent = join(work, 'actual-parent');
  const linkedParent = join(work, 'linked-parent');
  const actualData = join(actualParent, 'data');
  await mkdir(join(actualData, 'ps5-service-artifacts', elf.sha256), { recursive: true });
  await writeFile(
    join(actualData, 'ps5-service-artifacts', 'manifest.json'),
    JSON.stringify(manifest),
  );
  await writeFile(join(actualData, 'ps5-service-artifacts', elf.sha256, fileName), bytes);
  await symlink(actualParent, linkedParent);
  process.env.PACKAGEFLOW_DATA_DIR = join(linkedParent, 'data');
  try {
    await assert.rejects(api.readPs5ServiceArtifact(), /ссылкой/);
  } finally {
    process.env.PACKAGEFLOW_DATA_DIR = data;
  }
});

test('manifest, ELF and console-setup symlinks cannot redirect artifact reads', async () => {
  const outside = join(work, 'outside.elf');
  await writeFile(outside, bytes);
  await writeFile(join(directory, 'service-manifest.json'), JSON.stringify(manifest));
  await rm(join(directory, fileName));
  await symlink(outside, join(directory, fileName));
  await assert.rejects(api.readPs5ServiceArtifact(), /путь/);
  await rm(join(directory, fileName));
  await writeFile(join(directory, fileName), bytes);
  await rm(join(directory, 'service-manifest.json'));
  const outsideManifest = join(work, 'outside.json');
  await writeFile(outsideManifest, JSON.stringify(manifest));
  await symlink(outsideManifest, join(directory, 'service-manifest.json'));
  await assert.rejects(api.readPs5ServiceArtifact(), /путь/);
  await rm(directory, { recursive: true });
  const linkedDirectory = join(work, 'external-console-setup');
  await mkdir(linkedDirectory);
  await symlink(linkedDirectory, directory);
  await assert.rejects(api.readPs5ServiceArtifact(), /ссылкой/);
});

test('missing standalone bundle explains how to supply it', async () => {
  await assert.rejects(api.getPs5ServiceArtifactInfo(), /Комплект службы PS5 отсутствует/);
});
test.after(async () => {
  if (previousData === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
  else process.env.PACKAGEFLOW_DATA_DIR = previousData;
  await rm(work, { recursive: true, force: true });
});
