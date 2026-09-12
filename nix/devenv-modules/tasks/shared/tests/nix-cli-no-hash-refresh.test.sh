#!/usr/bin/env bash
set -euo pipefail

module_dir="$(cd "$(dirname "$0")/.." && pwd)"
module="$module_dir/nix-cli.nix"

if grep -q 'nix:hash' "$module"; then
  echo "legacy nix:hash task surface is still present"
  exit 1
fi

if grep -qi 'ever''green' "$module"; then
  echo "private refresh task surface leaked into public nix-cli module"
  exit 1
fi

if grep -q '^lib\.mkIf hasPackages {' "$module"; then
  echo "empty cliPackages still disables repository-wide Nix validation"
  exit 1
fi

grep -q 'lib.optionals hasPackages' "$module"
grep -q '"nix:check:quick"' "$module"
grep -q '"nix:flake:check"' "$module"
grep -q 'nix:build' "$module"
grep -q 'nix:check' "$module"
grep -q 'refresh Nix FOD hashes' "$module"

echo "nix-cli keeps universal validation while hash-refresh surfaces stay absent"
