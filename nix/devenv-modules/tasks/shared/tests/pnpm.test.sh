#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
HELPERS_SCRIPT="$ROOT/nix/devenv-modules/tasks/shared/pnpm-task-helpers.sh"
PROJECTION_SCRIPT="$ROOT/nix/devenv-modules/tasks/shared/check-node-modules-projection-health.cjs"

# The unit-style shell tests should execute the same helper implementations as
# the generated task scripts so they catch real regressions instead of drift in
# duplicated test-only copies.
source "$HELPERS_SCRIPT"

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    exit 1
  fi
}

assert_exit_code() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label"
    echo "  expected exit code: $expected"
    echo "  actual exit code:   $actual"
    exit 1
  fi
}

assert_json_field() {
  local expected="$1"
  local file="$2"
  local expression="$3"
  local label="$4"

  local actual
  actual="$(node -e "const fs = require('node:fs'); const value = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const out = (${expression})(value); process.stdout.write(String(out))" "$file")"
  assert_eq "$expected" "$actual" "$label"
}

# `flock` is not part of the declared shell-test tool PATH, and the Store Cache
# lease helper takes the binary as an explicit argument exactly like pnpm.nix
# passes `${pkgs.flock}/bin/flock`. Resolve the same pinned product here instead
# of assuming an ambient one.
resolve_flock_bin() {
  if command -v flock >/dev/null 2>&1; then
    command -v flock
    return 0
  fi

  local flake_ref="${NIX_FLAKE_REF:-path:$ROOT}"
  printf '%s/bin/flock\n' "$(nix build --no-link --print-out-paths --impure --expr "
    (import (builtins.getFlake \"$flake_ref\").inputs.nixpkgs {
      system = builtins.currentSystem;
    }).flock
  ")"
}


make_projection_fixture() {
  local root="$1"
  local with_dep="$2"
  local dep_blocks_package_json_export="${3:-0}"
  local package_root="$root/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg"

  mkdir -p "$package_root"
  mkdir -p "$root/node_modules"
  cat > "$package_root/package.json" <<'EOF'
{"name":"pkg","dependencies":{"dep":"1.0.0"}}
EOF
  ln -s .pnpm/pkg@1.0.0/node_modules/pkg "$root/node_modules/pkg"

  if [ "$with_dep" = "1" ]; then
    mkdir -p "$package_root/node_modules/dep"
    if [ "$dep_blocks_package_json_export" = "1" ]; then
      cat > "$package_root/node_modules/dep/package.json" <<'EOF'
{"name":"dep","exports":{".":"./index.js"}}
EOF
      cat > "$package_root/node_modules/dep/index.js" <<'EOF'
module.exports = {}
EOF
    else
      cat > "$package_root/node_modules/dep/package.json" <<'EOF'
{"name":"dep"}
EOF
    fi
  fi
}

make_source_link_fixture() {
  local root="$1"

  mkdir -p "$root/source/pkg"
  mkdir -p "$root/node_modules"
  cat > "$root/source/pkg/package.json" <<'EOF'
{"name":"pkg","dependencies":{"dep":"1.0.0"}}
EOF
  ln -s ../source/pkg "$root/node_modules/pkg"
}

make_foreign_package_instance_fixture() {
  local root="$1"
  local sibling_root="$2"
  local package_root="$root/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg"
  local dependency_root="$sibling_root/node_modules/.pnpm/dep@2.0.0/node_modules/dep"

  mkdir -p "$package_root/node_modules" "$dependency_root" "$root/node_modules"
  cat > "$package_root/package.json" <<'EOF'
{"name":"pkg","peerDependencies":{"dep":"^2.0.0"}}
EOF
  cat > "$dependency_root/package.json" <<'EOF'
{"name":"dep","version":"2.0.0"}
EOF
  ln -s .pnpm/pkg@1.0.0/node_modules/pkg "$root/node_modules/pkg"
  ln -s "$dependency_root" "$package_root/node_modules/dep"
}

make_missing_export_fixture() {
  local root="$1"
  local package_root="$root/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg"

  mkdir -p "$package_root"
  mkdir -p "$root/node_modules"
  cat > "$package_root/package.json" <<'EOF'
{"name":"pkg","files":["src"],"exports":{".":{"default":"./src/index.js"}}}
EOF
  ln -s .pnpm/pkg@1.0.0/node_modules/pkg "$root/node_modules/pkg"
}

