// CI input: download the pinned console bundle (PS5 service ELF, PS5 app,
// PS4 service) for a release and verify every file against its pin before
// packaging.
//
//   node scripts/fetch-console-bundle.mjs <version> <destination>
//
// Pin: packaging/windows/console-bundle-<version>.json, else the
// console-bundle.json that release.yml attached to the release vX.Y.Z, else
// the newest older committed pin.
//
// Files: one GitHub release per version (vX.Y.Z) carries everything. Each
// pinned file is taken from the release of this version when it is attached
// there, otherwise from any earlier release that has an asset with the same
// SHA-256 under its release name (PackageFlow-PS4_2.14.pkg, see
// console-release-names.mjs) or its pinned name. It is saved under the pinned
// name. Nothing is trusted that the pin does not name.
// PF_BUNDLE_BASE_URL overrides the lookup with a plain directory URL.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { consoleReleaseName } from './console-release-names.mjs';

const [version, destination] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version || '') || !destination)
  throw new Error('Usage: node scripts/fetch-console-bundle.mjs <version> <destination>');

const pins = new URL('../packaging/windows/', import.meta.url);
const key = (v) => v.split('.').map(Number);
const older = (a, b) => {
  const x = key(a),
    y = key(b);
  for (let i = 0; i < 3; ++i) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
};

const repository = process.env.GITHUB_REPOSITORY || 'demagoc3-cpu/playstation_installer';
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const headers = (accept) => ({
  Accept: accept,
  'User-Agent': 'PackageFlow-CI',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

let releases;
async function allReleases() {
  if (releases) return releases;
  releases = [];
  for (let page = 1; page <= 10; ++page) {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
      { headers: headers('application/vnd.github+json'), signal: AbortSignal.timeout(30000) },
    );
    if (!response.ok) throw new Error(`GitHub releases: ${response.status}`);
    const batch = await response.json();
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  // The release of this version first, then the newest others.
  const own = `v${version}`;
  releases.sort((a, b) => (a.tag_name === own ? -1 : b.tag_name === own ? 1 : 0));
  return releases;
}

const committed = (await readdir(pins))
  .map((name) => name.match(/^console-bundle-(\d+\.\d+\.\d+)\.json$/)?.[1])
  .filter((v) => v && !older(version, v))
  .sort((a, b) => (older(a, b) ? 1 : -1));
// A release built by release.yml records its bundle as console-bundle.json, so
// a rebuild of that version packages the same console files.
async function releasedPin() {
  const release = (await allReleases()).find((r) => r.tag_name === `v${version}`);
  const asset = release?.assets?.find((a) => a.name === 'console-bundle.json');
  if (!asset) return undefined;
  const response = await fetch(asset.url, {
    headers: headers('application/octet-stream'),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`console-bundle.json: download failed (${response.status})`);
  return response.text();
}
let pinVersion = committed[0],
  pinText;
if (pinVersion !== version && (pinText = await releasedPin())) {
  pinVersion = version;
  console.log(`Using console-bundle.json of the release v${version}`);
} else {
  if (!pinVersion) throw new Error(`No console bundle pin for ${version} or older`);
  if (pinVersion !== version) console.log(`Using console bundle pin ${pinVersion} for ${version}`);
  pinText = await readFile(new URL(`console-bundle-${pinVersion}.json`, pins), 'utf8');
}
const pin = JSON.parse(pinText);

async function source(role, entry) {
  if (process.env.PF_BUNDLE_BASE_URL)
    return {
      url: `${process.env.PF_BUNDLE_BASE_URL}/${encodeURIComponent(entry.fileName)}`,
      accept: '*/*',
    };
  for (const release of await allReleases()) {
    const asset = (release.assets || []).find(
      (a) =>
        (a.name === consoleReleaseName(role, entry) || a.name === entry.fileName) &&
        a.size === entry.size &&
        (!a.digest || a.digest === `sha256:${entry.sha256}`),
    );
    if (asset) {
      console.log(`${entry.fileName}: ${asset.name} from release ${release.tag_name}`);
      return { url: asset.url, accept: 'application/octet-stream' };
    }
  }
  throw new Error(
    `${consoleReleaseName(role, entry)} (sha256 ${entry.sha256}) is not attached to any release. ` +
      `Attach it to the release v${version} and run the build again.`,
  );
}

const target = resolve(destination);
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const role of ['elf', 'app', ...(pin.ps4 ? ['ps4'] : [])]) {
  const entry = pin[role];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.fileName))
    throw new Error(`Invalid file name in pin: ${entry.fileName}`);
  const { url, accept } = await source(role, entry);
  const response = await fetch(url, {
    headers: headers(accept),
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
console.log(`Console bundle ${pinVersion} ready in ${target}`);
