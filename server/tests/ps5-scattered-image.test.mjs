import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

function scatteredImage(contiguous = false, unusedIndirect = 0) {
  const param = Buffer.from(
    JSON.stringify({
      titleId: 'PPSA95009',
      contentId: 'IV0000-PPSA95009_00-PACKAGEFLOWTEST01',
      applicationCategoryType: 0,
      contentVersion: '01.000.004',
      localizedParameters: {
        defaultLanguage: 'en-US',
        'en-US': { titleName: 'Scattered image test' },
      },
    }),
  );
  const inner = Buffer.alloc(1024 * 1024);
  inner.write('EXFAT   ', 3);
  inner.writeUInt16LE(0xaa55, 510);
  inner[108] = 9;
  inner[109] = 0;
  inner.writeUInt32LE(24, 80);
  inner.writeUInt32LE(128, 88);
  inner.writeUInt32LE(1792, 92);
  inner.writeUInt32LE(2, 96);
  function exfatEntry(at, name, directory, cluster, size) {
    inner[at] = 0x85;
    inner[at + 1] = 2;
    inner.writeUInt16LE(directory ? 0x10 : 0, at + 4);
    inner[at + 32] = 0xc0;
    inner[at + 33] = 2;
    inner[at + 35] = name.length;
    inner.writeUInt32LE(cluster, at + 52);
    inner.writeBigUInt64LE(BigInt(size), at + 56);
    inner[at + 64] = 0xc1;
    inner.write(name, at + 66, 'utf16le');
  }
  exfatEntry(65536, 'sce_sys', true, 3, 512);
  exfatEntry(65536 + 512, 'param.json', false, 4, param.length);
  param.copy(inner, 65536 + 1024);
  const unit = 65536,
    entries = inner.length / unit,
    table = 48,
    dataStart = table + (entries + 1) * 8;
  const packed = Buffer.alloc(dataStart + inner.length);
  packed.write('PFSC');
  packed.writeUInt32LE(6, 8);
  packed.writeUInt32LE(unit, 12);
  packed.writeBigUInt64LE(BigInt(unit), 16);
  packed.writeBigUInt64LE(BigInt(table), 24);
  packed.writeBigUInt64LE(BigInt(inner.length), 40);
  for (let i = 0; i <= entries; i++)
    packed.writeBigUInt64LE(BigInt(dataStart + i * unit), table + i * 8);
  inner.copy(packed, dataStart);
  const block = 4096,
    count = Math.ceil(packed.length / block),
    pointers = Array.from({ length: count }, (_, i) => 5 + i * (contiguous ? 1 : 2));
  const image = Buffer.alloc((pointers.at(-1) + 1) * block);
  image.writeBigUInt64LE(2n);
  image.writeBigUInt64LE(20130315n, 8);
  image.writeUInt32LE(block, 32);
  image.writeBigUInt64LE(2n, 48);
  image.writeBigUInt64LE(1n, 64);
  function dirent(at, id, name, kind) {
    const length = Math.ceil((16 + name.length + 1) / 8) * 8;
    image.writeUInt32LE(id, at);
    image.writeUInt32LE(kind, at + 4);
    image.writeUInt32LE(name.length, at + 8);
    image.writeUInt32LE(length, at + 12);
    image.write(name, at + 16);
    return length;
  }
  dirent(2 * block, 0, 'uroot', 3);
  const length = dirent(3 * block, 1, 'fixture.exfat', 2);
  image.writeBigUInt64LE(BigInt(length), block + 8);
  image.writeUInt32LE(1, block + 96);
  image.writeUInt32LE(3, block + 100);
  const inode = block + 168;
  image.writeUInt32LE(1, inode + 4);
  image.writeBigUInt64LE(BigInt(packed.length), inode + 8);
  image.writeBigUInt64LE(BigInt(inner.length), inode + 16);
  image.writeUInt32LE(count, inode + 96);
  for (let i = 0; i < count; i++) {
    if (!contiguous) {
      if (i < 12) image.writeUInt32LE(pointers[i], inode + 100 + i * 4);
      else image.writeUInt32LE(pointers[i], 4 * block + (i - 12) * 4);
    }
    packed.subarray(i * block, (i + 1) * block).copy(image, pointers[i] * block);
  }
  if (contiguous) {
    image.writeUInt32LE(pointers[0], inode + 100);
    for (let i = 1; i < 12; i++) image.writeUInt32LE(0xffffffff, inode + 100 + i * 4);
    for (let i = 0; i < 5; i++) image.writeUInt32LE(unusedIndirect, inode + 148 + i * 4);
  } else image.writeUInt32LE(4, inode + 148);
  return image;
}

test('compressed PFS metadata follows scattered direct and indirect blocks and rejects invalid pointers', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-scattered-image-'));
  try {
    const bundle = join(work, 'metadata.mjs');
    await build({
      entryPoints: [resolve('server/utils/ps5-content-metadata.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const { readPs5ImageMetadata } = await import(pathToFileURL(bundle).href);
    const path = join(work, 'own.ffpfsc'),
      image = scatteredImage();
    writeFileSync(path, image);
    const result = await readPs5ImageMetadata(path);
    assert.equal(result.titleId, 'PPSA95009');
    assert.equal(result.title, 'Scattered image test');
    assert.equal(result.format, 'ffpfsc');
    const broken = Buffer.from(image);
    broken.writeUInt32LE(0xffffffff, 4 * 4096 + (16 - 12) * 4);
    writeFileSync(path, broken);
    await assert.rejects(readPs5ImageMetadata(path), /Invalid PFS allocation/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('contiguous PFSC accepts both unused-indirect sentinels without following them as pointers', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-contiguous-image-'));
  try {
    const bundle = join(work, 'metadata.mjs');
    await build({
      entryPoints: [resolve('server/utils/ps5-content-metadata.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const { readPs5ImageMetadata } = await import(pathToFileURL(bundle).href);
    const path = join(work, 'own.ffpfsc');
    for (const sentinel of [0, 0xffffffff]) {
      writeFileSync(path, scatteredImage(true, sentinel));
      const result = await readPs5ImageMetadata(path);
      assert.equal(result.titleId, 'PPSA95009');
      assert.equal(result.format, 'ffpfsc');
    }
    const broken = scatteredImage(true, 0xffffffff);
    broken.writeUInt32LE(0xffffffff, 4096 + 168 + 100);
    writeFileSync(path, broken);
    await assert.rejects(readPs5ImageMetadata(path), /Invalid PFS allocation/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