make_default_files_fixture() {
  local root="$1"
  local package_root="$root/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg"

  mkdir -p "$package_root/dist" "$root/node_modules"
  cat > "$package_root/package.json" <<'EOF'
{"name":"pkg","main":"./dist/index.js"}
EOF
  touch "$package_root/dist/index.js"
  ln -s .pnpm/pkg@1.0.0/node_modules/pkg "$root/node_modules/pkg"
}

make_exports_override_stale_main_fixture() {
  local root="$1"
  local package_root="$root/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg"

  mkdir -p "$package_root/dist" "$root/node_modules"
  cat > "$package_root/package.json" <<'EOF'
{"name":"pkg","files":["dist"],"main":"./dist/missing-legacy.cjs","exports":{".":{"import":"./dist/index.js","require":"./dist/index.cjs"}}}
EOF
  touch "$package_root/dist/index.js" "$package_root/dist/index.cjs"
  ln -s .pnpm/pkg@1.0.0/node_modules/pkg "$root/node_modules/pkg"
}

make_unshipped_conditional_export_fixture() {
  local root="$1"
  local package_root="$root/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg"

  mkdir -p "$package_root/dist"
  mkdir -p "$root/node_modules"
  cat > "$package_root/package.json" <<'EOF'
{"name":"pkg","files":["dist"],"exports":{".":{"custom-condition":"./src/index.ts","default":"./dist/index.js"}}}
EOF
  touch "$package_root/dist/index.js"
  ln -s .pnpm/pkg@1.0.0/node_modules/pkg "$root/node_modules/pkg"
}

make_missing_conditional_export_alternative_fixture() {
  local root="$1"
  local package_root="$root/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg"

  mkdir -p "$package_root/build"
  mkdir -p "$root/node_modules"
  cat > "$package_root/package.json" <<'EOF'
{"name":"pkg","files":["build"],"main":"./build/pkg.esm.js","exports":{".":{"import":"./build/pkg.esm.js","require":"./build/index.js","browser":"./build/pkg.min.js"}}}
EOF
  touch "$package_root/build/pkg.esm.js"
  touch "$package_root/build/pkg.min.js"
  ln -s .pnpm/pkg@1.0.0/node_modules/pkg "$root/node_modules/pkg"
}

make_missing_type_export_fixture() {
  local root="$1"
  local package_root="$root/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg"

  mkdir -p "$package_root/dist"
  mkdir -p "$root/node_modules"
  cat > "$package_root/package.json" <<'EOF'
{"name":"pkg","files":["dist"],"exports":{"./internal/module-runner":{"types":"./dist/module-runner.d.ts","default":"./dist/module-runner.js"}}}
EOF
  touch "$package_root/dist/module-runner.js"
  ln -s .pnpm/pkg@1.0.0/node_modules/pkg "$root/node_modules/pkg"
}

make_builtin_dependency_fixture() {
  local root="$1"

  mkdir -p "$root/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg"
  mkdir -p "$root/node_modules"
  cat > "$root/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/package.json" <<'EOF'
{"name":"pkg","dependencies":{"buffer":"^5.0.0","node:test":"^1.0.0"}}
EOF
  ln -s .pnpm/pkg@1.0.0/node_modules/pkg "$root/node_modules/pkg"
}

make_extensionless_main_fixture() {
  local root="$1"
  local package_root="$root/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg"

  mkdir -p "$package_root/lib"
  mkdir -p "$root/node_modules"
  cat > "$package_root/package.json" <<'EOF'
{"name":"pkg","files":["lib"],"main":"./lib/index","exports":{".":{"default":"./lib/index"}}}
EOF
  touch "$package_root/lib/index.js"
  ln -s .pnpm/pkg@1.0.0/node_modules/pkg "$root/node_modules/pkg"
}

make_missing_subpath_export_fixture() {
  local root="$1"
  local package_root="$root/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg"

  mkdir -p "$package_root/dist"
  mkdir -p "$root/node_modules"
  cat > "$package_root/package.json" <<'EOF'
{"name":"pkg","files":["dist"],"main":"./dist/index.js","exports":{".":{"default":"./dist/index.js"},"./optional":{"default":"./dist/optional.js"}}}
EOF
  touch "$package_root/dist/index.js"
  ln -s .pnpm/pkg@1.0.0/node_modules/pkg "$root/node_modules/pkg"
}

