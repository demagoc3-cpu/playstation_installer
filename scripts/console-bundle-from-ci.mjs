// Release input without hand-copied files: take the console files from the
// newest successful main-branch build of each console repository and write
// the bundle (pinned file names + manifest.json) that the Windows and Linux
// packaging verify.
//
//   PACKAGEFLOW_REPOS_TOKEN=… node scripts/console-bundle-from-ci.mjs <destination>
//
// The token needs Actions: read and Contents: read on the three repositories.
// Every file is checked against the SHA256SUMS of its own build.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const owner = 'demagoc3-cpu';
const sources = {
  elf: { repo: 'PackageFlowPayload-PS5', workflow: 'elf.yml', artifact: 'PackageFlow-PS5-ELF' },
  app: {
    repo: 'PackageFlowService-PS5',
    workflow: 'native-ui.yml',
    artifact: 'PackageFlow-PS5-app',
  },
  ps4: { repo: 'PackageFlowService', workflow: 'build.yml', artifact: 'PackageFlow-PS4-pkg' },
};

const [destination] = process.argv.slice(2);
const token = process.env.PACKAGEFLOW_REPOS_TOKEN || '';
if (!destination) throw new Error('Usage: node scripts/console-bundle-from-ci.mjs <destination>');
if (!token) throw new Error('PACKAGEFLOW_REPOS_TOKEN is not set');

async function api(path, accept = 'application/vnd.github+json') {
  const url = path.startsWith('https://') ? path : `https://api.github.com${path}`;
  const response = await fetch(url, {
    headers: { Accept: accept, Authorization: `Bearer ${token}`, 'User-Agent': 'PackageFlow-CI' },
    redirect: 'follow',
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) throw new Error(`GitHub ${path}: ${response.status}`);
  return response;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const work = await mkdtemp(join(tmpdir(), 'pf-console-'));

/** Newest successful main build of a console repository, unpacked and verified. */
async function latestBuild(role) {
  const { repo, workflow, artifact } = sources[role];
  const runs = await (
    await api(
      `/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?branch=main&status=success&per_page=10`,
    )
  ).json();
  for (const run of runs.workflow_runs || []) {
    const list = await (
      await api(`/repos/${owner}/${repo}/actions/runs/${run.id}/artifacts?name=${artifact}`)
    ).json();
    const found = (list.artifacts || []).find((a) => a.name === artifact && !a.expired);
    if (!found) continue;
    const zip = Buffer.from(await (await api(found.archive_download_url, '*/*')).arrayBuffer());
    const directory = join(work, role);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'artifact.zip'), zip);
    execFileSync('unzip', ['-q', '-o', 'artifact.zip'], { cwd: directory });
    await rm(join(directory, 'artifact.zip'));
    const sums = await readFile(join(directory, 'SHA256SUMS'), 'utf8');
    for (const line of sums.trim().split('\n')) {
      const [digest, name] = line.trim().split(/\s+\*?/);
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ||
        sha256(await readFile(join(directory, name))) !== digest
      )
        throw new Error(`${repo}: ${name} differs from its SHA256SUMS`);
    }
    console.log(`${repo}: ${workflow} run ${run.id} at ${run.head_sha.slice(0, 7)}`);
    return { directory, run, files: await readdir(directory) };
  }
  throw new Error(`${repo}: no successful main build of ${workflow} with ${artifact}`);
}

const target = resolve(destination);
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
async function take(directory, from, to) {
  const bytes = await readFile(join(directory, from));
  await writeFile(join(target, to), bytes);
  return { size: bytes.length, sha256: sha256(bytes) };
}

// PS5 service: version and build ID are the strings the ELF reports, as set in
// include/packageflow/version.h of its source commit.
const elfBuild = await latestBuild('elf');
const elfSource = JSON.parse(
  await readFile(join(elfBuild.directory, 'build-manifest.json'), 'utf8'),
);
const versionHeader = await (
  await api(
    `/repos/${owner}/${sources.elf.repo}/contents/include/packageflow/version.h?ref=${elfSource.source_commit}`,
    'application/vnd.github.raw+json',
  )
).text();
const elfBytes = (await readFile(join(elfBuild.directory, 'PackageFlowService-PS5.elf'))).toString(
  'latin1',
);
const reported = (name) =>
  [...versionHeader.matchAll(new RegExp(`#define ${name} "([^"]+)"`, 'g'))]
    .map((m) => m[1])
    .find((value) => elfBytes.includes(value));
const elfVersion = reported('PF_REPORT_VERSION'),
  elfBuildId = reported('PF_REPORT_BUILD');
if (!elfVersion || !elfBuildId) throw new Error('PS5 service version is not in the ELF');
const elf = {
  fileName: 'PackageFlowService-PS5.elf',
  ...(await take(elfBuild.directory, 'PackageFlowService-PS5.elf', 'PackageFlowService-PS5.elf')),
  version: elfVersion,
  buildId: elfBuildId,
  // Firmware the ELF was checked on, as its build declares it ("12.20,13.60");
  // builds before that declaration were checked on 13.60.
  firmware:
    [elfSource.firmware]
      .flat()
      .filter((v) => typeof v === 'string' && /^\d{1,2}\.\d{2}$/.test(v))
      .join(',') || '13.60',
};

// PS5 app: PackageFlow-PS5_<contentVersion>.ffpkg.
const appBuild = await latestBuild('app');
const appFile = appBuild.files.find((f) => /^PackageFlow-PS5_\d{2}\.\d{3}\.\d{3}\.ffpkg$/.test(f));
if (!appFile) throw new Error('PS5 app build has no PackageFlow-PS5_<version>.ffpkg');
const appVersion = appFile.slice('PackageFlow-PS5_'.length, -'.ffpkg'.length);
const app = {
  fileName: `PPSA95001-${appVersion}.ffpkg`,
  ...(await take(appBuild.directory, appFile, `PPSA95001-${appVersion}.ffpkg`)),
  name: 'PackageFlow',
  titleId: 'PPSA95001',
  contentId: 'IV0000-PPSA95001_00-PACKAGEFLOWUI001',
  version: appVersion,
  format: 'ufs2',
  buildId: appBuild.run.head_sha.slice(0, 7),
};

// PS4 service: PackageFlow-PS4_<version>.pkg.
const ps4Build = await latestBuild('ps4');
const ps4File = ps4Build.files.find((f) => /^PackageFlow-PS4_\d+\.\d+\.pkg$/.test(f));
if (!ps4File) throw new Error('PS4 build has no PackageFlow-PS4_<version>.pkg');
const ps4Version = ps4File.slice('PackageFlow-PS4_'.length, -'.pkg'.length);
const ps4 = {
  fileName: `PackageFlowService-${ps4Version}.pkg`,
  ...(await take(ps4Build.directory, ps4File, `PackageFlowService-${ps4Version}.pkg`)),
  name: 'PackageFlow',
  titleId: 'PFLS00001',
  version: ps4Version,
};

const manifest = JSON.stringify({ schemaVersion: 1, elf, app, ps4 }, null, 2) + '\n';
await writeFile(join(target, 'manifest.json.tmp'), manifest);
await rename(join(target, 'manifest.json.tmp'), join(target, 'manifest.json'));
await rm(work, { recursive: true, force: true });
console.log(manifest);
