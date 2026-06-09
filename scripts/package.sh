#!/usr/bin/env bash
#
# Package the ZAF app bundle into a Zendesk-installable zip.
#
# There is NO transpile or build step. This zips the committed files under
# zaf-build/ exactly as they are: what you edit is what ships. The version is
# read from zaf-build/manifest.json so the zip name always matches the manifest.
#
# Output: dist/tsanet-connect-v<version>.zip
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="$ROOT/zaf-build"
DIST="$ROOT/dist"

if [ ! -f "$BUNDLE/manifest.json" ]; then
  echo "error: $BUNDLE/manifest.json not found" >&2
  exit 1
fi

VERSION="$(python3 -c "import json; print(json.load(open('$BUNDLE/manifest.json'))['version'])")"
ZIP="$DIST/tsanet-connect-v${VERSION}.zip"

mkdir -p "$DIST"
rm -f "$ZIP"

# Zendesk expects manifest.json at the zip root, alongside assets/ and
# translations/. README.md is repo documentation and is intentionally excluded.
( cd "$BUNDLE" && zip -r -X "$ZIP" manifest.json assets translations -x '*.DS_Store' >/dev/null )

echo "✓ Packaged $ZIP"
