#!/usr/bin/env bash
# Build the Windows distribution on Linux; no system settings are changed.
set -euo pipefail

export PF_REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
export PF_VERSION="${PF_VERSION:-0.1.7}"
export PF_PAYLOAD="$PF_REPO/dist/windows/payload"
PF_NODE_VERSION="${PF_NODE_VERSION:-22.23.3}"
PF_DOCKER_IMAGE="${PF_DOCKER_IMAGE:-demagoc3/packageflow:latest}"
export PF_DOCKER_IMAGE
skip_install=0
skip_web=0
skip_installer=0
check_only=0

fail() { printf 'Ошибка: %s\n' "$*" >&2; exit 1; }
while (($#)); do
  case "$1" in
    --version) (($# >= 2)) || fail 'Укажите версию после --version'; PF_VERSION="$2"; shift 2 ;;
    --skip-install) skip_install=1; shift ;;
    --skip-web-build) skip_web=1; shift ;;
    --skip-installer) skip_installer=1; shift ;;
    --check) check_only=1; shift ;;
    --help|-h)
      printf '%s\n' 'bash packaging/windows/build.sh [--version 0.1.7] [--check] [--skip-install] [--skip-web-build] [--skip-installer]' 'Overrides: PF_NPM_CLI, PF_DOTNET, PF_MAKENSIS, NSISDIR, PF_NODE_VERSION, PF_DOCKER_IMAGE'
      exit 0 ;;
    *) fail "Неизвестный параметр: $1" ;;
  esac
