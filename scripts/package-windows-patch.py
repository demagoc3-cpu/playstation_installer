#!/usr/bin/env python3
"""Create a pinned patch for an installed launcher; never builds or applies it."""
import argparse
import hashlib
import json
import re
import stat
import zipfile
from pathlib import Path

ELF_NAME = 'PackageFlowService-PS5.elf'
SHA = re.compile(r'[a-f0-9]{64}')
MAX_ELF = 4 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=True, sort_keys=True, indent=2) + '\n').encode()


def read_json(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key.casefold() in {k.casefold() for k in result}:
                raise ValueError('Duplicate JSON key')
            result[key] = value
        return result
    return json.loads(Path(path).read_text(encoding='utf-8-sig'), object_pairs_hook=unique)


def safe_path(value):
    if not isinstance(value, str) or len(value) > 220:
        raise ValueError('Invalid relative file path')
    parts = value.split('/')
    for part in parts:
        if (not part or part in ('.', '..') or part.endswith(('.', ' ')) or
                re.search(r'[<>:"\\|?*\x00-\x1f]', part) or
                re.fullmatch(r'(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', part, re.I)):
            raise ValueError('Unsafe Windows path: ' + value)
    return value


def file_record(path, data):
    return {'path': safe_path(path), 'size': len(data), 'sha256': digest(data)}


def validate_files(files):
    if not isinstance(files, list) or not files:
        raise ValueError('Missing file inventory')
    seen = set()
    for item in files:
        if not isinstance(item, dict) or set(item) != {'path', 'size', 'sha256'}:
            raise ValueError('Invalid file inventory')
        name = safe_path(item['path'])
        if name.casefold() in seen:
            raise ValueError('Case-insensitive duplicate path')
        seen.add(name.casefold())
        if (type(item['size']) is not int or item['size'] < 0 or
                not isinstance(item['sha256'], str) or not SHA.fullmatch(item['sha256'])):
            raise ValueError('Invalid file identity')
    if 'server/index.mjs' not in seen:
        raise ValueError('Missing WEB entry point')
    # A file must never also be an ancestor directory of another file.
    for name in seen:
        parts = name.split('/')
        if any('/'.join(parts[:n]) in seen for n in range(1, len(parts))):
            raise ValueError('Conflicting file and directory')
    return files


def tree_hash(files):
    return digest(''.join(f"{f['path']}\t{f['size']}\t{f['sha256']}\n"
                          for f in sorted(files, key=lambda f: f['path'])).encode())


def inventory(root, materialize=False):
    root = Path(root).resolve(strict=True)
    output = {}

    def walk(directory, ancestors):
        resolved = directory.resolve(strict=True)
        if not resolved.is_relative_to(root) or resolved in ancestors:
            raise ValueError('External or cyclic build directory')
        for item in sorted(directory.iterdir()):
            target = item.resolve(strict=True)
            if not target.is_relative_to(root) or (item.is_symlink() and not materialize):
                raise ValueError('External or unsupported build link')
            if item.is_dir():
                walk(item, ancestors + (resolved,))
            elif item.is_file():
                if item.suffix == '.node':
                    raise ValueError('Native Node dependencies require a Windows build')
                name = safe_path(item.relative_to(root).as_posix())
                output[name] = item.read_bytes()
            else:
                raise ValueError('Unsupported build entry')
    walk(root, ())
    files = [file_record(name, data) for name, data in sorted(output.items())]
    validate_files(files)
    return files, output


def binary_identity(path):
    path = Path(path)
    if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode):
        raise ValueError('Expected a regular binary')
    data = path.read_bytes()
    return {'size': len(data), 'sha256': digest(data)}


def snapshot(web, launcher, node, version):
    if not re.fullmatch(r'\d+\.\d+\.\d+\.\d+', version):
        raise ValueError('Expected exact four-part launcher FileVersion')
    files, _ = inventory(web)
    return {'schemaVersion': 1, 'kind': 'PackageFlowInstalledWindowsBase',
            'launcher': {'version': version, **binary_identity(launcher)},
            'node': binary_identity(node), 'web': {'files': files, 'treeSha256': tree_hash(files)}}


def validate_base(base):
    if (not isinstance(base, dict) or base.get('schemaVersion') != 1 or
            base.get('kind') != 'PackageFlowInstalledWindowsBase'):
        raise ValueError('Invalid installed base')
    for role in ('launcher', 'node'):
        item = base[role]
        if (type(item['size']) is not int or item['size'] <= 0 or
                not SHA.fullmatch(item['sha256'])):
            raise ValueError('Invalid base binary identity')
    if not re.fullmatch(r'\d+\.\d+\.\d+\.\d+', base['launcher']['version']):
        raise ValueError('Invalid base launcher version')
    validate_files(base['web']['files'])
    if tree_hash(base['web']['files']) != base['web']['treeSha256']:
        raise ValueError('Invalid base WEB tree hash')
    return base