make_bin_fixture() {
  local root="$1"

  mkdir -p "$root/node_modules/fake-tool/bin" "$root/node_modules/.bin"
  cat > "$root/node_modules/fake-tool/package.json" <<'EOF'
{"name":"fake-tool","bin":{"fake-tool":"bin/fake-tool.js","alt-tool":"bin/fake-tool.js"}}
EOF
  cat > "$root/node_modules/fake-tool/bin/fake-tool.js" <<'EOF'
#!/usr/bin/env node
process.stdout.write(`fake-tool-direct:${process.argv.slice(2).join(',')}\n`)
EOF
  chmod +x "$root/node_modules/fake-tool/bin/fake-tool.js"
  cat > "$root/node_modules/.bin/fake-tool" <<'EOF'
#!/usr/bin/env bash
printf 'fake-tool-shim:%s\n' "$*"
EOF
  chmod +x "$root/node_modules/.bin/fake-tool"
}

make_bin_fixture_without_shim() {
  local root="$1"

  mkdir -p "$root/node_modules/fallback-tool/bin"
  cat > "$root/node_modules/fallback-tool/package.json" <<'EOF'
{"name":"fallback-tool","bin":{"fallback-tool":"bin/fallback-tool.js"}}
EOF
  cat > "$root/node_modules/fallback-tool/bin/fallback-tool.js" <<'EOF'
#!/usr/bin/env node
process.stdout.write(`fallback-tool-direct:${process.argv.slice(2).join(',')}\n`)
EOF
  chmod +x "$root/node_modules/fallback-tool/bin/fallback-tool.js"
}

echo "Running pnpm task helper tests..."
echo ""

test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

echo "Test 5: ensure_local_pnpm_home_default sets a workspace-local default"
(
  unset PNPM_HOME
  ensure_local_pnpm_home_default "$test_dir/workspace"
  assert_eq \
    "$test_dir/workspace/.pnpm-home" \
    "$PNPM_HOME" \
    "ensure_local_pnpm_home_default sets PNPM_HOME"
)

echo "Test 6: ensure_local_pnpm_home_default preserves an explicit PNPM_HOME"
(
  export PNPM_HOME="$test_dir/custom-home"
  ensure_local_pnpm_home_default "$test_dir/workspace"
  assert_eq \
    "$test_dir/custom-home" \
    "$PNPM_HOME" \
    "ensure_local_pnpm_home_default keeps explicit PNPM_HOME"
)

echo "Test 9: pnpm contract section hashing is stable across JSON key order"
contract_a="$test_dir/contract-a.json"
contract_b="$test_dir/contract-b.json"
cat > "$contract_a" <<'EOF'
{"schemaVersion":1,"dependencyGraphContract":{"packageExtensions":{"storybook":{"dependencies":{"@storybook/react-vite":"10.4.6"}}},"allowBuilds":{"esbuild":false}}}
EOF
cat > "$contract_b" <<'EOF'
{"dependencyGraphContract":{"allowBuilds":{"esbuild":false},"packageExtensions":{"storybook":{"dependencies":{"@storybook/react-vite":"10.4.6"}}}},"schemaVersion":1}
EOF
assert_eq \
  "$(compute_pnpm_contract_section_hash node "$contract_a" dependencyGraphContract)" \
  "$(compute_pnpm_contract_section_hash node "$contract_b" dependencyGraphContract)" \
  "contract section hash ignores JSON object key order"

echo "Test 10: policy-only contract changes classify as policy drift"
contract_policy_old="$test_dir/contract-policy-old.json"
contract_policy_new="$test_dir/contract-policy-new.json"
cat > "$contract_policy_old" <<'EOF'
{
  "schemaVersion": 1,
  "packageManager": {"name": "pnpm", "version": "11.8.0"},
  "dependencyGraphContract": {"allowBuilds": {"esbuild": false}, "packageExtensions": {}},
  "installPolicy": {"verifyStoreIntegrity": true},
  "storeContract": {"storeDir": ".devenv/pnpm-store-pure-v1"},
  "workspaceManifestContract": {"packages": ["packages/app"]},
  "nixIntegration": {"liveVirtualStoreScope": "materialization-root"},
  "buck2Integration": {"consumeContractArtifact": true}
}
EOF
cat > "$contract_policy_new" <<'EOF'
{
  "schemaVersion": 1,
  "packageManager": {"name": "pnpm", "version": "11.8.0"},
  "dependencyGraphContract": {"allowBuilds": {"esbuild": false}, "packageExtensions": {}},
  "installPolicy": {"verifyStoreIntegrity": false},
  "storeContract": {"storeDir": ".devenv/pnpm-store-pure-v1"},
  "workspaceManifestContract": {"packages": ["packages/app"]},
  "nixIntegration": {"liveVirtualStoreScope": "materialization-root"},
  "buck2Integration": {"consumeContractArtifact": true}
}
EOF
assert_eq \
  "policy" \
  "$(classify_pnpm_contract_change node "$contract_policy_old" "$contract_policy_new")" \
  "policy-only contract changes classify as policy"

