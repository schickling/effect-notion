#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stager="$script_dir/../stage-pnpm-source-inputs.mjs"
tmpdir="$(mktemp -d)"
trap 'chmod -R u+w "$tmpdir" 2>/dev/null || true; rm -rf "$tmpdir"' EXIT

if command -v pnpm >/dev/null 2>&1; then
  pnpm_command=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  pnpm_command=(corepack pnpm)
else
  echo "FAIL: real pnpm executable is required" >&2
  exit 1
fi

workspace="$tmpdir/workspace"
source_path="repos/demo/packages/source-package"
stable_stage_path=".devenv/pnpm-source-inputs/current/$source_path"
mkdir -p "$workspace/$source_path"

write_source_package() {
  local value="$1"
  printf '{"name":"source-package","version":"1.0.0","main":"index.js"}\n' \
    > "$workspace/$source_path/package.json"
  printf 'module.exports = "%s"\n' "$value" > "$workspace/$source_path/index.js"
}

write_source_package one
printf '{"name":"fixture-root","private":true,"packageManager":"pnpm@12.3.4","dependencies":{"source-package":"file:%s"}}\n' \
  "$stable_stage_path" > "$workspace/package.json"

install_fixture() {
  # The temporary fixture install is the behavior under test, not a workspace mutation.
  DEVENV_TASK_PASSTHROUGH=1 "${pnpm_command[@]}" --dir "$workspace" install \
    --store-dir "$workspace/.devenv/pnpm-store" \
    --config.enable-global-virtual-store=false \
    --config.virtual-store-dir=node_modules/.pnpm \
    --ignore-scripts \
    --reporter=silent
}

node "$stager" publish "$workspace" .devenv/pnpm-source-inputs "$source_path"
first_generation="$(readlink "$workspace/.devenv/pnpm-source-inputs/current")"
install_fixture
grep -qxF 'module.exports = "one"' "$workspace/node_modules/source-package/index.js"

write_source_package two
node "$stager" publish "$workspace" .devenv/pnpm-source-inputs "$source_path"
second_generation="$(readlink "$workspace/.devenv/pnpm-source-inputs/current")"
test "$first_generation" != "$second_generation"
grep -qxF 'file:.devenv/pnpm-source-inputs/current/repos/demo/packages/source-package' \
  <(node -e 'process.stdout.write(require(process.argv[1]).dependencies["source-package"])' "$workspace/package.json")

install_fixture
grep -qxF 'module.exports = "two"' "$workspace/node_modules/source-package/index.js"

echo "pnpm source input refresh integration test passed"
