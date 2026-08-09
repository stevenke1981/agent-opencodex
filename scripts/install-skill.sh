#!/usr/bin/env sh
set -eu
src="$(CDPATH= cd -- "$(dirname -- "$0")/../skills/agent-opencodex" && pwd)"
dst="${1:-$HOME/.codex/skills/agent-opencodex}"
mkdir -p "$(dirname "$dst")"
rm -rf "$dst"
cp -R "$src" "$dst"
echo "Installed skill at $dst"