echo "Test 11: packageExtensions changes classify as dependency-graph drift"
contract_graph_new="$test_dir/contract-graph-new.json"
cat > "$contract_graph_new" <<'EOF'
{
  "schemaVersion": 1,
  "packageManager": {"name": "pnpm", "version": "11.8.0"},
  "dependencyGraphContract": {"allowBuilds": {"esbuild": false}, "packageExtensions": {"storybook": {"dependencies": {"@storybook/react-vite": "10.4.6"}}}},
  "installPolicy": {"verifyStoreIntegrity": true},
  "storeContract": {"storeDir": ".devenv/pnpm-store-pure-v1"},
  "workspaceManifestContract": {"packages": ["packages/app"]},
  "nixIntegration": {"liveVirtualStoreScope": "materialization-root"},
  "buck2Integration": {"consumeContractArtifact": true}
}
EOF
assert_eq \
  "dependency_graph" \
  "$(classify_pnpm_contract_change node "$contract_policy_old" "$contract_graph_new")" \
  "packageExtensions changes are dependency-graph changes"

echo "Test 12: unchanged classified sections report an unknown miss reason"
contract_unknown_new="$test_dir/contract-unknown-new.json"
cat > "$contract_unknown_new" <<'EOF'
{
  "schemaVersion": 2,
  "packageManager": {"name": "pnpm", "version": "11.8.0"},
  "dependencyGraphContract": {"allowBuilds": {"esbuild": false}, "packageExtensions": {}},
  "installPolicy": {"verifyStoreIntegrity": true},
  "storeContract": {"storeDir": ".devenv/pnpm-store-pure-v1"},
  "workspaceManifestContract": {"packages": ["packages/app"]},
  "nixIntegration": {"liveVirtualStoreScope": "materialization-root", "changedMetadata": true},
  "buck2Integration": {"consumeContractArtifact": false}
}
EOF
assert_eq \
  "unknown" \
  "$(classify_pnpm_contract_change node "$contract_policy_old" "$contract_unknown_new")" \
  "unclassified contract changes return unknown"

echo "Test 13: package manager changes classify as toolchain drift"
contract_toolchain_new="$test_dir/contract-toolchain-new.json"
cat > "$contract_toolchain_new" <<'EOF'
{
  "schemaVersion": 1,
  "packageManager": {"name": "pnpm", "version": "11.9.0"},
  "dependencyGraphContract": {"allowBuilds": {"esbuild": false}, "packageExtensions": {}},
  "installPolicy": {"verifyStoreIntegrity": true},
  "storeContract": {"storeDir": ".devenv/pnpm-store-pure-v1"},
  "workspaceManifestContract": {"packages": ["packages/app"]},
  "nixIntegration": {"liveVirtualStoreScope": "materialization-root"},
  "buck2Integration": {"consumeContractArtifact": true}
}
EOF
assert_eq \
  "toolchain" \
  "$(classify_pnpm_contract_change node "$contract_policy_old" "$contract_toolchain_new")" \
  "package manager changes classify as toolchain"

echo "Test 14: store contract changes classify as store drift"
contract_store_new="$test_dir/contract-store-new.json"
cat > "$contract_store_new" <<'EOF'
{
  "schemaVersion": 1,
  "packageManager": {"name": "pnpm", "version": "11.8.0"},
  "dependencyGraphContract": {"allowBuilds": {"esbuild": false}, "packageExtensions": {}},
  "installPolicy": {"verifyStoreIntegrity": true},
  "storeContract": {"storeDir": ".devenv/pnpm-store-pure-v2"},
  "workspaceManifestContract": {"packages": ["packages/app"]},
  "nixIntegration": {"liveVirtualStoreScope": "materialization-root"},
  "buck2Integration": {"consumeContractArtifact": true}
}
EOF
assert_eq \
  "store" \
  "$(classify_pnpm_contract_change node "$contract_policy_old" "$contract_store_new")" \
  "store contract changes classify as store"

