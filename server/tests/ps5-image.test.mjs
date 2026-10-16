import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { blake3 } from '@noble/hashes/blake3.js';
const work = await mkdtemp(join(tmpdir(), 'pf-image-web-'));
process.env.PACKAGEFLOW_DATA_DIR = join(work, 'data');
const bundle = join(work, 'image-api.mjs');
await build({
  stdin: {
    contents:
      "export * from './server/utils/ps5-image-driver'; export * from './server/utils/ps5-queue-driver'; export * from './server/utils/console-profiles'; export * from './shared/ps5-install-readiness'; export * from './shared/device-eligibility';",
    resolveDir: resolve('.'),
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});
const api = await import(pathToFileURL(bundle).href),
  signal = new AbortController().signal;
const digest = (bytes) => Buffer.from(blake3(bytes)).toString('hex');
const param = Buffer.from(
  JSON.stringify({
    titleId: 'PPSA95040',
    contentId: 'IV0000-PPSA95040_00-PACKAGEFLOWUI001',
    contentVersion: '01.000.038',
    applicationCategoryType: 0,
    requiredSystemSoftwareVersion: '0x1400000000000000',
    sdkVersion: '0x0800000000000000',
    localizedParameters: {
      defaultLanguage: 'en-US',
      'en-US': { titleName: 'Owned image fixture' },
    },
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
function ufs2() {
  const b = Buffer.alloc(1024 * 1024),
    sb = 65536;
  b.writeUInt32LE(0x19540119, sb + 0x55c);
  b.writeUInt32LE(4096, sb + 48);
  b.writeUInt32LE(512, sb + 52);
  b.writeUInt32LE(1, sb + 44);
  b.writeUInt32LE(32, sb + 184);
  b.writeUInt32LE(b.length / 512, sb + 188);
  b.writeUInt32LE(32, sb + 16);
  function inode(id, dir, size, pointer) {
    const at = 32 * 512 + id * 256;
    b.writeUInt16LE(dir ? 0x4000 : 0x8000, at);
    b.writeBigUInt64LE(BigInt(size), at + 16);
    b.writeBigUInt64LE(BigInt(pointer), at + 112);
  }
  function entry(at, id, name, dir) {
    const len = Math.ceil((8 + name.length + 1) / 4) * 4;
    b.writeUInt32LE(id, at);
    b.writeUInt16LE(len, at + 4);
    b[at + 6] = dir ? 4 : 8;
    b[at + 7] = name.length;
    b.write(name, at + 8);
    return len;
  }
  const rootSize =
    entry(300 * 512, 3, 'sce_sys', true) + entry(300 * 512 + 16, 5, 'eboot.bin', false);
  const sysSize = entry(308 * 512, 4, 'param.json', false);
  inode(2, true, rootSize, 300);
  inode(3, true, sysSize, 308);
  inode(4, false, param.length, 316);
  inode(5, false, 16, 324);
  param.copy(b, 316 * 512);
  b.write('owned SELF bytes', 324 * 512);
  return b;
}
function pfs(compressed) {
  const block = 4096,
    inner = exfat(),
    unit = 65536,
    count = inner.length / unit,
    table = 48,
    start = table + (count + 1) * 8;
  const packed = Buffer.alloc(start + inner.length);
  packed.write('PFSC');
  packed.writeUInt32LE(6, 8);
  packed.writeUInt32LE(unit, 12);
  packed.writeBigUInt64LE(BigInt(unit), 16);
  packed.writeBigUInt64LE(BigInt(table), 24);
  packed.writeBigUInt64LE(BigInt(inner.length), 40);
  for (let n = 0; n <= count; n++) packed.writeBigUInt64LE(BigInt(start + n * unit), table + n * 8);
  inner.copy(packed, start);
  const data = compressed ? packed : inner,
    blocks = Math.ceil(data.length / block);
  const b = Buffer.alloc((5 + blocks) * block);
  b.writeBigUInt64LE(2n);
  b.writeBigUInt64LE(20130315n, 8);
  b.writeUInt32LE(block, 32);
  b.writeBigUInt64LE(2n, 48);
  b.writeBigUInt64LE(1n, 64);
  function entry(at, id, name, kind) {
    const len = Math.ceil((16 + name.length + 1) / 8) * 8;
    b.writeUInt32LE(id, at);
    b.writeUInt32LE(kind, at + 4);
    b.writeUInt32LE(name.length, at + 8);
    b.writeUInt32LE(len, at + 12);
    b.write(name, at + 16);
    return len;
  }
  entry(2 * block, 0, 'uroot', 3);
  const len = entry(3 * block, 1, 'image.exfat', 2);
  b.writeBigUInt64LE(BigInt(len), block + 8);
  b.writeBigUInt64LE(BigInt(len), block + 16);
  b.writeUInt32LE(1, block + 96);
  b.writeUInt32LE(3, block + 100);
  const at = block + 168;
  b.writeUInt32LE(compressed ? 1 : 0, at + 4);
  b.writeBigUInt64LE(BigInt(data.length), at + 8);
  b.writeBigUInt64LE(BigInt(inner.length), at + 16);
  b.writeUInt32LE(blocks, at + 96);
  b.writeUInt32LE(5, at + 100);
  for (let n = 1; n < 12; n++) b.writeUInt32LE(0xffffffff, at + 100 + n * 4);
  data.copy(b, 5 * block);
  return b;
}
async function fixture(name, format) {
  const path = join(work, `${name}.pkg`),
    bytes = format === 'ufs2' ? ufs2() : format === 'exfat' ? exfat() : pfs(format === 'ffpfsc');
  await writeFile(path, bytes);
  const item = {
    packageId: name,
    title: name,
    platform: 'ps5',
    order: 0,
    format,
    titleId: 'PPSA95040',
    contentId: 'IV0000-PPSA95040_00-PACKAGEFLOWUI001',
    appVersion: '01.000.038',
    transferId: digest(Buffer.from(name)).slice(0, 32),
    size: bytes.length,
    bytesSent: 0,
  };
  return { path, bytes, item };
}
const publication = (p) => ({
  id: p.id,
  title: p.title,
  content: p.content,
  version: p.appVersion,
  format: p.format,
  state: 'published',
  proof: 'image-publication',
  manifestHash: p.manifestHash,
  imageHash: p.imageHash,
  size: p.size,
  sourceName: `${p.title}.${{ ufs2: 'ffpkg', exfat: 'exfat', pfs: 'ffpfs', ffpfsc: 'ffpfsc' }[p.format]}`,
  registered: false,
  installed: false,
  backend: 'shadowmount',
});

test('all four image plans read real metadata and ignore a misleading .pkg suffix', async () => {
  for (const format of api.ps5ImageFormats) {
    const f = await fixture(`plan-${format}`, format),
      progress = [];
    const p = await api.createImagePlan(f.path, f.item, signal, (n) => progress.push(n));
    assert.equal(p.format, format);
    assert.equal(p.imageHash, digest(f.bytes));
    assert.equal(progress.at(-1), f.bytes.length);
    assert.equal(p.manifestHash, digest(Buffer.from(api.imageManifest(p))));
    assert.equal(p.imageId, digest(Buffer.from(`${p.id}/image`)).slice(0, 32));
    await api.verifyImagePlan(p, f.item, f.path);
    const second = await api.createImagePlan(
      f.path,
      { ...f.item, transferId: '9'.repeat(32) },
      signal,
      () => {},
    );
    assert.equal(second.imageHash, p.imageHash);
    assert.notEqual(second.imageId, p.imageId);
    await assert.rejects(
      api.verifyImagePlan({ ...p, imageId: '0'.repeat(32) }, f.item, f.path),
      /не соответствует/,
    );
  }
});
test('lost chunk response resumes from durable bytes; publication never uses PKG installer or reports installed', async () => {
  const f = await fixture('resume', 'ffpfsc'),
    p = await api.createImagePlan(f.path, f.item, signal, () => {});
  const transfers = new Map(),
    offsets = [],
    phases = [];
  let lost = false,
    calls = 0,
    published = false;
  const request = async (id, path, headers = {}, bytes) => {
    assert.equal(path.startsWith('/api/v1/install/'), false);
    let t = transfers.get(id);
    if (path.endsWith('/begin')) {
      if (t) return { status: 409, body: {} };
      t = {
        id,
        size: +headers['X-PackageFlow-Size'],
        blake3: headers['X-PackageFlow-Blake3'],
        bytesDurable: 0,
        verified: false,
        cancelled: false,
        chunkMax: 262144,
        bytes: Buffer.alloc(0),
      };
      transfers.set(id, t);
    }
    if (path.endsWith('/chunk')) {
      const offset = +headers['X-PackageFlow-Offset'];
      offsets.push([id, offset]);
      assert.equal(offset, t.bytesDurable);
      t.bytes = Buffer.concat([t.bytes, bytes]);
      t.bytesDurable += bytes.length;
      if (!lost) {
        lost = true;
        throw new Error('lost ACK');
      }
    }
    if (path === '/api/v1/transfers/commit') {
      assert.equal(t.blake3, digest(t.bytes));
      t.verified = true;
    }
    if (path === '/api/v1/images/commit') {
      assert.equal(headers['X-PackageFlow-Experimental'], 'image-publication-v1');
      assert.equal(transfers.get(p.id).bytes.toString(), api.imageManifest(p));
      assert.ok([...transfers.values()].every((t) => t.verified));
      calls++;
      published = true;
      return { status: 202, body: {} };
    }
    if (path === '/api/v1/images/status')
      return published ? { status: 200, body: publication(p) } : { status: 404, body: {} };
    return { status: 200, body: t };
  };
  const save = (patch) => {
    phases.push(patch.progressPhase);
    Object.assign(f.item, patch);
  };
  await assert.rejects(api.runImagePlan(p, f.item, signal, request, save), /lost ACK/);
  assert.equal(f.item.installDispatched, undefined);
  await api.runImagePlan(p, f.item, signal, request, save);
  assert.equal(offsets[1][1], 262144);
  assert.equal(f.item.bytesSent, f.item.size);
  assert.equal(calls, 1);
  assert.ok(phases.includes('device-check'));
  const result = await api.runImagePlan(p, f.item, signal, request, save);
  assert.equal(result.state, 'unconfirmed');
  assert.equal(calls, 1);
  assert.equal(result.confirmation, undefined);
  for (const patch of [
    { registered: true },
    { installed: true },
    { imageHash: '0'.repeat(64) },
    { size: 1 },
    { sourceName: 'foreign.exfat' },
    { content: 'foreign' },
  ]) {
    assert.throws(
      () => api.imagePublicationResult(p, { status: 200, body: { ...publication(p), ...patch } }),
      /не соответствует/,
    );
  }
});
test('lost publication reply is read-only on recovery even when the source was removed', async () => {
  const f = await fixture('lost-publish', 'exfat'),
    p = await api.createImagePlan(f.path, f.item, signal, () => {});
  f.item.hash = p.imageHash;
  f.item.sourceStamp = p.stamp;
  f.item.installDispatched = true;
  await rm(f.path);
  const paths = [];
  const request = async (id, path) => {
    paths.push(path);
    return path.endsWith('/images/status')
      ? { status: 404, body: {} }
      : { status: 200, body: { id, running: false, phase: 'publishing-image' } };
  };
  await assert.rejects(
    api.runImagePlan(p, f.item, signal, request, () => {}),
    /Повтор не отправлен/,
  );
  assert.deepEqual(paths, ['/api/v1/images/status', '/api/v1/operations/status']);
  const result = await api.runImagePlan(
    p,
    f.item,
    signal,
    async () => ({ status: 200, body: publication(p) }),
    () => {},
  );
  assert.equal(result.state, 'unconfirmed');
});
for (const batchMax of [16777216, 33554432, 67108864, 134217728])
  for (const format of ['ufs2', 'exfat', 'pfs', 'ffpfsc'])
    test(`${format} ${batchMax / 1048576} MiB uses qualified batches, resumes lost ACK and preserves image registration protocol`, async () => {
      const f = await fixture(`batch-${format}-${batchMax}`, format);
      // Retain real container metadata and add trailing space to cross batch boundaries.
      f.bytes = Buffer.concat([f.bytes, Buffer.alloc(36 * 1048576, 31)]);
      await writeFile(f.path, f.bytes);
      f.item.size = f.bytes.length;
      const p = await api.createImagePlan(f.path, f.item, signal, () => {});
      const transfers = new Map(),
        offsets = [];
      let lost = false,
        publications = 0;
      const request = async (id, path, headers = {}, bytes) => {
        assert.ok(!path.startsWith('/api/v1/install/'), 'images cannot use the PKG installer');
        let t = transfers.get(id);
        if (path.endsWith('/begin')) {
          if (t) return { status: 409, body: {} };
          t = {
            id,
            size: +headers['X-PackageFlow-Size'],
            blake3: headers['X-PackageFlow-Blake3'],
            bytesDurable: 0,
            cancelled: false,
            verified: false,
            chunkMax: 4194304,
            batchMax,
            bytes: Buffer.alloc(0),
          };
          transfers.set(id, t);
        }
        if (path.endsWith('/batch')) {
          assert.ok(bytes.length <= batchMax);
          assert.equal(+headers['X-PackageFlow-Offset'], t.bytesDurable);
          t.bytes = Buffer.concat([t.bytes, bytes]);
          t.bytesDurable += bytes.length;
          if (id === p.imageId) offsets.push(+headers['X-PackageFlow-Offset']);
          if (!lost) {
            lost = true;
            throw Error('lost batch ACK');
          }
        }
        assert.ok(!path.endsWith('/chunk'), 'qualified images use the pipelined route');
        if (path === '/api/v1/transfers/commit') {
          assert.equal(digest(t.bytes), t.blake3);
          t.verified = true;
        }
        if (path === '/api/v1/images/commit') {
          assert.equal(headers['X-PackageFlow-Image-Protocol'], 'image-registration-v1');
          assert.equal(transfers.get(p.id).bytes.toString(), api.imageManifest(p));
          assert.ok([...transfers.values()].every((t) => t.verified));
          publications++;
          return { status: 202, body: {} };
        }
        return { status: 200, body: t };
      };
      const save = (patch) => Object.assign(f.item, patch);
      await assert.rejects(
        api.runRegisteredImagePlan(p, f.item, signal, request, save),
        /lost batch ACK/,
      );
      assert.equal(publications, 0);
      await api.runRegisteredImagePlan(p, f.item, signal, request, save);
      assert.deepEqual(
        offsets,
        Array.from({ length: Math.ceil(f.bytes.length / batchMax) }, (_, i) => i * batchMax),
      );
      assert.equal(f.item.bytesSent, f.item.size);
      assert.equal(publications, 1);
    });
test('changed sources, wrong formats, PS4, patches, links and abort are rejected before publication', async () => {
  const f = await fixture('changed', 'exfat'),
    p = await api.createImagePlan(f.path, f.item, signal, () => {});
  await writeFile(f.path, Buffer.alloc(f.bytes.length, 7));
  let requests = 0;
  await assert.rejects(
    api.runImagePlan(
      p,
      f.item,
      signal,
      async () => {
        requests++;
        throw new Error();
      },
      () => {},
    ),
    /изменился/,
  );
  assert.equal(requests, 0);
  const valid = await fixture('valid', 'ufs2');
  await assert.rejects(
    api.createImagePlan(valid.path, { ...valid.item, format: 'exfat' }, signal, () => {}),
    /Формат/,
  );
  for (const patch of [{ platform: 'ps4' }, { order: 1 }, { titleId: '../bad' }, { format: 'pkg' }])
    await assert.rejects(
      api.createImagePlan(valid.path, { ...valid.item, ...patch }, signal, () => {}),
      /метаданные/,
    );
  const alias = join(work, 'alias');
  await symlink(valid.path, alias);
  await assert.rejects(
    api.createImagePlan(alias, valid.item, signal, () => {}),
    /обычным файлом/,
  );
  const stop = new AbortController();
  stop.abort(new Error('abort image'));
  await assert.rejects(
    api.createImagePlan(valid.path, valid.item, stop.signal, () => {}),
    /abort image/,
  );
});
test('admission never infers image support from PKG or prepared candidates', async () => {
  const ready = {
    service: 'PackageFlowService-PS5',
    schemaVersion: 1,
    route: 'staged-pkg',
    exactVersionReceipt: false,
    ready: true,
    reason: 'ready',
    formats: ['pkg'],
    platforms: ['ps4', 'ps5'],
    images: {
      schemaVersion: 1,
      route: 'staged-image',
      prepared: true,
      ready: false,
      candidateFormats: api.ps5ImageFormats,
      formats: [],
      registrationReceipt: false,
    },
  };
  assert.deepEqual(api.ps5InstallCapabilities(200, ready, '13.60').formats, ['pkg']);
  for (const format of api.ps5ImageFormats) {
    const item = { format, installDispatched: false };
    await assert.rejects(
      api
        .ps5QueueDriver('not-a-real-console')
        .run({ ...item, installDispatched: true }, signal, () => {}),
      /Повтор не отправлен/,
    );
  }
});

test('only exact verified image backend admits the four formats; image patches and PS4 are refused', () => {
  const images = {
    schemaVersion: 1,
    route: 'staged-image',
    protocol: 'image-registration-v1',
    backend: 'ShadowMountPlus-1.7beta3',
    ready: true,
    reason: 'ready',
    platforms: ['ps5'],
    formats: api.ps5ImageFormats,
    registrationReceipt: true,
  };
  const body = { service: 'PackageFlowService-PS5', schemaVersion: 1, images };
  const caps = api.ps5InstallCapabilities(200, body, '13.60');
  assert.deepEqual(caps.formats, api.ps5ImageFormats);
  for (const change of [
    { ready: false },
    { registrationReceipt: false },
    { protocol: 'other' },
    { backend: 'other' },
    { platforms: ['ps4'] },
    { formats: ['ufs2'] },
  ])
    assert.deepEqual(
      api.ps5InstallCapabilities(200, { ...body, images: { ...images, ...change } }, '13.60')
        .formats,
      [],
    );
  assert.deepEqual(api.ps5InstallCapabilities(200, body, '12.60').formats, []);
  const profile = {
    platform: 'ps5',
    firmware: '13.60',
    online: true,
    paired: true,
    capabilities: caps,
  };
  const base = { platform: 'ps5', format: 'exfat', size: 100, installOrder: 0 };
  assert.equal(api.deviceInstallReason(profile, [base], 100), '');
  assert.notEqual(api.deviceInstallReason(profile, [base, { ...base, installOrder: 1 }], 200), '');
  assert.notEqual(api.deviceInstallReason(profile, [base, { ...base, platform: 'ps4' }], 200), '');
});
test('registration recovery binds all receipt fields and does not reopen the source or send another commit', async () => {
  const f = await fixture('registration-recovery', 'exfat');
  const plan = await api.createImagePlan(f.path, f.item, signal, () => {});
  await rm(f.path);
  const item = { ...f.item, hash: plan.imageHash, installDispatched: true };
  const receipt = {
    ...publication(plan),
    proof: 'image-registration',
    state: 'registered',
    registered: true,
    installed: true,
  };
  const calls = [];
  const request = async (id, route) => {
    calls.push(route);
    assert.equal(id, plan.id);
    assert.equal(route, '/api/v1/images/status');
    return { status: 200, body: receipt };
  };
  const result = await api.runRegisteredImagePlan(plan, item, signal, request, () => {});
  assert.equal(result.state, 'installed');
  assert.equal(result.confirmation, 'service-registration');
  assert.equal(calls.length, 1);
  for (const patch of [
    { title: 'PPSA99999' },
    { content: 'wrong' },
    { version: '99.999.999' },
    { imageHash: '0'.repeat(64) },
    { manifestHash: '0'.repeat(64) },
    { sourceName: 'other.exfat' },
    { size: 1 },
    { proof: 'image-publication' },
    { registered: false },
    { state: 'published' },
  ])
    assert.throws(
      () => api.imageRegistrationResult(plan, { status: 200, body: { ...receipt, ...patch } }),
      /не соответствует/,
    );
  let saved;
  const waiting = await api.runRegisteredImagePlan(
    plan,
    item,
    signal,
    async () => ({
      status: 200,
      body: { ...receipt, state: 'published', installed: false, registered: false },
    }),
    (patch) => (saved = patch),
  );
  assert.equal(waiting.state, 'installing');
  assert.ok(saved.imagePublishedAt);
  await assert.rejects(
    api.runRegisteredImagePlan(
      plan,
      { ...item, imagePublishedAt: Date.now() - 121000 },
      signal,
      async () => ({
        status: 200,
        body: { ...receipt, state: 'published', installed: false, registered: false },
      }),
      () => {},
    ),
    /не подтверждена/,
  );
});

test('all four production image routes refuse a higher PARAM minimum before hashing, transfer or mounting', async () => {
  const previousFetch = globalThis.fetch,
    calls = [],
    sources = [];
  let activated = false;
  try {
    await mkdir(process.env.PACKAGEFLOW_DATA_DIR, { recursive: true });
    const profile = api.saveConsoleProfile({
      name: 'Image firmware fixture',
      platform: 'ps5',
      ip: '192.168.1.5',
    }).consoles[0];
    await writeFile(
      join(process.env.PACKAGEFLOW_DATA_DIR, 'ps5-service-keys.json'),
      JSON.stringify({ [profile.ip]: 'd'.repeat(64) }),
    );
    globalThis.fetch = async (url, options) => {
      const path = new URL(url).pathname;
      calls.push(path);
      assert.equal(options.method, 'GET');
      if (path === '/health')
        return new Response(
          JSON.stringify({
            apiVersion: 'v1',
            firmwareRead: true,
            firmwareRaw: '0x13600007',
            ...(activated
              ? {
                  pid: 97,
                  startedAt: 1792146534,
                  backend: 'embedded',
                  pkgBackendVersion: '1.4.0-embedded-029',
                }
              : {}),
            serviceReport: {
              service: 'PackageFlowService-PS5',
              consoleVerified: true,
              ...(activated
                ? {
                    platform: 'ps5',
                    version: '0.1.29-dev',
                    buildId: 'ps5-service-pkg-context-029c-sse2',
                  }
                : {}),
            },
          }),
        );
      if (path === '/api/v1/capabilities')
        return new Response(
          JSON.stringify({
            service: 'PackageFlowService-PS5',
            capabilities: { installPs5Content: true },
          }),
        );
      if (path === '/api/v1/system')
        return new Response(
          JSON.stringify({ service: 'PackageFlowService-PS5', storageRead: false }),
        );
      assert.equal(path, '/api/v1/install/readiness');
      return new Response(
        JSON.stringify({
          service: 'PackageFlowService-PS5',
          schemaVersion: 1,
          images: {
            schemaVersion: 1,
            route: 'staged-image',
            protocol: 'image-registration-v1',
            backend: 'ShadowMountPlus-1.7beta3',
            ready: true,
            reason: 'ready',
            platforms: ['ps5'],
            formats: api.ps5ImageFormats,
            registrationReceipt: true,
          },
        }),
      );
    };
    await api.probeConsoleProfile(profile.id);
    calls.length = 0;
    for (const format of api.ps5ImageFormats) {
      const f = await fixture(`blocked-${format}`, format);
      const indexed = {
        ...f.item,
        id: f.item.packageId,
        path: f.path,
        fileName: 'image',
        title: 'Owned image fixture',
        type: 'Игра',
        installOrder: 0,
        libraryRoot: work,
        sourceModifiedAt: 1,
        iconSize: 0,
        icon: { offset: 0, size: 0 },
      };
      sources.push({ f, indexed });
      await writeFile(
        join(process.env.PACKAGEFLOW_DATA_DIR, 'package-library.json'),
        JSON.stringify({
          version: 2,
          packages: [indexed],
          deliveries: {},
        }),
      );
      await assert.rejects(
        api.ps5QueueDriver(profile.id).run(f.item, signal, (patch) => Object.assign(f.item, patch)),
        /PARAM 14.00.*13.60/,
      );
      assert.equal(f.item.hash, undefined);
      assert.equal(f.item.bytesSent, 0);
    }
    assert.equal(
      calls.length,
      8,
      'only readiness and live firmware GETs, no transfer/registration',
    );
    const directory = join(process.env.PACKAGEFLOW_DATA_DIR, 'consoles', profile.id);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'ps5-qualified-routes.json'),
      JSON.stringify({
        schemaVersion: 1,
        consoleId: profile.id,
        ip: profile.ip,
        firmware: '13.60',
        serviceBuild: 'ps5-service-pkg-context-029c-sse2',
        serviceVersion: '0.1.29-dev',
        userEnabledFormats: ['folder', 'ufs2', 'exfat', 'pfs', 'ffpfsc'],
        folderProtocol: 'folder-stream-v2',
        imageProtocol: 'image-registration-v1',
        imageBackend: 'ShadowMountPlus-1.7beta3',
        qualification: {
          folderReceiptId: 'a'.repeat(32),
          streamReceiptId: 'b'.repeat(32),
          imageMarkerSha256: 'c'.repeat(64),
        },
      }),
    );
    activated = true;
    calls.length = 0;
    for (const { f, indexed } of sources) {
      await writeFile(
        join(process.env.PACKAGEFLOW_DATA_DIR, 'package-library.json'),
        JSON.stringify({ version: 2, packages: [indexed], deliveries: {} }),
      );
      await assert.rejects(
        api.ps5QueueDriver(profile.id).run(f.item, signal, (patch) => Object.assign(f.item, patch)),
        /PARAM 14.00.*13.60/,
      );
      assert.equal(f.item.hash, undefined);
      assert.equal(f.item.bytesSent, 0);
    }
    assert.ok(calls.includes('/api/v1/capabilities'));
    assert.ok(!calls.includes('/api/v1/install/readiness'));
    assert.ok(calls.every((path) => ['/health', '/api/v1/capabilities'].includes(path)));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test.after(async () => {
  await rm(work, { recursive: true, force: true });
});