def validate_service_manifest(manifest):
    if set(manifest) != {'schemaVersion', 'elf'} or manifest['schemaVersion'] != 1:
        raise ValueError('Invalid service manifest')
    elf = manifest['elf']
    if (not isinstance(elf, dict) or
            set(elf) != {'fileName', 'size', 'sha256', 'version', 'buildId', 'firmware'} or
            elf['fileName'] != ELF_NAME or elf['firmware'] != '13.60' or
            type(elf['size']) is not int or not 4096 <= elf['size'] <= MAX_ELF or
            not isinstance(elf['sha256'], str) or not SHA.fullmatch(elf['sha256']) or
            not isinstance(elf['version'], str) or not re.fullmatch(r'\d+\.\d+\.\d+(?:-dev)?', elf['version']) or
            not isinstance(elf['buildId'], str) or not re.fullmatch(r'[a-z0-9-]{1,64}', elf['buildId'])):
        raise ValueError('Invalid service ELF identity')
    return elf


def validate_elf(data, elf):
    if (len(data) != elf['size'] or digest(data) != elf['sha256'] or
            data[:6] != bytes.fromhex('7f454c460201') or data[18:20] != b'\x3e\x00'):
        raise ValueError('Service ELF changed or is not ELF x64')


def service_artifact(root):
    root = Path(root)
    if root.is_symlink() or (root / 'manifest.json').is_symlink():
        raise ValueError('Linked service artifact')
    manifest = read_json(root / 'manifest.json')
    elf = validate_service_manifest(manifest)
    directory = root / elf['sha256']
    path = directory / ELF_NAME
    if directory.is_symlink() or path.is_symlink():
        raise ValueError('Linked service ELF')
    data = path.read_bytes()
    validate_elf(data, elf)
    return manifest, data


def stage_service(source, manifest, output):
    """Materialize an explicitly approved manifest; do not invent a candidate pin."""
    elf = validate_service_manifest(manifest)
    source, output = Path(source), Path(output)
    if source.is_symlink() or not source.is_file():
        raise ValueError('Expected a regular approved ELF')
    data = source.read_bytes()
    validate_elf(data, elf)
    if output.exists():
        raise ValueError('Independent service output must not already exist')
    (output / elf['sha256']).mkdir(parents=True)
    (output / elf['sha256'] / ELF_NAME).write_bytes(data)
    (output / 'manifest.json').write_bytes(json_bytes(manifest))
    return {'serviceArtifacts': str(output.resolve()), 'sha256': elf['sha256'],
            'size': elf['size'], 'applied': False}


def package(web, base, service, source_commit, archive):
    validate_base(base)
    if not re.fullmatch(r'[a-f0-9]{40}', source_commit):
        raise ValueError('Expected full source commit')
    files, output = inventory(web, materialize=True)
    manifest, elf = service_artifact(service)
    tree = tree_hash(files)
    patch_id = f"{source_commit[:12]}-{manifest['elf']['sha256'][:12]}-{tree[:12]}"
    payload = {'web/' + name: data for name, data in output.items()}
    payload['ps5-service-artifacts/manifest.json'] = json_bytes(manifest)
    payload[f"ps5-service-artifacts/{manifest['elf']['sha256']}/{ELF_NAME}"] = elf
    updater = Path(__file__).with_name('update-installed-windows-web.ps1')
    payload[updater.name] = updater.read_bytes()
    descriptor = {'schemaVersion': 1, 'kind': 'PackageFlowInstalledWindowsWebPatch',
                  'patchId': patch_id, 'sourceCommit': source_commit, 'base': base,
                  'web': {'files': files, 'treeSha256': tree}, 'service': manifest,
                  'files': [file_record(name, data) for name, data in sorted(payload.items())]}
    archive = Path(archive)
    if archive.exists():
        raise ValueError('Refusing to replace an existing patch archive')
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED) as target:
        for name, data in sorted(payload.items()):
            target.writestr(name, data)
        target.writestr('patch-manifest.json', json_bytes(descriptor))
    return {'patchId': patch_id, 'sourceCommit': source_commit,
            'archive': str(archive.resolve()), 'sha256': digest(archive.read_bytes()),
            'webFiles': len(files), 'elfSha256': manifest['elf']['sha256'],
            'launcherReplaced': False, 'applied': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    capture = commands.add_parser('snapshot', help='Inventory a local copy of an installed base')
    capture.add_argument('--web', type=Path, required=True)
    capture.add_argument('--launcher', type=Path, required=True)
    capture.add_argument('--node', type=Path, required=True)
    capture.add_argument('--launcher-version', required=True)
    capture.add_argument('--output', type=Path, required=True)
    service = commands.add_parser('stage-service', help='Stage a binary against an approved manifest')
    service.add_argument('--elf', type=Path, required=True)
    service.add_argument('--manifest', type=Path, required=True)
    service.add_argument('--output', type=Path, required=True)
    build = commands.add_parser('package', help='Package existing verified outputs; do not build')
    build.add_argument('--web', type=Path, required=True)
    build.add_argument('--base-manifest', type=Path, required=True)
    build.add_argument('--service-artifacts', type=Path, required=True)
    build.add_argument('--source-commit', required=True)
    build.add_argument('--archive', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'snapshot':
        value = snapshot(args.web, args.launcher, args.node, args.launcher_version)
        with args.output.open('xb') as output:
            output.write(json_bytes(value))
        print(json.dumps({'baseManifest': str(args.output), 'webTreeSha256': value['web']['treeSha256']}))
    elif args.command == 'stage-service':
        print(json.dumps(stage_service(args.elf, read_json(args.manifest), args.output)))
    else:
        print(json.dumps(package(args.web, read_json(args.base_manifest), args.service_artifacts,
                                 args.source_commit, args.archive)))


if __name__ == '__main__':
    main()
