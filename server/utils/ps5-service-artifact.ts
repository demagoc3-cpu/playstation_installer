import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { SetupElf } from './console-setup-artifacts';
import { dataPath } from './data-path';

export const PS5_SERVICE_ELF_FILE_NAME = 'PackageFlowService-PS5.elf';
const MAX_ELF_BYTES = 4 * 1024 ** 2;

export function validatePs5ServiceManifest(value: unknown): SetupElf {
  const root = value as { schemaVersion?: unknown; elf?: Partial<SetupElf> } | null;
  const elf = root?.elf;
  if (
    root?.schemaVersion !== 1 ||
    !elf ||
    elf.fileName !== PS5_SERVICE_ELF_FILE_NAME ||
    !Number.isSafeInteger(elf.size) ||
    typeof elf.size !== 'number' ||
    elf.size < 4096 ||
    elf.size > MAX_ELF_BYTES ||
    typeof elf.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(elf.sha256) ||
    typeof elf.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-dev)?$/.test(elf.version) ||
    typeof elf.buildId !== 'string' ||
    !/^[a-z0-9-]{1,64}$/.test(elf.buildId) ||
    elf.firmware !== '13.60'
  )
    throw new Error(
      'Неверный манифест службы PS5: требуется проверенная PackageFlowService-PS5.elf для 13.60',
    );
  return {
    fileName: elf.fileName,
    size: elf.size,
    sha256: elf.sha256,
    version: elf.version,
    buildId: elf.buildId,
    firmware: elf.firmware,
  };
}

async function fingerprint(path: string, maximum: number) {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile() || info.size > BigInt(maximum))
    throw new Error('Неверный путь или размер файла службы PS5');
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

async function assertDirectories(directory: string) {
  const parents: string[] = [];
  let current = resolve(directory);
  for (;;) {
    parents.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const directory of parents) {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error('Каталог комплекта службы PS5 не должен быть ссылкой');
  }
}

async function manifestPath() {
  await assertDirectories(dataPath());
  const standalone = dataPath('ps5-service-artifacts');
  let standaloneExists = true;
  try {
    await lstat(standalone);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    standaloneExists = false;
  }
  if (standaloneExists) {
    await assertDirectories(standalone);
    const path = dataPath('ps5-service-artifacts', 'manifest.json');
    try {
      await lstat(path);
      // A present immutable release is authoritative, including when damaged.
      return { path, standalone: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await assertDirectories(dataPath('console-setup'));
  const dedicated = dataPath('console-setup', 'service-manifest.json');
  try {
    await lstat(dedicated);
    return { path: dedicated, standalone: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { path: dataPath('console-setup', 'manifest.json'), standalone: false };
  }
}

/** Read the service independently of the optional native application image. */
export async function readPs5ServiceArtifact(): Promise<{ manifest: SetupElf; bytes: Buffer }> {
  try {
    const location = await manifestPath();
    const { path } = location;
    const manifestBefore = await fingerprint(path, 16 * 1024);
    const manifest = validatePs5ServiceManifest(JSON.parse(await readFile(path, 'utf8')));
    // The digest is validated before it is used as a directory component.
    const directory = location.standalone
      ? dataPath('ps5-service-artifacts', manifest.sha256)
      : dataPath('console-setup');
    await assertDirectories(directory);
    const elfPath = resolve(directory, manifest.fileName);
    const elfBefore = await fingerprint(elfPath, MAX_ELF_BYTES);
    const bytes = await readFile(elfPath);
    if (
      bytes.length !== manifest.size ||
      !bytes.subarray(0, 6).equals(Buffer.from('7f454c460201', 'hex')) ||
      bytes.readUInt16LE(18) !== 62
    )
      throw new Error('Файл службы PS5 не является ожидаемым ELF x64');
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256)
      throw new Error('Контрольная сумма службы PS5 не совпала');
    if (
      manifestBefore !== (await fingerprint(path, 16 * 1024)) ||
      elfBefore !== (await fingerprint(elfPath, MAX_ELF_BYTES))
    )
      throw new Error('Комплект службы PS5 изменился при проверке');
    await assertDirectories(directory);
    return { manifest, bytes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(
        'Комплект службы PS5 отсутствует. Добавьте проверенную ELF и её манифест в ps5-service-artifacts или console-setup',
        { cause: error },
      );
    throw error;
  }
}

/** Public metadata contains no local path and does not require a PackageFlow app image. */
export async function getPs5ServiceArtifactInfo(): Promise<SetupElf> {
  return (await readPs5ServiceArtifact()).manifest;
}
