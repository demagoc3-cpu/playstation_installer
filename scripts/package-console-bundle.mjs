import { mkdir, readFile, lstat, copyFile, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Build-time inclusion of approved PS5 binaries. No private repository access.
export async function packageConsoleBundle(source, target) {
  if (!source) {
    await rm(target, { recursive: true, force: true });
    return false;
  }
  const root = resolve(source),
    manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !manifest.elf || !manifest.app)
    throw new Error('Incomplete PS5 bundle');
  for (const role of ['elf', 'app', ...(manifest.ps4 ? ['ps4'] : [])]) {
    const a = manifest[role];
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(a.fileName) ||
      a.fileName.includes('..') ||
      !/^[a-f0-9]{64}$/.test(a.sha256) ||
      !Number.isSafeInteger(a.size) ||
      a.size < 4096 ||
      a.size > (role === 'elf' ? 4 : 256) * 1024 ** 2
    )
      throw new Error('Invalid PS5 artifact');
    const file = join(root, a.fileName),
      info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== a.size)
      throw new Error('PS5 artifact size changed');
    const bytes = await readFile(file);
    if (createHash('sha256').update(bytes).digest('hex') !== a.sha256)
      throw new Error('PS5 artifact checksum mismatch');
    if (
      role === 'elf' &&
      (!bytes.subarray(0, 6).equals(Buffer.from('7f454c460201', 'hex')) ||
        bytes.readUInt16LE(18) !== 62 ||
        // Optional since 030b: the firmware list the ELF was checked on, never a gate.
        !(
          a.firmware === undefined ||
          (typeof a.firmware === 'string' &&
            /^\d{1,2}\.\d{2}(?:,\d{1,2}\.\d{2}){0,15}$/.test(a.firmware))
        ) ||
        !/^\d+\.\d+\.\d+(?:-dev)?$/.test(a.version) ||
        !/^[a-z0-9-]{1,64}$/.test(a.buildId))
    )
      throw new Error('Invalid PS5 ELF');
    if (
      role === 'ps4' &&
      (!/^\d+\.\d+$/.test(a.version) ||
        a.titleId !== 'PFLS00001' ||
        !a.fileName.endsWith('.pkg') ||
        a.size > 25 * 1024 ** 2)
    )
      throw new Error('Invalid PS4 application');
    if (
      role === 'app' &&
      (a.name !== 'PackageFlow' ||
        !/^PPSA\d{5}$/.test(a.titleId) ||
        typeof a.contentId !== 'string' ||
        !a.contentId.includes(`${a.titleId}_`) ||
        !/^\d{2}\.\d{3}\.\d{3}$/.test(a.version) ||
        !['ufs2', 'exfat', 'pfs', 'ffpfsc'].includes(a.format) ||
        a.fileName === manifest.elf.fileName)
    )
      throw new Error('Invalid PackageFlow PS5 application');
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const role of ['elf', 'app', ...(manifest.ps4 ? ['ps4'] : [])])
    await copyFile(join(root, manifest[role].fileName), join(target, manifest[role].fileName));
  await copyFile(join(root, 'manifest.json'), join(target, 'manifest.json.tmp'));
  await rename(join(target, 'manifest.json.tmp'), join(target, 'manifest.json'));
  return true;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[3])
    throw new Error(
      'Usage: node package-console-bundle.mjs <bundle-directory-or-empty> <destination>',
    );
  console.log(
    (await packageConsoleBundle(
      process.argv[2] === '-' ? '' : process.argv[2],
      resolve(process.argv[3]),
    ))
      ? 'Verified PS5 bundle included'
      : 'PS5 binaries not included; PS4 setup remains available',
  );
}