echo "Test 15: workspace manifest contract changes classify as manifest/config drift"
contract_manifest_new="$test_dir/contract-manifest-new.json"
cat > "$contract_manifest_new" <<'EOF'
{
  "schemaVersion": 1,
  "packageManager": {"name": "pnpm", "version": "11.8.0"},
  "dependencyGraphContract": {"allowBuilds": {"esbuild": false}, "packageExtensions": {}},
  "installPolicy": {"verifyStoreIntegrity": true},
  "storeContract": {"storeDir": ".devenv/pnpm-store-pure-v1"},
  "workspaceManifestContract": {"packages": ["packages/app", "packages/lib"]},
  "nixIntegration": {"liveVirtualStoreScope": "materialization-root"},
  "buck2Integration": {"consumeContractArtifact": true}
}
EOF
assert_eq \
  "manifest_config" \
  "$(classify_pnpm_contract_change node "$contract_policy_old" "$contract_manifest_new")" \
  "workspace manifest contract changes classify as manifest_config"

echo "Test 16: missing contract sections fail section hashing"
contract_missing="$test_dir/contract-missing-section.json"
cat > "$contract_missing" <<'EOF'
{"schemaVersion":1}
EOF
set +e
compute_pnpm_contract_section_hash node "$contract_missing" dependencyGraphContract >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "missing section hash should fail"

echo "Test 17: resolve_package_bin refuses node_modules lookup without the legacy opt-in"
bin_fixture="$test_dir/bin-fixture"
make_bin_fixture "$bin_fixture"
set +e
refusal="$(PNPM_LEGACY_NODE_MODULES=0 resolve_package_bin fake-tool fake-tool "$bin_fixture" 2>&1 >/dev/null)"
exit_code=$?
set -e
assert_exit_code 64 "$exit_code" "non-legacy package-bin lookup should fail with exit 64"
case "$refusal" in
  *"package-bin lookup through node_modules is legacy-only"*) ;;
  *)
    echo "FAIL: non-legacy package-bin lookup should explain the legacy-only contract"
    echo "  actual: $refusal"
    exit 1
    ;;
esac

echo "Test 17b: resolve_package_bin prefers package-local .bin shims under the legacy opt-in"
# Legacy node_modules bin resolution is opt-in only (managed tasks export this
# exactly like test.nix's vitest exec does); the lookup contract below is what
# those legacy consumers rely on.
export PNPM_LEGACY_NODE_MODULES=1
resolved_bin="$(resolve_package_bin fake-tool fake-tool "$bin_fixture")"
expected_bin="$bin_fixture/node_modules/.bin/fake-tool"
assert_eq \
  "$expected_bin" \
  "$resolved_bin" \
  "resolve_package_bin prefers the generated .bin shim"

echo "Test 18: run_package_bin executes the .bin shim when present"
output="$(cd "$bin_fixture" && run_package_bin fake-tool fake-tool alpha beta)"
assert_eq \
  "fake-tool-shim:alpha beta" \
  "$output" \
  "run_package_bin executes the resolved shim"

echo "Test 19: resolve_package_bin falls back to the package bin file"
fallback_fixture="$test_dir/fallback-bin-fixture"
make_bin_fixture_without_shim "$fallback_fixture"
resolved_fallback_bin="$(resolve_package_bin fallback-tool fallback-tool "$fallback_fixture")"
expected_fallback_bin="$(cd "$fallback_fixture/node_modules/fallback-tool/bin" && pwd -P)/fallback-tool.js"
assert_eq \
  "$expected_fallback_bin" \
  "$resolved_fallback_bin" \
  "resolve_package_bin falls back to the package bin file"
unset PNPM_LEGACY_NODE_MODULES

echo "Test 20: Projection health passes when symlinked package can resolve deps"
healthy_dir="$test_dir/healthy"
make_projection_fixture "$healthy_dir" 1
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$healthy_dir/node_modules"
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health passes"

echo "Test 20b: Projection health canonicalizes an aliased materialization root"
healthy_real_dir="$test_dir/healthy-real"
healthy_alias_dir="$test_dir/healthy-alias"
make_projection_fixture "$healthy_real_dir" 1
ln -s "$healthy_real_dir" "$healthy_alias_dir"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$healthy_alias_dir/node_modules"
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health accepts canonical paths through a root alias"

echo "Test 21: Projection health ignores packages that do not export ./package.json"
exports_dir="$test_dir/exports"
make_projection_fixture "$exports_dir" 1 1
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$exports_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health should not depend on package.json exports"

