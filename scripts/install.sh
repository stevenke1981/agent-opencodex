#!/usr/bin/env sh
set -eu
if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 11) ? 0 : 1)'; then
  echo "Node.js 20.11 or newer is required" >&2
  exit 2
fi
npm install -g "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
aocx version
