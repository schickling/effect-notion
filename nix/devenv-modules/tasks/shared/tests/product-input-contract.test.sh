#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

nix eval --impure --expr "
  let
    netlifyArgs = builtins.functionArgs (import $ROOT/nix/devenv-modules/tasks/shared/netlify.nix);
    vercelArgs = builtins.functionArgs (import $ROOT/nix/devenv-modules/tasks/shared/vercel.nix);
    cliArgs = builtins.functionArgs (import $ROOT/nix/workspace-tools/lib/mk-cli-packages.nix);
  in
    assert netlifyArgs.ciToolsBin == false;
    assert vercelArgs.ciToolsBin == false;
    assert cliArgs.products == false;
    true
" >/dev/null

if grep -R -F 'packages/@overeng/ci-tools/nix/build.nix' \
  "$ROOT/nix/devenv-modules/tasks/shared/netlify.nix" \
  "$ROOT/nix/devenv-modules/tasks/shared/vercel.nix" \
  "$ROOT/nix/devenv-modules/tasks/shared/workflow-report-module.nix"; then
  echo "shared module retained a legacy ci-tools producer" >&2
  exit 1
fi