echo "Test 22: Projection health fails when symlinked package loses a transitive dep"
stale_dir="$test_dir/stale"
make_projection_fixture "$stale_dir" 0
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$stale_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "projection health detects missing dep"

echo "Test 23: Projection health does not require source link deps to resolve"
source_link_dir="$test_dir/source-link"
make_source_link_fixture "$source_link_dir"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$source_link_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health skips source link dependency resolution"

echo "Test 23b: Projection health rejects a dependency edge to a foreign sibling pnpm package instance"
foreign_root_dir="$test_dir/foreign-root"
foreign_sibling_dir="$test_dir/foreign-sibling"
make_foreign_package_instance_fixture "$foreign_root_dir" "$foreign_sibling_dir"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$foreign_root_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "projection health rejects foreign sibling package instance"

echo "Test 24: Broken node_modules symlink is rejected before projection checks"
broken_dir="$test_dir/broken"
mkdir -p "$broken_dir/node_modules"
ln -s ../missing "$broken_dir/node_modules/broken"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$broken_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "broken symlink is rejected"

echo "Test 25: Projection health fails when a package export target is missing"
missing_export_dir="$test_dir/missing-export"
make_missing_export_fixture "$missing_export_dir"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$missing_export_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "projection health detects missing package export target"

echo "Test 26: Projection health ignores unshipped conditional export targets"
unshipped_export_dir="$test_dir/unshipped-export"
make_unshipped_conditional_export_fixture "$unshipped_export_dir"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$unshipped_export_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health ignores export targets outside package files"

echo "Test 27: Projection health ignores missing declaration-only export targets"
missing_type_dir="$test_dir/missing-type-export"
make_missing_type_export_fixture "$missing_type_dir"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$missing_type_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health ignores type-only export targets"

echo "Test 28: Projection health accepts a package when one root conditional export target exists"
missing_condition_alternative_dir="$test_dir/missing-condition-alternative"
make_missing_conditional_export_alternative_fixture "$missing_condition_alternative_dir"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$missing_condition_alternative_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health accepts alternate runtime export targets"

echo "Test 29: Projection health ignores dependency names that Node resolves as built-ins"
builtin_dependency_dir="$test_dir/builtin-dependency"
make_builtin_dependency_fixture "$builtin_dependency_dir"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$builtin_dependency_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health ignores built-in dependency names"

echo "Test 30: Projection health accepts extensionless main and root export targets"
extensionless_main_dir="$test_dir/extensionless-main"
make_extensionless_main_fixture "$extensionless_main_dir"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$extensionless_main_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health accepts extensionless runtime targets"

echo "Test 31: Projection health ignores missing optional subpath export targets"
missing_subpath_export_dir="$test_dir/missing-subpath-export"
make_missing_subpath_export_fixture "$missing_subpath_export_dir"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$missing_subpath_export_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health ignores optional subpath exports"

echo "Test 32: Projection health gives exports precedence over a stale legacy main target"
exports_override_main_dir="$test_dir/exports-override-main"
make_exports_override_stale_main_fixture "$exports_override_main_dir"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$exports_override_main_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health accepts valid exports despite a stale legacy main"
assert_eq \
  "index.cjs" \
  "$(cd "$exports_override_main_dir" && node -e 'const path = require("node:path"); process.stdout.write(path.basename(require.resolve("pkg")))')" \
  "Node resolves the exported require target instead of legacy main"

echo "Test 33: Projection digest supports npm's default package file set"
default_files_dir="$test_dir/default-files"
make_default_files_fixture "$default_files_dir"
set +e
NODE_MODULES_HELPER_MODE=projection-hash \
  NODE_MODULES_DIRS="$default_files_dir/node_modules" \
  PNPM_ROOT_MODULES_YAML="$default_files_dir/node_modules/.modules.yaml" \
  node "$PROJECTION_SCRIPT" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection digest handles packages without a files field"

echo "Test 34: Linux shared storage selects one full store and automatic zero-copy imports"
(
  storage_root="$test_dir/storage-root"
  shared_store="$test_dir/shared-store"
  mkdir -p "$storage_root"
  unset CI PNPM_STORE_DIR PNPM_CONFIG_STORE_DIR npm_config_store_dir
  export PNPM_SHARED_STORE_DIR="$shared_store"
  export PNPM_MIN_FREE_KIB=0
  configure_pnpm_storage node "$storage_root" "$test_dir/job-store" true
  assert_eq "$shared_store" "$npm_config_store_dir" "local roots select the host-owned full store"
  assert_eq "auto" "$PNPM_PACKAGE_IMPORT_METHOD" "Linux delegates safe zero-copy selection to pnpm"
  test -d "$shared_store/v11/files"
  test ! -L "$shared_store/v11/files"
)

