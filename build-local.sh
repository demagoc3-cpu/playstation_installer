#!/usr/bin/env bash
# Shortcut for local Windows installer builds; works from an IDE or any directory.
set -euo pipefail
exec bash "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/packaging/windows/build.sh" "$@"
