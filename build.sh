#!/usr/bin/env bash
# Builds dist/leitura-seria-<version>.xpi (a zip with the files at its root).
set -euo pipefail
cd "$(dirname "$0")"
version=$(node -p "require('./manifest.json').version")
mkdir -p dist
out="dist/leitura-seria-${version}.xpi"
rm -f "$out"
zip -r -X "$out" manifest.json bootstrap.js prefs.js prefs.xhtml lib
echo "Built $out"
