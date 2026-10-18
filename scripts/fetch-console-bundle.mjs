// CI input: download the pinned console bundle (PS5 service ELF, PS5 app,
// PS4 service) for a release and verify every file against
// packaging/windows/console-bundle-<version>.json before packaging.
//
//   node scripts/fetch-console-bundle.mjs <version> <destination>
//
// Files are taken from the GitHub release tagged console-bundle-<version> of
// GITHUB_REPOSITORY (or PF_BUNDLE_BASE_URL when set). Nothing is trusted that
// the pin does not name.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [version, destination] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version || '') || !destination)
  throw new Error('Usage: node scripts/fetch-console-bundle.mjs <version> <destination>');
const pinText = await readFile(
  new URL(`../packaging/windows/console-bundle-${version}.json`, import.meta.url),
  'utf8',
);
const pin = JSON.parse(pinText);
const repository = process.env.GITHUB_REPOSITORY || 'demagoc3-cpu/playstation_installer';
const base =
  process.env.PF_BUNDLE_BASE_URL ||
  `https://github.com/${repository}/releases/download/console-bundle-${version}`;
const target = resolve(destination);
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const role of ['elf', 'app', ...(pin.ps4 ? ['ps4'] : [])]) {
  const entry = pin[role];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.fileName))
    throw new Error(`Invalid file name in pin: ${entry.fileName}`);
  const response = await fetch(`${base}/${encodeURIComponent(entry.fileName)}`, {
    redirect: 'follow',
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) throw new Error(`${entry.fileName}: download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== entry.size || digest !== entry.sha256)
    throw new Error(`${entry.fileName}: size or SHA-256 differs from the pin`);
  await writeFile(join(target, `${entry.fileName}.part`), bytes);
  await rename(join(target, `${entry.fileName}.part`), join(target, entry.fileName));
  console.log(`verified ${entry.fileName} ${digest}`);
}
await writeFile(join(target, 'manifest.json'), pinText);
console.log(`Console bundle ${version} ready in ${target}`);
