import { readFile, mkdir, writeFile, copyFile, readdir, cp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
const repo = resolve(import.meta.dirname, '..'),
  payload = resolve(process.argv[2] || 'dist/windows/payload');
// Build staging is owned output. Remove obsolete payloads even for incremental builds.
await rm(join(payload, 'runtime/MicrosoftEdgeWebView2RuntimeInstallerX64.exe'), { force: true });
await rm(join(payload, 'runtime/install-webview2.ps1'), { force: true });
await rm(join(payload, 'runtime/MicrosoftEdgeWebview2Setup.exe'), { force: true });
await rm(join(payload, 'compose'), { recursive: true, force: true });
const pin = JSON.parse(
  await readFile(join(repo, 'packaging/windows/webview2-runtime.json'), 'utf8'),
);
const url = new URL(pin.url);
if (
  pin.schemaVersion !== 2 ||
  url.protocol !== 'https:' ||
  url.hostname !== 'msedge.sf.dl.delivery.mp.microsoft.com' ||
  url.username ||
  url.password ||
  url.port ||
  pin.fileName !== 'MicrosoftEdgeWebview2Setup.exe' ||
  !Number.isSafeInteger(pin.size) ||
  pin.size < 1024 ||
  pin.size > 4 * 1024 * 1024 ||
  !/^[a-f0-9]{64}$/.test(pin.sha256) ||
  pin.minimumVersion !== '120.0.0.0'
)
  throw Error('Invalid pinned Microsoft bootstrapper metadata');
await mkdir(join(payload, 'runtime'), { recursive: true });
await copyFile(
  join(repo, 'packaging/windows/webview2-runtime.json'),
  join(payload, 'runtime/webview2-runtime.json'),
);
await copyFile(
  join(repo, 'packaging/windows/verify-webview2-signature.ps1'),
  join(payload, 'runtime/verify-webview2-signature.ps1'),
);
const root = join(repo, 'apps/windows-launcher/PackageFlow.Windows/Desktop');
await rm(join(payload, 'Desktop'), { recursive: true, force: true });
await cp(root, join(payload, 'Desktop'), { recursive: true });
const manifest = { schemaVersion: 1, files: [] };
async function walk(dir) {
  for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const p = join(dir, item.name);
    if (item.isDirectory()) await walk(p);
    else {
      const data = await readFile(p);
      manifest.files.push({
        path: p.slice(root.length + 1),
        size: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      });
    }
  }
}
await walk(root);
for (const entry of manifest.files) {
  const staged = await readFile(join(payload, 'Desktop', entry.path));
  if (
    staged.length !== entry.size ||
    createHash('sha256').update(staged).digest('hex') !== entry.sha256
  )
    throw Error('Desktop staging mismatch: ' + entry.path);
}
await writeFile(join(payload, 'desktop-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(
  'Local Desktop verified; on-demand bootstrapper metadata staged. No Runtime installer is bundled.',
);