echo "Test 34b: historical shared-files pools stay outside the managed store"
(
  storage_root="$test_dir/fresh-storage-root"
  isolated_home="$test_dir/fresh-storage-home"
  historical_pool="$isolated_home/.local/share/pnpm/shared-files/v11"
  mkdir -p "$storage_root" "$historical_pool"
  printf 'historical\n' > "$historical_pool/sentinel"
  export HOME="$isolated_home"
  unset CI PNPM_SHARED_STORE_DIR PNPM_SHARED_FILES_DIR PNPM_STORE_DIR PNPM_CONFIG_STORE_DIR npm_config_store_dir
  configure_pnpm_storage node "$storage_root" "$test_dir/job-store" true
  assert_eq "$isolated_home/.local/share/pnpm/store-shared-v1" "$npm_config_store_dir" "default local store uses its fresh namespace"
  test -d "$npm_config_store_dir/v11/files"
  test ! -L "$npm_config_store_dir/v11/files"
  test -f "$historical_pool/sentinel"
)

echo "Test 34c: a preexisting external files bridge fails closed"
(
  storage_root="$test_dir/bridged-storage-root"
  isolated_home="$test_dir/bridged-storage-home"
  shared_store="$isolated_home/.local/share/pnpm/store-shared-v1"
  historical_pool="$isolated_home/.local/share/pnpm/shared-files/v11"
  mkdir -p "$storage_root" "$shared_store/v11" "$historical_pool"
  ln -s "$historical_pool" "$shared_store/v11/files"
  export HOME="$isolated_home"
  unset CI PNPM_SHARED_STORE_DIR PNPM_SHARED_FILES_DIR PNPM_STORE_DIR PNPM_CONFIG_STORE_DIR npm_config_store_dir
  set +e
  output="$(set -e; configure_pnpm_storage node "$storage_root" "$test_dir/job-store" true 2>&1)"
  exit_code=$?
  set -e
  assert_exit_code 1 "$exit_code" "preexisting external Store Cache bridge should fail before pnpm runs"
  grep -qF "Refusing external pnpm Store Cache bridge" <<< "$output"
  test -L "$shared_store/v11/files"
)

echo "Test 34d: a preexisting external store-version bridge fails before mutation"
(
  storage_root="$test_dir/version-bridged-storage-root"
  isolated_home="$test_dir/version-bridged-storage-home"
  shared_store="$isolated_home/.local/share/pnpm/store-shared-v1"
  external_version="$test_dir/external-store-version"
  mkdir -p "$storage_root" "$shared_store" "$external_version"
  ln -s "$external_version" "$shared_store/v11"
  export HOME="$isolated_home"
  unset CI PNPM_SHARED_STORE_DIR PNPM_SHARED_FILES_DIR PNPM_STORE_DIR PNPM_CONFIG_STORE_DIR npm_config_store_dir
  set +e
  output="$(set -e; configure_pnpm_storage node "$storage_root" "$test_dir/job-store" true 2>&1)"
  exit_code=$?
  set -e
  assert_exit_code 1 "$exit_code" "external Store Cache version bridge should fail before creating files"
  grep -qF "Refusing external pnpm Store Cache version bridge" <<< "$output"
  test ! -e "$external_version/files"
)

echo "Test 34e: recognized legacy files bridge migrates in place under the stable store root"
(
  isolated_home="$test_dir/migration-home"
  shared_store="$isolated_home/.local/share/pnpm/store-shared-v1"
  historical_pool="$isolated_home/.local/share/pnpm/shared-files/v11"
  mkdir -p "$shared_store/v11/projects" "$historical_pool"
  printf 'historical\n' > "$historical_pool/sentinel"
  printf 'stale\n' > "$shared_store/v11/index.db"
  ln -s "$historical_pool" "$shared_store/v11/files"
  acquire_pnpm_store_cache_lease "$(resolve_flock_bin)" exclusive "$shared_store" 10
  lock_inode_before="$(stat -c %i "$shared_store/.effect-utils-pnpm-store-cache-maintenance.lock")"
  migrate_legacy_pnpm_store_cache "$shared_store" "$historical_pool"
  lock_inode_after="$(stat -c %i "$shared_store/.effect-utils-pnpm-store-cache-maintenance.lock")"
  assert_eq "$lock_inode_before" "$lock_inode_after" "migration preserves the maintenance-lock inode"
  test -d "$shared_store/v11/files"
  test ! -L "$shared_store/v11/files"
  test ! -e "$shared_store/v11/index.db"
  test ! -e "$shared_store/v11/projects"
  test -f "$historical_pool/sentinel"
  migrate_legacy_pnpm_store_cache "$shared_store" "$historical_pool"
)

