import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SetupElf } from './console-setup-artifacts';
import { dataPath } from './data-path';
import { writeDurableJson } from './durable-json';
import { PS5_SERVICE_ELF_FILE_NAME, validatePs5ServiceManifest } from './ps5-service-artifact';

/* Service updates are published as GitHub release assets next to the
 * Windows/Linux builds: PackageFlowService-PS5.elf and its manifest
 * PackageFlowService-PS5.json ({ schemaVersion: 1, elf: { … } }, the same
 * schema as .data/ps5-service-artifacts/manifest.json). */
export const PS5_SERVICE_MANIFEST_ASSET = 'PackageFlowService-PS5.json';
const repository = () =>
  /^[\w.-]+\/[\w.-]+$/.test(process.env.PACKAGEFLOW_RELEASE_REPOSITORY || '')
    ? process.env.PACKAGEFLOW_RELEASE_REPOSITORY!
    : 'demagoc3-cpu/playstation_installer';
const MAX_ELF = 4 * 1024 ** 2;

export interface Ps5ServiceGithubRelease {
  tag: string;
  publishedAt: string;
  url: string;
  manifest: SetupElf;
  elfUrl: string;
}
let cache: { at: number; value: Ps5ServiceGithubRelease | null } | undefined;

async function download(url: string, maximum: number) {
  const response = await fetch(url, {
    headers: { Accept: 'application/octet-stream', 'User-Agent': 'PackageFlow' },
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok || !response.body) throw new Error(`GitHub вернул ${response.status}`);
  const reader = response.body.getReader(),
    parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > maximum) {
      await reader.cancel();
      throw new Error('Файл релиза больше допустимого');
    }
    parts.push(part.value);
  }
  return Buffer.concat(parts);
}

/** Newest release that carries the PS5 service; cached for 10 minutes. */
export async function latestPs5ServiceRelease(force = false) {
  if (!force && cache && Date.now() - cache.at < 10 * 60 * 1000) return cache.value;
  const response = await fetch(
    `https://api.github.com/repos/${repository()}/releases?per_page=15`,
    {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PackageFlow' },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) throw new Error(`GitHub не ответил (${response.status})`);
  const releases = (await response.json()) as any[];
  let value: Ps5ServiceGithubRelease | null = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (release?.draft || !Array.isArray(release?.assets)) continue;
    const asset = (name: string) =>
      release.assets.find(
        (item: any) => item?.name === name && typeof item.browser_download_url === 'string',
      );
    const elf = asset(PS5_SERVICE_ELF_FILE_NAME),
      manifestAsset = asset(PS5_SERVICE_MANIFEST_ASSET);
    if (!elf || !manifestAsset) continue;
    const manifest = validatePs5ServiceManifest(
      JSON.parse((await download(manifestAsset.browser_download_url, 16 * 1024)).toString('utf8')),
    );
    if (elf.size !== manifest.size) continue;
    value = {
      tag: String(release.tag_name || ''),
      publishedAt: String(release.published_at || ''),
      url: String(release.html_url || ''),
      manifest,
      elfUrl: elf.browser_download_url,
    };
    break;
  }
  cache = { at: Date.now(), value };
  return value;
}

/** Download and verify the release ELF, then make it WEB's service artifact. */
export async function installPs5ServiceRelease(release: Ps5ServiceGithubRelease) {
  const bytes = await download(release.elfUrl, MAX_ELF);
  if (
    bytes.length !== release.manifest.size ||
    !bytes.subarray(0, 6).equals(Buffer.from('7f454c460201', 'hex')) ||
    bytes.readUInt16LE(18) !== 62 ||
    createHash('sha256').update(bytes).digest('hex') !== release.manifest.sha256
  )
    throw new Error('ELF из релиза не совпал с его манифестом');
  const directory = dataPath('ps5-service-artifacts', release.manifest.sha256);
  await mkdir(directory, { recursive: true });
  const target = resolve(directory, PS5_SERVICE_ELF_FILE_NAME),
    temporary = `${target}.download`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, target);
  writeDurableJson(dataPath('ps5-service-artifacts', 'manifest.json'), {
    schemaVersion: 1,
    elf: release.manifest,
  });
  return { manifest: release.manifest, bytes };
}
