#!/usr/bin/env python3
"""Package an existing Nuxt build for the standalone Windows LAN test server.

Materialize Nitro's internal dependency symlinks: Windows ZIP extraction cannot
use Unix directory links. Does not package application data or service keys.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile


def build_files(directory, build_root, ancestors=()):
    resolved = directory.resolve(strict=True)
    if not resolved.is_relative_to(build_root) or resolved in ancestors:
        raise ValueError(f'External or cyclic build directory: {directory}')
    for item in sorted(directory.iterdir()):
        target = item.resolve(strict=True)
        if not target.is_relative_to(build_root):
            raise ValueError(f'External build file: {item}')
        if item.is_dir():
            yield from build_files(item, build_root, ancestors + (resolved,))
        elif item.is_file():
            if item.suffix == '.node':
                raise ValueError('Native Node dependency requires a Windows build')
            yield item
        else:
            raise ValueError(f'Unsupported build entry: {item}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    output = repo / '.output'
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
    args.archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.archive, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for item in build_files(output, output.resolve()):
            archive.write(item, 'web/' + item.relative_to(output).as_posix())
        archive.write(repo / 'LICENSE', 'LICENSE')
        archive.writestr('release.json', json.dumps({
            'sourceCommit': revision, 'version': '1.10.7',
            'purpose': 'Shared PS4 and PS5 LAN WEB', 'dependenciesMaterialized': True,
        }))
    print(json.dumps({
        'sourceCommit': revision,
        'archive': str(args.archive),
        'sha256': hashlib.sha256(args.archive.read_bytes()).hexdigest(),
        'serverSha256': hashlib.sha256((output / 'server/index.mjs').read_bytes()).hexdigest(),
    }))


if __name__ == '__main__':
    main()