echo "Test 34f: unknown legacy files bridge remains untouched"
(
  shared_store="$test_dir/unknown-migration-store"
  expected_pool="$test_dir/expected-migration-pool"
  unknown_pool="$test_dir/unknown-migration-pool"
  mkdir -p "$shared_store/v11" "$expected_pool" "$unknown_pool"
  ln -s "$unknown_pool" "$shared_store/v11/files"
  set +e
  output="$(migrate_legacy_pnpm_store_cache "$shared_store" "$expected_pool" 2>&1)"
  exit_code=$?
  set -e
  assert_exit_code 1 "$exit_code" "unknown legacy bridge must fail closed"
  grep -qF "Refusing unknown legacy Store Cache bridge" <<< "$output"
  test -L "$shared_store/v11/files"
)

echo "Test 35: Linux zero-copy storage fails closed across filesystems"
if [ -d /dev/shm ] && [ "$(stat -c '%d' /dev/shm)" != "$(stat -c '%d' "$test_dir")" ]; then
  cross_device_store="$(mktemp -d /dev/shm/effect-utils-pnpm-store.XXXXXX)"
  trap 'rm -rf "$test_dir" "$cross_device_store"' EXIT
  (
    storage_root="$test_dir/cross-device-root"
    mkdir -p "$storage_root"
    unset CI PNPM_STORE_DIR PNPM_CONFIG_STORE_DIR npm_config_store_dir
    export PNPM_SHARED_STORE_DIR="$cross_device_store"
    export PNPM_MIN_FREE_KIB=0
    set +e
    output="$(set -e; configure_pnpm_storage node "$storage_root" "$test_dir/job-store" true 2>&1)"
    exit_code=$?
    set -e
    assert_exit_code 1 "$exit_code" "cross-device zero-copy storage should fail before pnpm runs"
    grep -qF "Zero-copy pnpm storage requires one filesystem" <<< "$output"
    test ! -e "$cross_device_store/v11/index.db"
  )
  rm -rf "$cross_device_store"
else
  echo "SKIP: no writable second filesystem is available"
fi

echo "Test 35b: CI forces its declared job-local store"
(
  storage_root="$test_dir/ci-storage-root"
  job_store="$test_dir/ci-job-store"
  mkdir -p "$storage_root"
  export CI=1
  export PNPM_STORE_DIR="$test_dir/runner-shared-store"
  export PNPM_CONFIG_STORE_DIR="$test_dir/runner-shared-store"
  export npm_config_store_dir="$test_dir/runner-shared-store"
  configure_pnpm_storage node "$storage_root" "$job_store" true
  assert_eq "$job_store" "$npm_config_store_dir" "CI store authority remains job-local"
  assert_eq "auto" "$PNPM_PACKAGE_IMPORT_METHOD" "CI uses the same native import policy"
)

echo "Test 35c: capacity checks each distinct writable device exactly once"
(
  unset CI
  export PNPM_MIN_FREE_KIB=0
  capacity_log="$test_dir/capacity-df.log"
  store_dir="$test_dir/capacity-store"
  root_dir="$test_dir/capacity-root"
  mkdir -p "$store_dir" "$root_dir"
  df() {
    printf '%s\n' "$*" >> "$capacity_log"
    command df "$@"
  }
  assert_pnpm_storage_capacity node "$store_dir" "$root_dir"
  assert_eq "1" "$(wc -l < "$capacity_log" | tr -d ' ')" "same-device boundaries are checked once"

  if [ -d /dev/shm ] && [ "$(stat -c '%d' /dev/shm)" != "$(stat -c '%d' "$test_dir")" ]; then
    second_device_root="$(mktemp -d /dev/shm/effect-utils-capacity-root.XXXXXX)"
    : > "$capacity_log"
    assert_pnpm_storage_capacity node "$store_dir" "$second_device_root"
    assert_eq "2" "$(wc -l < "$capacity_log" | tr -d ' ')" "distinct devices are both checked"
    rm -rf "$second_device_root"
  fi
)

echo ""
echo "All pnpm task helper tests passed"
