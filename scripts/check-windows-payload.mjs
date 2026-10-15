import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(process.argv[2] || 'dist/windows/payload'),
  version = process.argv[3] || '1.10.15';
let files = 0,
  total = 0;
async function check(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, item.name);
    if (item.isSymbolicLink()) throw Error('Payload link: ' + p);
    if (
      item.name.toLowerCase() === 'compose' ||
      /^dockerfile(?:\.|$)/i.test(item.name) ||
      /^docker[-.]compose.*\.(?:ya?ml|json)$/i.test(item.name) ||
      /Docker.*Installer.*\.exe$/i.test(item.name) ||
      /^MicrosoftEdgeWebView2RuntimeInstaller.*\.exe$/i.test(item.name) ||
      item.name === 'MicrosoftEdgeWebview2Setup.exe'
    )
      throw Error('Forbidden Windows payload entry: ' + p);
    if (item.isDirectory()) await check(p);
    else {
      const info = await stat(p);
      files++;
      total += info.size;
      if (info.size > 150 * 1024 * 1024) throw Error('Oversized unreviewed payload file: ' + p);
    }
  }
}
await check(root);
const release = JSON.parse(
  (await readFile(join(root, 'release.json'), 'utf8')).replace(/^\uFEFF/, ''),
);
if (release.version !== version || Object.keys(release).some((k) => k !== 'version'))
  throw Error('Windows release metadata includes obsolete options or wrong version');
const bundle = JSON.parse(await readFile(join(root, 'console-setup/manifest.json'), 'utf8'));
const expected = {
  ps4: ['2.14', '83995a02c90e8dc6fb775243f911573dc3e2b0acd390e0f3d2d591c1dc554abf'],
  elf: ['1.10.20', '1.10.21', '1.10.22', '1.10.23'].includes(version)
    ? ['0.1.28-dev', '2e478b29ac7f62c21207155fcf6acdbb0a6531a29f05397f7ec9575a665559fe']
    : version === '1.10.19'
      ? ['0.1.28-dev', '991df1c3568d7f51855beba9ea7d3c9e163109e1719e8aead6a9b6cc550fc178']
      : ['1.10.16', '1.10.17', '1.10.18'].includes(version)
        ? ['0.1.27-dev', '920e5580b6ad765f8526196947eec7ae5c3f803c239884361d72b7ee6e4ee37a']
        : ['0.1.26-dev', '2441b7ebe3aa6b265cb186512b5dd94f62666d40e16a71685d930c5b232a7732'],
  app: ['1.10.18', '1.10.19', '1.10.20', '1.10.21', '1.10.22', '1.10.23'].includes(version)
    ? ['01.000.044', '7ecf378d3c49c30dfdbf6a692432cf2e276fd340ce98d6bf6b31c15e046b3612', '6c32b25']
    : ['01.000.044', '18f64a693842d9136d7703377cd368a1a067fe760d87626b8ba949945e6806e6', '5122c1f'],
};
for (const [role, [v, hash, buildId]] of Object.entries(expected)) {
  const entry = bundle[role];
  const data = await readFile(join(root, 'console-setup', entry.fileName));
  if (
    entry.version !== v ||
    entry.sha256 !== hash ||
    (buildId && entry.buildId !== buildId) ||
    data.length !== entry.size ||
    createHash('sha256').update(data).digest('hex') !== hash
  )
    throw Error('Console bundle changed: ' + role);
}
const desktop = JSON.parse(await readFile(join(root, 'desktop-manifest.json'), 'utf8'));
for (const f of desktop.files) {
  const data = await readFile(join(root, 'Desktop', f.path));
  if (data.length !== f.size || createHash('sha256').update(data).digest('hex') !== f.sha256)
    throw Error('Desktop manifest mismatch: ' + f.path);
}
console.log(
  `PASS: Windows ${version}, ${files} files / ${total} bytes; no offline Runtime, bootstrapper binary, Docker or Compose; PS4 2.14 / PS5 ${expected.elf[0]} / app044 ${expected.app[2]} exact hashes.`,
);
