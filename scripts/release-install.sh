#!/usr/bin/env bash
# Install a built release of this checkout to a fixed location agents run from,
# so cleanups, edits and branch checkouts of the dev clone cannot break squad's
# MCP (#168). Layout under ${SQUAD_HOME:-~/.local/share/squad}:
#   <version>/   the packed release with production dependencies
#   current      symlink to the active <version>, swapped atomically
# and ${SQUAD_BIN_DIR:-~/.local/bin}/squad -> current/dist/index.js.
# Install into repos from the stable path: <SQUAD_HOME>/current/install.sh <repo>
set -euo pipefail
CLONE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${SQUAD_HOME:-$HOME/.local/share/squad}"
BIN_DIR="${SQUAD_BIN_DIR:-$HOME/.local/bin}"
VERSION="$(tr -d '[:space:]' <"$CLONE/VERSION")"
[ -n "$VERSION" ] || { echo "VERSION is empty" >&2; exit 1; }

work="$(mktemp -d)"
stage="$ROOT/.stage-$VERSION-$$"
cleanup() { rm -rf -- "$work" "$stage"; }
trap cleanup EXIT

cd "$CLONE"
[ -d node_modules ] || { echo "run CI=true pnpm install --frozen-lockfile in $CLONE first" >&2; exit 1; }
pnpm build
pnpm pack --pack-destination "$work" >/dev/null
tarball="$(ls "$work"/*.tgz)"

mkdir -p "$ROOT" "$BIN_DIR" "$stage"
tar -xzf "$tarball" -C "$stage" --strip-components=1
cp "$CLONE/pnpm-lock.yaml" "$stage/"
(cd "$stage" && CI=true pnpm install --prod --frozen-lockfile)

# Move the version dir into place, then repoint the symlinks via rename (atomic).
# A previous install of the same version is replaced; other versions are kept.
if [ -d "$ROOT/$VERSION" ]; then mv "$ROOT/$VERSION" "$ROOT/.old-$VERSION-$$"; fi
mv "$stage" "$ROOT/$VERSION"
rm -rf -- "$ROOT/.old-$VERSION-$$"
chmod +x "$ROOT/$VERSION/dist/index.js"
ln -sfn "$VERSION" "$ROOT/.current.$$"
mv -Tf "$ROOT/.current.$$" "$ROOT/current"
ln -sfn "$ROOT/current/dist/index.js" "$BIN_DIR/.squad.$$"
mv -Tf "$BIN_DIR/.squad.$$" "$BIN_DIR/squad"

echo "squad $VERSION installed at $ROOT/$VERSION (current -> $VERSION)"
echo "install into a repo with: $ROOT/current/install.sh <repo>"