done
[[ "$PF_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Версия должна состоять из трёх чисел, например 0.1.7'
[[ "$PF_NODE_VERSION" =~ ^22\.[0-9]+\.[0-9]+$ ]] || fail 'PF_NODE_VERSION должен задавать версию Node.js 22'
cd -- "$PF_REPO"

for tool in node python3 curl unzip awk sha256sum; do
  command -v "$tool" >/dev/null || fail "Не найдена команда $tool. Установите инструмент или добавьте его в PATH."
done
node -e 'if (Number(process.versions.node.split(".")[0]) !== 22) process.exit(1)' || fail 'Для этой сборки требуется Node.js 22'

# IDE terminals may expose node but omit npm from PATH. Reuse an installed npm CLI.
if [[ -n "${PF_NPM_CLI:-}" ]]; then
  [[ -f "$PF_NPM_CLI" ]] || fail 'PF_NPM_CLI должен указывать на npm-cli.js'
  npm_command=(node "$PF_NPM_CLI")
elif command -v npm >/dev/null; then
  npm_command=("$(command -v npm)")
else
  shopt -s nullglob
  npm_candidates=(
    "$HOME"/.local/share/pnpm/store/v*/links/@/npm/*/*/node_modules/npm/bin/npm-cli.js
    "$HOME"/.nvm/versions/node/*/lib/node_modules/npm/bin/npm-cli.js
    "$HOME"/.local/share/fnm/node-versions/*/installation/lib/node_modules/npm/bin/npm-cli.js
  )
  shopt -u nullglob
  ((${#npm_candidates[@]})) || fail 'Не найден npm. Установите Node.js с npm либо задайте PF_NPM_CLI=/путь/npm-cli.js'
  npm_command=(node "${npm_candidates[0]}")
fi

if [[ -z "${PF_DOTNET:-}" ]]; then
  if command -v dotnet >/dev/null; then
    PF_DOTNET="$(command -v dotnet)"
  else
    for candidate in "$PF_REPO/.toolchains/dotnet/dotnet" "$HOME/.dotnet/dotnet" /tmp/packageflow-dotnet/dotnet; do
      if [[ -x "$candidate" ]]; then PF_DOTNET="$candidate"; break; fi
    done
  fi
fi
[[ -n "${PF_DOTNET:-}" && -x "$PF_DOTNET" ]] || fail 'Не найден .NET SDK 8. Установите SDK либо задайте PF_DOTNET=/путь/dotnet'
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_CLI_HOME="${DOTNET_CLI_HOME:-$PF_REPO/.toolchains/dotnet-home}"
if [[ -z "${NUGET_PACKAGES:-}" && -d /tmp/packageflow-nuget ]]; then export NUGET_PACKAGES=/tmp/packageflow-nuget; fi

if (( !skip_installer )); then
  if [[ -z "${PF_MAKENSIS:-}" ]]; then
    if command -v makensis >/dev/null; then
      PF_MAKENSIS="$(command -v makensis)"
    else
      for candidate in "$PF_REPO/.toolchains/nsis/usr/bin/makensis" /tmp/packageflow-nsis/root/usr/bin/makensis; do
        if [[ -x "$candidate" ]]; then
          PF_MAKENSIS="$candidate"
          export NSISDIR="${NSISDIR:-$(dirname -- "$(dirname -- "$candidate")")/share/nsis}"
          break
        fi
      done
    fi
  fi
  [[ -n "${PF_MAKENSIS:-}" && -x "$PF_MAKENSIS" ]] || fail 'Не найден NSIS 3. Установите NSIS либо задайте PF_MAKENSIS и при необходимости NSISDIR'
fi

printf 'Проект: %s\nВерсия установщика: %s\n' "$PF_REPO" "$PF_VERSION"
printf 'Node.js: '; node --version
printf 'npm: '; "${npm_command[@]}" --version
printf '.NET: '; "$PF_DOTNET" --version
"$PF_DOTNET" --list-sdks | awk '$1 ~ /^8\./ {found=1} END {exit !found}' || fail 'Для сборки требуется установленный .NET SDK 8'
if (( !skip_installer )); then printf 'NSIS: '; "$PF_MAKENSIS" -VERSION; fi
if (( check_only )); then printf '\nИнструменты доступны. Можно запускать сборку.\n'; exit 0; fi

if (( !skip_web )); then
  if (( !skip_install )); then "${npm_command[@]}" ci --ignore-scripts --no-audit --no-fund; fi
  "${npm_command[@]}" run build
else
  [[ -f .output/server/index.mjs ]] || fail 'Нет готового WEB в .output. Запустите сборку без --skip-web-build'
fi
"$PF_DOTNET" run --project apps/windows-launcher/PackageFlow.Core.Tests -c Release
"$PF_DOTNET" publish apps/windows-launcher/PackageFlow.Windows \
  -c Release -r win-x64 --self-contained true \
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true \
  -p:EnableCompressionInSingleFile=true -p:Version="$PF_VERSION" -o "$PF_PAYLOAD"

PF_NODE_ARCHIVE="node-v$PF_NODE_VERSION-win-x64.zip"
PF_NODE_STAGE="$PF_REPO/dist/windows/node-runtime-$PF_NODE_VERSION"
mkdir -p "$PF_NODE_STAGE" "$PF_PAYLOAD/runtime"
curl --fail --location "https://nodejs.org/dist/v$PF_NODE_VERSION/SHASUMS256.txt" -o "$PF_NODE_STAGE/SHASUMS256.txt"
if [[ ! -f "$PF_NODE_STAGE/$PF_NODE_ARCHIVE" ]]; then
  curl --fail --location "https://nodejs.org/dist/v$PF_NODE_VERSION/$PF_NODE_ARCHIVE" -o "$PF_NODE_STAGE/$PF_NODE_ARCHIVE"
fi
awk -v name="$PF_NODE_ARCHIVE" '$2 == name {print}' "$PF_NODE_STAGE/SHASUMS256.txt" > "$PF_NODE_STAGE/node.sha256"
[[ -s "$PF_NODE_STAGE/node.sha256" ]] || fail 'В официальном списке нет контрольной суммы Windows Node.js'
(cd -- "$PF_NODE_STAGE"; sha256sum --check node.sha256)
unzip -o "$PF_NODE_STAGE/$PF_NODE_ARCHIVE" "node-v$PF_NODE_VERSION-win-x64/node.exe" "node-v$PF_NODE_VERSION-win-x64/LICENSE" -d "$PF_NODE_STAGE"
cp "$PF_NODE_STAGE/node-v$PF_NODE_VERSION-win-x64/node.exe" "$PF_PAYLOAD/runtime/"
cp "$PF_NODE_STAGE/node-v$PF_NODE_VERSION-win-x64/LICENSE" "$PF_PAYLOAD/runtime/"

python3 - <<'PYTHON'
import json
import os
from pathlib import Path
import shutil
repo = Path(os.environ['PF_REPO'])
payload = Path(os.environ['PF_PAYLOAD'])
output = repo / '.output'
if list(output.rglob('*.node')):
    raise SystemExit('Native Node modules require separate platform builds.')
server = payload / 'server' / '.output'
if server.exists():
    shutil.rmtree(server)
shutil.copytree(output, server)
(payload / 'compose').mkdir(exist_ok=True)
for name in ['Dockerfile', 'Dockerfile.dockerignore']:
    shutil.copy2(repo / 'packaging' / 'compose' / name, payload / 'compose' / name)
shutil.copy2(repo / 'packaging/windows/configure-firewall.ps1', payload)
shutil.copy2(repo / 'LICENSE', payload)
(payload / 'release.json').write_text(json.dumps({
    'version': os.environ['PF_VERSION'], 'dockerImage': os.environ['PF_DOCKER_IMAGE']
}), encoding='utf-8')
PYTHON

if (( !skip_installer )); then
  "$PF_MAKENSIS" -V2 -DVERSION="$PF_VERSION" -DPAYLOAD="$PF_PAYLOAD" \
    -DOUTPUT="$PF_REPO/dist/windows/PackageFlowSetup-$PF_VERSION-x64.exe" packaging/windows/installer.nsi
  (cd -- "$PF_REPO/dist/windows"; sha256sum "PackageFlowSetup-$PF_VERSION-x64.exe" > SHA256SUMS.txt)
  printf '\nГотовый установщик: %s/dist/windows/PackageFlowSetup-%s-x64.exe\n' "$PF_REPO" "$PF_VERSION"
else
  printf '\nКомплект приложения: %s\n' "$PF_PAYLOAD"
fi
