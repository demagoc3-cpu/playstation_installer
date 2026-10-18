// Copies a verified console bundle into release files with readable names,
// adds the PS5 service manifest for update checks and their checksums.
//
//   node scripts/console-release-files.mjs <bundle-directory> <destination>
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { consoleReleaseName } from './console-release-names.mjs';

const [bundle, destination] = process.argv.slice(2);
if (!bundle || !destination)
  throw new Error('Usage: node scripts/console-release-files.mjs <bundle> <destination>');
const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'));
const target = resolve(destination);
await mkdir(target, { recursive: true });
const sums = [];
for (const role of ['elf', 'app', ...(manifest.ps4 ? ['ps4'] : [])]) {
  const name = consoleReleaseName(role, manifest[role]);
  await copyFile(join(bundle, manifest[role].fileName), join(target, name));
  const digest = createHash('sha256')
    .update(await readFile(join(target, name)))
    .digest('hex');
  if (digest !== manifest[role].sha256) throw new Error(`${name}: SHA-256 differs from the pin`);
  sums.push(`${digest}  ${name}`);
}
// PS5 service update check (server/utils/ps5-service-github.ts).
await writeFile(
  join(target, 'PackageFlowService-PS5.json'),
  JSON.stringify({ schemaVersion: 1, elf: manifest.elf }, null, 2) + '\n',
);
await writeFile(join(target, 'SHA256SUMS-console.txt'), sums.join('\n') + '\n');
console.log(sums.join('\n'));
