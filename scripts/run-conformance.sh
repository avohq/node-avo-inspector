#!/usr/bin/env bash
#
# Build the Node SDK and run the official Avo Inspector conformance suite against its
# harness (conformance/avo-inspector-conformance.js). The language-agnostic suite runner
# and mock server live in the spec repository (avohq/spec-first-inspector-server-sdk).
#
# Usage:
#   ./scripts/run-conformance.sh
#
# Environment overrides:
#   SPEC_DIR        use this local spec checkout as-is (no fetch)
#   SPEC_REPO_URL   git URL of the spec repo (default: the public avohq repo)
#   SPEC_REF        full commit sha to check out into .spec-repo (default: spec 3.0.1)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPEC_REPO_URL="${SPEC_REPO_URL:-https://github.com/avohq/spec-first-inspector-server-sdk.git}"
SPEC_REF="${SPEC_REF:-7b79318f8cf1fa6de0142c698e37bb5d18e2d678}"

echo "==> Building SDK"
yarn --cwd "$ROOT" build

if [ -n "${SPEC_DIR:-}" ]; then
  echo "==> Using local spec at $SPEC_DIR"
else
  SPEC_DIR="$ROOT/.spec-repo"
  echo "==> Fetching spec repo @ $SPEC_REF"
  # Fail-closed and deterministic: any fetch/checkout failure aborts the run rather than
  # falling back to a stale checkout.
  if [ ! -d "$SPEC_DIR/.git" ]; then
    git init --quiet "$SPEC_DIR"
    git -C "$SPEC_DIR" remote add origin "$SPEC_REPO_URL"
  else
    # An existing checkout may have been created from another SPEC_REPO_URL.
    git -C "$SPEC_DIR" remote set-url origin "$SPEC_REPO_URL"
  fi
  git -C "$SPEC_DIR" fetch --quiet --depth 1 origin "$SPEC_REF"
  git -C "$SPEC_DIR" -c advice.detachedHead=false checkout --quiet --force FETCH_HEAD
  echo "    spec @ $(git -C "$SPEC_DIR" rev-parse --short HEAD)"
fi

HARNESS="$ROOT/conformance/avo-inspector-conformance.js"
# The suite runner splits --harness on whitespace and does not honor quotes, so a checkout
# path containing spaces is reached through a symlink in a space-free temp directory.
# Node resolves the link to the real file, so the harness still finds ../dist.
case "$HARNESS" in
  *[[:space:]]*)
    LINK_DIR="$(mktemp -d /tmp/avo-harness.XXXXXX)"
    trap 'rm -rf "$LINK_DIR"' EXIT
    ln -s "$HARNESS" "$LINK_DIR/avo-inspector-conformance.js"
    HARNESS="$LINK_DIR/avo-inspector-conformance.js"
    ;;
esac

echo "==> Running conformance suite"
node "$SPEC_DIR/conformance/runner/suite-runner.mjs" --harness "node $HARNESS"
