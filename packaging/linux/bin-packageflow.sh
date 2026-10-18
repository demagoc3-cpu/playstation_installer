#!/bin/sh
# Installed as <root>/bin/packageflow (deb: /usr/lib/packageflow, linked from /usr/bin/packageflow).
ROOT="$(dirname "$(dirname "$(readlink -f "$0")")")"
export PACKAGEFLOW_ROOT="$ROOT"
exec "${PACKAGEFLOW_PYTHON:-python3}" -I "$ROOT/app/main.py" "$@"
