"""Developer check of the actual generated Compose and bundled WEB (no PS4 calls)."""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--dotnet', default='dotnet')
options = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix='pf-compose-smoke-'))
project = f'pf-installer-smoke-{os.getpid()}'


def free_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


port, callback = free_port(), free_port()
while callback == port:
    callback = free_port()
compose = ['docker', 'compose', '--file', str(root / 'compose.json'), '--project-name', project]


def run(arguments):
    subprocess.run(arguments, cwd=repo, check=True)


try:
    run([options.dotnet, 'run', '--project', 'apps/windows-launcher/PackageFlow.Core.Tests', '-c', 'Release', '--no-restore', '--', '--compose-fixture', str(root), str(repo / 'dist/windows/payload'), str(port), str(callback)])
    config = json.loads((root / 'compose.json').read_text())
    for item in config['services']['packageflow']['ports']:
        item['host_ip'] = '127.0.0.1'
    (root / 'compose.json').write_text(json.dumps(config))
    run(compose + ['config', '--quiet'])
    run(compose + ['build', 'packageflow'])
    run(compose + ['up', '-d', '--no-build', '--pull', 'missing'])
    response = None
    for _ in range(60):
        try:
            request = urllib.request.Request(f'http://127.0.0.1:{port}/api/desktop/status', headers={'X-PackageFlow-Launcher-Key': 'fixture-launcher-key'})
            with urllib.request.urlopen(request, timeout=2) as result:
                response = json.load(result)
            break
        except Exception:
            time.sleep(1)
    assert response and response['application'] == 'PackageFlow' and not response['busy']
    request = urllib.request.Request(f'http://127.0.0.1:{port}/api/search/settings', data=json.dumps({'endpoint': 'http://prowlarr:9696/2/api', 'apiKey': 'fixture-prowlarr-key', 'categories': '1180'}).encode(), headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(request, timeout=5) as result:
        assert result.status == 200
    assert json.loads((root / 'web/search-providers.json').read_text())['apiKey'] == 'fixture-prowlarr-key'
    print('Compose smoke passed: generated config, bundled WEB image, control API and persistent volume.')
finally:
    subprocess.run(compose + ['down', '--remove-orphans'], cwd=repo, check=False)
    shutil.rmtree(root)
