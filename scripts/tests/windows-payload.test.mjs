import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const checker = new URL('../check-windows-payload.mjs', import.meta.url);
const releaseManifest = JSON.parse(
  await readFile(
    new URL('../../packaging/windows/console-bundle-1.10.27.json', import.meta.url),
    'utf8',
  ),
);
const work = await mkdtemp(join(tmpdir(), 'pf-windows-payload-'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root = await mkdtemp(join(work, 'case-'));
  const tool = join(root, 'scripts/check-windows-payload.mjs');
  const pins = join(root, 'packaging/windows/console-bundle-1.10.27.json');
  const payload = join(root, 'payload');
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'packaging/windows'), { recursive: true });
  await mkdir(join(payload, 'console-setup'), { recursive: true });
  await copyFile(checker, tool);
  const manifest = structuredClone(releaseManifest);
  const contents = {};
  for (const [index, role] of ['elf', 'app', 'ps4'].entries()) {
    // The isolated trusted release manifest binds small fixture bytes. The
    // production checker has no test override or checksum bypass.
    const bytes = Buffer.alloc(8192, index + 1);
    if (role === 'elf') {
      Buffer.from('7f454c460201', 'hex').copy(bytes);
      bytes.writeUInt16LE(62, 18);
    }
    contents[role] = bytes;
    manifest[role].size = bytes.length;
    manifest[role].sha256 = sha(bytes);
    await writeFile(join(payload, 'console-setup', manifest[role].fileName), bytes);
  }
  await writeFile(pins, JSON.stringify(manifest));
  await writeFile(join(payload, 'console-setup/manifest.json'), JSON.stringify(manifest));
  await writeFile(join(payload, 'release.json'), JSON.stringify({ version: '1.10.27' }));
  await writeFile(join(payload, 'desktop-manifest.json'), JSON.stringify({ files: [] }));
  return { payload, tool, pins, manifest, contents };
}
const execute = promisify(execFile);
async function run(f, version = '1.10.27') {
  try {
    const result = await execute(process.execPath, [f.tool, f.payload, version]);
    return { status: 0, ...result };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { status: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('Windows 1.10.27 pins the reviewed three-role bundle and canonical service metadata', () => {
  assert.deepEqual(Object.keys(releaseManifest).sort(), ['app', 'elf', 'ps4', 'schemaVersion']);
  assert.deepEqual(releaseManifest.elf, {
    fileName: 'PackageFlowService-PS5.elf',
    size: 4132200,
    sha256: '698fda5e903648d937efca20e12fa1d3cfdcdb00dd439ae20ab6048fa7d997c6',
    version: '0.1.29-dev',
    buildId: 'ps5-service-pkg-context-029c-sse2',
    firmware: '13.60',
  });
  assert.equal(releaseManifest.app.version, '01.000.044');
  assert.equal(releaseManifest.app.buildId, '6c32b25');
  assert.equal(
    releaseManifest.app.sha256,
    '7ecf378d3c49c30dfdbf6a692432cf2e276fd340ce98d6bf6b31c15e046b3612',
  );
  assert.equal(releaseManifest.ps4.version, '2.14');
  assert.equal(
    releaseManifest.ps4.sha256,
    '83995a02c90e8dc6fb775243f911573dc3e2b0acd390e0f3d2d591c1dc554abf',
  );
});

test('release audit accepts pinned 1.10.27 bytes and rejects corruption of each role', async () => {
  const f = await fixture();
  assert.equal((await run(f)).status, 0);
  for (const role of ['elf', 'app', 'ps4']) {
    const file = join(f.payload, 'console-setup', f.manifest[role].fileName);
    const corrupt = Buffer.from(f.contents[role]);
    corrupt[4096] ^= 1;
    await writeFile(file, corrupt);
    const result = await run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp('Console bundle changed: ' + role));
    await writeFile(file, f.contents[role]);
  }
});

test('unified release refuses a separate Installer and extra ELF files anywhere in payload', async () => {
  const f = await fixture();
  for (const name of [
    'console-setup/PackageFlowInstaller-PS5.elf',
    'console-setup/PackageFlowService-PS5-Test.ELF',
    'diagnostic/PackageFlowService-PS5.elf',
    'unexpected.elf',
  ]) {
    const file = join(f.payload, name);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, Buffer.from('unexpected'));
    const result = await run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unexpected ELF in unified PS5 payload/);
    await rm(file);
  }
  assert.equal((await run(f)).status, 0);
});

test('payload cannot replace trusted release pins or relabel another release as 1.10.27', async () => {
  const f = await fixture();
  const altered = structuredClone(f.manifest);
  altered.elf.buildId = 'unreviewed';
  await writeFile(join(f.payload, 'console-setup/manifest.json'), JSON.stringify(altered));
  assert.match((await run(f)).stderr, /differs from the pinned Windows 1.10.27 manifest/);
  await writeFile(join(f.payload, 'console-setup/manifest.json'), JSON.stringify(f.manifest));
  await writeFile(join(f.payload, 'release.json'), JSON.stringify({ version: '1.10.26' }));
  assert.match((await run(f)).stderr, /wrong version/);
});

test('legacy version keeps its previous pin checks without the new unified ELF restriction', async () => {
  const f = await fixture();
  await writeFile(join(f.payload, 'release.json'), JSON.stringify({ version: '1.10.22' }));
  await writeFile(join(f.payload, 'legacy-extra.elf'), 'legacy fixture');
  await rm(f.pins); // Legacy versions do not consult the new release manifest.
  const result = await run(f, '1.10.22');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Console bundle changed: ps4/);
  assert.doesNotMatch(result.stderr, /Unexpected ELF|pinned Windows 1.10.27|ENOENT/);
});

test.after(() => rm(work, { recursive: true, force: true }));
