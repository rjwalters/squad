#!/usr/bin/env bash
# check-surface-version-bump.sh - Fail a PR that changes squad's
# consumer-visible surface without either bumping VERSION or declaring an
# explicit no-surface-change marker (#56).
#
# Why this exists: unlike loom (which copies a whole defaults/ tree into every
# consumer), squad's install.sh copies a narrower surface into each target
# repo -- commands/squad/*.md and skills/squad/SKILL.md into
# .claude/commands/squad/ + .claude/skills/squad/ (install.sh copies these
# per-repo), plus the opt-in hooks/squad-reentry.sh (installed only with
# --reentry). codex/prompts/squad-*.md is copied globally into
# ~/.codex/prompts/, not per-repo, but is still consumer-visible surface with
# the same staleness risk. install.sh and uninstall.sh define what actually
# gets copied/removed, so a behavior change there is exactly as
# consumer-visible even though the scripts aren't copied themselves. src/ is
# included too: it compiles to the MCP server every installed .mcp.json
# invokes directly from this source checkout (install.sh does NOT copy
# dist/), so a src/ change reaches every consumer the moment this repo is
# pulled -- no per-repo copy step, but still a behavior change worth pinning
# to a version, and tests/version.test.mjs already requires src/mcp.ts's
# declared version to track VERSION.
#
# install-metadata.json (written by install.sh into each consumer) records
# the VERSION at install time; /repo:update-tools compares it against this
# repo's current VERSION to detect drift. If a PR changes the watched surface
# without bumping VERSION, that comparison silently lies -- every consumer
# reports "current" for a surface it does not actually have.
#
# This is deliberately NOT trying to force semantic-version inflation on
# every doc typo or test-only edit under the watched paths -- an explicit
# marker lets an author declare "this change does not alter installed
# behavior" without a version bump.
#
# Usage:
#   check-surface-version-bump.sh --base <ref> [--head <ref>]
#     --base <ref>   Git ref/sha to diff FROM (the PR's base commit, e.g. a
#                     fetched base sha, or origin/main for a local check).
#                     Required.
#     --head <ref>   Git ref/sha to diff TO. Defaults to HEAD.
#   check-surface-version-bump.sh --help
#
# No-surface-change marker: a PR whose body OR whose HEAD-reachable commit
# messages (between --base and --head) contain the literal string
#     <!-- loom:no-surface-change -->
# is exempt even when the watched surface changed and VERSION did not. Pass
# the PR body via the PR_BODY environment variable (GitHub Actions:
# `env: PR_BODY: ${{ github.event.pull_request.body }}`); the commit-message
# path needs no extra plumbing beyond --base/--head.
#
# Exit codes:
#   0 - nothing under the watched paths changed in the diff, OR VERSION was
#       also changed, OR the no-surface-change marker is present.
#   1 - watched surface changed, VERSION was not, and no marker is present.
#   2 - bad usage (missing/invalid --base or --head).

set -euo pipefail

MARKER='<!-- loom:no-surface-change -->'

# Consumer-visible surface: everything install.sh copies into a target repo
# (per-repo or global), plus install.sh/uninstall.sh themselves (they define
# what gets copied/removed), plus src/ (compiles to the MCP server every
# installed .mcp.json points at directly in this source checkout).
WATCHED_PATHS=(
  "commands/squad/"
  "skills/squad/SKILL.md"
  "codex/prompts/"
  "hooks/squad-reentry.sh"
  "install.sh"
  "uninstall.sh"
  "src/"
)

BASE=""
HEAD="HEAD"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      BASE="${2:-}"
      shift 2
      ;;
    --head)
      HEAD="${2:-}"
      shift 2
      ;;
    --help|-h)
      sed -n '2,55p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "check-surface-version-bump: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$BASE" ]]; then
  echo "check-surface-version-bump: --base <ref> is required." >&2
  exit 2
fi

if ! git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null; then
  echo "check-surface-version-bump: base ref '$BASE' not found (not fetched?)." >&2
  exit 2
fi

if ! git rev-parse --verify --quiet "${HEAD}^{commit}" >/dev/null; then
  echo "check-surface-version-bump: head ref '$HEAD' not found." >&2
  exit 2
fi

# Deliberately a direct two-ref diff, not a merge-base-narrowed one -- this
# script is invoked from a shallow single-commit-fetch CI checkout where the
# base and head shallow histories may not share enough depth to resolve a
# merge-base. A direct diff answers the question this check actually cares
# about ("does applying head's changes touch the watched surface without
# touching VERSION") without requiring ancestry.
CHANGED_FILES="$(git diff --name-only "$BASE" "$HEAD" -- "${WATCHED_PATHS[@]}" 2>/dev/null || true)"

if [[ -z "$CHANGED_FILES" ]]; then
  echo "check-surface-version-bump: OK — no watched-surface changes in this diff."
  exit 0
fi

VERSION_CHANGED="$(git diff --name-only "$BASE" "$HEAD" -- VERSION 2>/dev/null || true)"

if [[ -n "$VERSION_CHANGED" ]]; then
  echo "check-surface-version-bump: OK — watched surface changed and VERSION was bumped."
  exit 0
fi

# --- no-surface-change marker check -----------------------------------------

if [[ -n "${PR_BODY:-}" ]] && grep -qF "$MARKER" <<<"$PR_BODY"; then
  echo "check-surface-version-bump: OK — no-surface-change marker found in the PR body."
  exit 0
fi

if git log --format=%B "${BASE}..${HEAD}" 2>/dev/null | grep -qF "$MARKER"; then
  echo "check-surface-version-bump: OK — no-surface-change marker found in a commit message."
  exit 0
fi

echo "check-surface-version-bump: FAIL — consumer-visible surface changed without a VERSION bump:" >&2
echo "" >&2
echo "$CHANGED_FILES" | sed 's/^/  /' >&2
echo "" >&2
echo "commands/squad/, skills/squad/SKILL.md, codex/prompts/, and (when" >&2
echo "installed with --reentry) hooks/squad-reentry.sh are copied into every" >&2
echo "consumer repo by install.sh; install.sh/uninstall.sh define that copy" >&2
echo "behavior; src/ compiles to the MCP server every installed .mcp.json" >&2
echo "invokes directly. VERSION is the signal install-metadata.json and" >&2
echo "/repo:update-tools use to detect drift, so a change to this surface must" >&2
echo "bump it (at minimum the patch component), keeping VERSION and" >&2
echo "package.json's \"version\" field in sync:" >&2
echo "    /loom:bump   (or edit VERSION + package.json by hand)" >&2
echo "" >&2
echo "If this change genuinely does not alter installed behavior (e.g. a" >&2
echo "comment, a test-only edit, a typo fix), declare that explicitly instead" >&2
echo "of bumping VERSION -- add this exact marker to the PR body or to a commit" >&2
echo "message in this PR:" >&2
echo "    $MARKER" >&2
exit 1
