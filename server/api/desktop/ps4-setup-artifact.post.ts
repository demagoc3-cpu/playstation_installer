import { lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dataPath } from '../../utils/data-path';
import { assertDesktopControl } from '../../utils/desktop-control';
import { assertInstallationOrigin } from '../../utils/installation-origin';
import { downloadLatestServicePackage, stageServicePackage } from '../../utils/service-updates';

export default defineEventHandler(async (event) => {
  assertDesktopControl(event);
  assertInstallationOrigin(event, true);
  const manifestPath = dataPath('console-setup', 'manifest.json');
  let manifest;
  try {
    if ((await lstat(manifestPath)).isSymbolicLink()) throw new Error('Invalid setup manifest');
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!manifest?.ps4) return downloadLatestServicePackage('0.00');
  const a = manifest.ps4;
  if (
    manifest.schemaVersion !== 1 ||
    a.titleId !== 'PFLS00001' ||
    !/^\d+\.\d+$/.test(a.version) ||
    !/^PackageFlowService-[0-9.]+\.pkg$/.test(a.fileName) ||
    !/^[a-f0-9]{64}$/.test(a.sha256) ||
    !Number.isSafeInteger(a.size) ||
    a.size < 4096 ||
    a.size > 25 * 1024 ** 2
  )
    throw new Error('Invalid bundled PS4 package');
  const path = dataPath('console-setup', a.fileName),
    info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size !== a.size)
    throw new Error('Bundled PS4 package size changed');
  const data = await readFile(path);
  if (createHash('sha256').update(data).digest('hex') !== a.sha256)
    throw new Error('Bundled PS4 package checksum changed');
  const staged = await stageServicePackage(data, a.sha256);
  if (staged.version !== a.version)
    throw new Error('Bundled PS4 SFO version differs from manifest');
  return staged;
});
