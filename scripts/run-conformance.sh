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
  fi
  git -C "$SPEC_DIR" fetch --quiet --depth 1 origin "$SPEC_REF"
  git -C "$SPEC_DIR" -c advice.detachedHead=false checkout --quiet --force FETCH_HEAD
  echo "    spec @ $(git -C "$SPEC_DIR" rev-parse --short HEAD)"
fi

echo "==> Running conformance suite"
node "$SPEC_DIR/conformance/runner/suite-runner.mjs" --harness "node $ROOT/conformance/avo-inspector-conformance.js"
