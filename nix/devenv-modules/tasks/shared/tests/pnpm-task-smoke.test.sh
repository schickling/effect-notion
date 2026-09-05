#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

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

assert_json_field() {
  local expected="$1"
  local file="$2"
  local expression="$3"
  local label="$4"

  local actual
  actual="$(node -e "const fs = require('node:fs'); const value = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const out = (${expression})(value); process.stdout.write(String(out))" "$file")"
  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    exit 1
  fi
}

extract_task_script() {
  local workspace_root="$1"
  local attr="$2"
  local output_path="$3"
  local module_args="${4:-packages = [ ];}"
  local task_name="${5:-pnpm:install}"
  local host_is_darwin="${6:-false}"

  nix-instantiate --eval --strict --json --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      pkgsForTest = pkgs // {
        # The smoke test extracts task shell code directly via nix eval instead
        # of running a full derivation. Using toFile keeps helper scripts
        # addressable immediately, whereas pkgs.writeText would point at a store
        # path that is only realized when a derivation builds.
        writeText = name: text: builtins.toFile name text;
        stdenv = pkgs.stdenv // {
          hostPlatform = pkgs.stdenv.hostPlatform // {
            isDarwin = ${host_is_darwin};
          };
        };
      };
      # The install/doctor/repair/clean family is retired by default and only
      # reachable through the explicit legacy opt-in, so the shell-behavior
      # extractions below enable it. Ambient pnpm resolves the CLI from PATH,
      # which is what these extractions shim. genie and the lock mutator are
      # likewise shimmed. Per-call module args override these defaults.
      moduleArgs = {
        enableLegacyInstall = true;
        legacyAmbientPnpm = true;
        geniePkg = \"$tmpdir/fake-genie-pkg\";
      } // { ${module_args} };
      module = (import $ROOT/nix/devenv-modules/tasks/shared/pnpm.nix moduleArgs) {
        pkgs = pkgsForTest;
        lib = pkgs.lib;
        config = { devenv.root = \"$workspace_root\"; };
      };
    in (builtins.getAttr \"${task_name}\" module.tasks).${attr}
  " | jq -r . > "$output_path"
  chmod +x "$output_path"
}

eval_pnpm_package_count() {
  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      module = (import $ROOT/nix/devenv-modules/tasks/shared/pnpm.nix {
        packages = [ ];
        mkPnpmPkg = { pkgs }: pkgs.writeShellScriptBin \"pnpm\" \"exit 0\";
      }) {
        pkgs = pkgs;
        lib = pkgs.lib;
        config = { devenv.root = \"$workspace\"; };
      };
    in builtins.toString (builtins.length module.packages)
  "
}

# The repo pin is the SSOT for the pnpm CLI version, and the guard must exec it
# by absolute store path (see cli-guard.nix ownership notes). This proves the
# constructor contract end to end: the module builds the pinned package from
# its own pkgs and renders that exact executable.
eval_pnpm_guard_real_exec() {
  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      module = (import $ROOT/nix/devenv-modules/tasks/shared/pnpm.nix {
        packages = [ ];
        mkPnpmPkg = import $ROOT/nix/pnpm.nix;
      }) {
        pkgs = pkgs;
        lib = pkgs.lib;
        config = { devenv.root = \"$workspace\"; };
      };
      lines = builtins.filter (line:
        builtins.isString line && builtins.match \".*exec /nix/store/.*/bin/pnpm .*\" line != null
      ) (builtins.split \"\n\" (builtins.head module.packages).text);
    in builtins.concatStringsSep \"|\" lines
  "
}

# Evaluation regression guard: devenv resolves this module's `pkgs` argument
# through `_module.args`, which is only available after the module list is
# collected. Forcing the module attrset (what devenv does while collecting
# `imports`) must therefore never force `pkgs` — otherwise evaluation recurses
# (`error: infinite recursion`, see devenv.nix `mkPnpmPkg`). A throwing `pkgs`
# makes any such force a hard, legible failure.
eval_module_attrs_with_poisoned_pkgs() {
  nix-instantiate --eval --json --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      module = (import $ROOT/nix/devenv-modules/tasks/shared/pnpm.nix {
        packages = [ ];
        mkPnpmPkg = { pkgs }: pkgs.writeShellScriptBin \"pnpm\" \"exit 0\";
      }) {
        pkgs = throw \"pnpm.nix forced its pkgs module argument during module collection\";
        lib = pkgs.lib;
        config = { devenv.root = \"$workspace\"; };
      };
    in builtins.attrNames module
  " | jq -r 'sort | join(",")'
}

eval_versioned_lock_mutator() {
  local version="$1"

  nix-instantiate --eval --strict --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      affected = (pkgs.writeShellScriptBin \"pnpm\" \"exit 0\").overrideAttrs (_: {
        version = \"$version\";
      });
      module = (import $ROOT/nix/devenv-modules/tasks/shared/pnpm.nix {
        packages = [ ];
        pnpmLockMutatorPkg = affected;
      }) {
        pkgs = pkgs;
        lib = pkgs.lib;
        config = { devenv.root = \"$workspace\"; };
      };
    in module.tasks.\"pnpm:update\".exec
  "
}

eval_unversioned_lock_mutator() {
  nix-instantiate --eval --strict --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      module = (import $ROOT/nix/devenv-modules/tasks/shared/pnpm.nix {
        packages = [ ];
        pnpmLockMutatorPkg = pkgs.writeShellScriptBin \"pnpm\" \"exit 0\";
      }) {
        pkgs = pkgs;
        lib = pkgs.lib;
        config = { devenv.root = \"$workspace\"; };
      };
    in module.tasks.\"pnpm:update\".exec
  "
}

rewrite_unrealized_tool_paths() {
  local script_path="$1"

  # The smoke test evaluates the task shell text directly instead of building
  # the referenced helper packages. Patch the generated absolute store paths to
  # temp-local shims so the test only exercises task behavior, not derivation
  # realisation.
  perl -0pi -e '
    s#/nix/store/[^"\s]*/bin/flock#'"$tmpdir"'/bin/flock#g;
    s#/nix/store/[^"\s]*/bin/node#node#g;
    s#/nix/store/[^"\s]*-pnpm-11\.5\.1/bin/pnpm#'"$tmpdir"'/bin/pnpm-lock-mutator#g;
    s#/nix/store/[^"\s]*-pnpm-task-helpers\.sh#'"$ROOT"'/nix/devenv-modules/tasks/shared/pnpm-task-helpers.sh#g;
    s#/nix/store/[^"\s]*-check-node-modules-projection-health\.cjs#'"$ROOT"'/nix/devenv-modules/tasks/shared/check-node-modules-projection-health.cjs#g;
    s#/nix/store/[^"\s]*-stage-pnpm-source-inputs\.mjs#'"$ROOT"'/nix/devenv-modules/tasks/shared/stage-pnpm-source-inputs.mjs#g;
  ' "$script_path"
}

echo "Running pnpm task smoke test..."
echo ""

tmpdir="$(mktemp -d)"
trap 'if [ "${KEEP_PNPM_SMOKE_TMP:-0}" = "1" ]; then echo "pnpm smoke tmp: $tmpdir" >&2; else chmod -R u+w "$tmpdir" 2>/dev/null || true; rm -rf "$tmpdir"; fi' EXIT

workspace="$tmpdir/workspace"
mkdir -p "$workspace/.devenv/task-cache" "$workspace/.pnpm-home-a/store/v11" "$workspace/.pnpm-home-b/store/v11" "$tmpdir/bin" "$workspace/packages/demo/node_modules/.bin" "$workspace/nested/pkg"

echo "Preflight: module collection does not force the pkgs module argument"
assert_eq "enterShell,packages,tasks" "$(eval_module_attrs_with_poisoned_pkgs)" "pnpm module attrset must be forceable without pkgs"

echo "Preflight: mkPnpmPkg backs an exec-only guard, not a profile package"
assert_eq 1 "$(eval_pnpm_package_count)" "pnpm module packages should contain the pnpm guard only"

echo "Preflight: the guard execs the repo-pinned pnpm by absolute store path"
guard_exec="$(eval_pnpm_guard_real_exec)"
grep -qE '^  exec /nix/store/[^ ]*-pnpm-11\.8\.0/bin/pnpm "\$@"$' <<< "$guard_exec" || {
  echo "FAIL: pnpm guard should exec the pinned pnpm 11.8.0"
  echo "  actual: $guard_exec"
  exit 1
}

cat > "$workspace/package.json" <<'EOF'
{"name":"smoke-workspace","private":true}
EOF
cat > "$workspace/pnpm-workspace.yaml" <<'EOF'
packages: []
EOF
cat > "$workspace/pnpm-lock.yaml" <<'EOF'
lockfileVersion: '9.0'
settings: {}
importers: {}
packages: {}
EOF
cat > "$workspace/pnpm-install-contract.json" <<'EOF'
{
  "schemaVersion": 1,
  "packageManager": {"name": "pnpm", "version": "11.3.0"},
  "dependencyGraphContract": {"allowBuilds": {}, "packageExtensions": {}, "packageManager": {"name": "pnpm", "version": "11.3.0"}, "virtualStore": {"scope": "materialization-root", "path": "node_modules/.pnpm"}},
  "installPolicy": {"ignoreScripts": true},
  "storeContract": {"layoutVersion": "v11", "owner": "pnpm", "storeDir": ".devenv/pnpm-store-pure-v1"},
  "workspaceManifestContract": {"packages": []}
}
EOF
chmod 444 "$workspace/pnpm-install-contract.json"
cat > "$workspace/packages/demo/package.json" <<'EOF'
{"name":"demo","private":true}
EOF
cat > "$workspace/nested/package.json" <<'EOF'
{"name":"nested-workspace","private":true}
EOF
cat > "$workspace/nested/pnpm-workspace.yaml" <<'EOF'
packages: ["pkg"]
EOF
cat > "$workspace/nested/pnpm-lock.yaml" <<'EOF'
lockfileVersion: '9.0'
settings: {}
importers: {}
packages: {}
EOF
cat > "$workspace/nested/pkg/package.json" <<'EOF'
{"name":"nested-pkg","private":true}
EOF

cat > "$tmpdir/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${TEST_PNPM_LOG:?}"
printf 'PWD=%s\n' "$PWD" >> "${TEST_PNPM_LOG:?}"
if [ "${1:-}" = "--version" ]; then
  if [ "${TEST_PNPM_VERSION_READS_STDIN:-0}" = "1" ]; then
    cat >/dev/null
  fi
  echo "11.3.0"
  exit 0
fi
if [ "${1:-}" = "install" ]; then
  printf 'PNPM_HOME=%s\n' "${PNPM_HOME:-}" >> "${TEST_PNPM_LOG:?}"
  printf 'PNPM_STORE_DIR=%s\n' "${PNPM_STORE_DIR:-}" >> "${TEST_PNPM_LOG:?}"
  printf 'PNPM_CONFIG_STORE_DIR=%s\n' "${PNPM_CONFIG_STORE_DIR:-}" >> "${TEST_PNPM_LOG:?}"
  printf 'npm_config_store_dir=%s\n' "${npm_config_store_dir:-}" >> "${TEST_PNPM_LOG:?}"
  if [ "${TEST_PNPM_FAIL_NETWORK:-0}" = "1" ]; then
    echo "ERR_PNPM_META_FETCH_FAIL GET https://registry.npmjs.org/demo: request to https://registry.npmjs.org/demo failed, reason: Socket timeout" >&2
    exit 42
  fi
  mkdir -p \
    node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/node_modules \
    node_modules/.pnpm/dep@1.0.0/node_modules/dep \
    vendor/foreign-root/node_modules/.pnpm/dep@2.0.0/node_modules/dep
  touch node_modules/.install-ok
  printf '{"name":"pkg","version":"1.0.0","dependencies":{"dep":"1.0.0"}}\n' > node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/package.json
  printf '{"name":"dep","version":"1.0.0"}\n' > node_modules/.pnpm/dep@1.0.0/node_modules/dep/package.json
  printf '{"name":"dep","version":"2.0.0"}\n' > vendor/foreign-root/node_modules/.pnpm/dep@2.0.0/node_modules/dep/package.json
  ln -snf .pnpm/pkg@1.0.0/node_modules/pkg node_modules/pkg
  ln -snf ../../../../dep@1.0.0/node_modules/dep node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/node_modules/dep
  # The warm-path status now fingerprints the root projection metadata that
  # pnpm always writes on a real install. Keep the smoke fixture aligned with
  # that contract so the test still exercises the task logic instead of
  # failing on an unrealistically incomplete fake install.
  cat > node_modules/.modules.yaml <<YAML
hoistPattern: []
enableGlobalVirtualStore: false
nodeLinker: hoisted
storeDir: ${npm_config_store_dir}
virtualStoreDir: node_modules/.pnpm
YAML
  if [ -n "${TEST_PNPM_DARWIN_TEARDOWN_STATUS:-}" ]; then
    echo "Progress: resolved 777, reused 0, downloaded 777, added 777, done" >&2
    exit "$TEST_PNPM_DARWIN_TEARDOWN_STATUS"
  fi
  exit 0
fi
if [ "${1:-}" = "dedupe" ]; then
  exit 0
fi
echo "unexpected fake pnpm invocation: $*" >&2
exit 1
EOF
chmod +x "$tmpdir/bin/pnpm"

cat > "$tmpdir/bin/devenv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "$*" != "tasks run pnpm:install" ]; then
  echo "unexpected fake devenv invocation: $*" >&2
  exit 1
fi
exec bash "${TEST_INSTALL_SCRIPT:?}"
EOF
chmod +x "$tmpdir/bin/devenv"

cat > "$tmpdir/bin/pnpm-lock-mutator" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${TEST_PNPM_MUTATOR_LOG:?}"
printf 'PWD=%s\n' "$PWD" >> "${TEST_PNPM_MUTATOR_LOG:?}"
if [ "${1:-}" = "--version" ]; then
  echo "11.5.1"
  exit 0
fi
if [ "${1:-}" = "install" ]; then
  if [ "${TEST_PNPM_MUTATOR_STRIP_HAS_BIN:-0}" = "1" ]; then
    perl -0pi -e 's/^    hasBin: true\n//mg' pnpm-lock.yaml
  fi
  exit 0
fi
echo "unexpected fake pnpm lock mutator invocation: $*" >&2
exit 1
EOF
chmod +x "$tmpdir/bin/pnpm-lock-mutator"

cat > "$tmpdir/bin/genie" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${TEST_GENIE_LOG:?}"
exit 0
EOF
chmod +x "$tmpdir/bin/genie"

# The module renders genie by absolute path from geniePkg, so expose the shim
# through a package-shaped directory instead of relying on PATH.
mkdir -p "$tmpdir/fake-genie-pkg/bin"
ln -sf "$tmpdir/bin/genie" "$tmpdir/fake-genie-pkg/bin/genie"

cat > "$tmpdir/bin/flock" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

# The smoke test is single-process, so it only needs a no-op lock command to
# keep the generated task script moving through its install path.
printf 'flock %s\n' "$*" >> "${TEST_FLOCK_LOG:?}"
exit 0
EOF
chmod +x "$tmpdir/bin/flock"

mkdir -p "$workspace/packages/demo/node_modules/vitest/bin" "$workspace/packages/demo/node_modules/storybook/bin"
cat > "$workspace/packages/demo/node_modules/vitest/package.json" <<'EOF'
{"name":"vitest","bin":{"vitest":"bin/vitest.js"}}
EOF
cat > "$workspace/packages/demo/node_modules/vitest/bin/vitest.js" <<'EOF'
#!/usr/bin/env node
console.log(`vitest:${process.argv.slice(2).join(' ')}`)
EOF
chmod +x "$workspace/packages/demo/node_modules/vitest/bin/vitest.js"
cat > "$workspace/packages/demo/node_modules/.bin/vitest" <<'EOF'
#!/usr/bin/env bash
printf 'vitest-shim:%s\n' "$*"
EOF
chmod +x "$workspace/packages/demo/node_modules/.bin/vitest"
cat > "$workspace/packages/demo/node_modules/storybook/package.json" <<'EOF'
{"name":"storybook","bin":{"storybook":"bin/storybook.js"}}
EOF
cat > "$workspace/packages/demo/node_modules/storybook/bin/storybook.js" <<'EOF'
#!/usr/bin/env node
console.log(`storybook:${process.argv.slice(2).join(' ')}`)
EOF
chmod +x "$workspace/packages/demo/node_modules/storybook/bin/storybook.js"
cat > "$workspace/packages/demo/node_modules/.bin/storybook" <<'EOF'
#!/usr/bin/env bash
printf 'storybook-shim:%s\n' "$*"
EOF
chmod +x "$workspace/packages/demo/node_modules/.bin/storybook"
mkdir -p "$workspace/repos/source/packages/pkg"
printf 'source-v1\n' > "$workspace/repos/source/packages/pkg/value.txt"

extract_task_script "$workspace" "exec" "$tmpdir/pnpm-install.exec.sh" 'packages = [ ]; postInstallProjection = "touch .post-install-projection-marker";'
extract_task_script "$workspace" "status" "$tmpdir/pnpm-install.status.sh" 'packages = [ ]; postInstallProjection = "touch .post-install-projection-marker";'
extract_task_script "$workspace" "exec" "$tmpdir/pnpm-doctor.exec.sh" 'packages = [ ];' "pnpm:doctor"
extract_task_script "$workspace" "exec" "$tmpdir/pnpm-repair.exec.sh" 'packages = [ ];' "pnpm:repair"
extract_task_script "$workspace" "exec" "$tmpdir/pnpm-clean.exec.sh" 'packages = [ "packages/demo" ];' "pnpm:clean"
extract_task_script "$workspace" "exec" "$tmpdir/pnpm-update.exec.sh" 'packages = [ ];' "pnpm:update"
extract_task_script "$workspace" "exec" "$tmpdir/pnpm-dedupe.exec.sh" 'packages = [ ];' "pnpm:dedupe"
extract_task_script "$workspace" "exec" "$tmpdir/pnpm-source-install.exec.sh" 'packages = [ ]; sourceInputPaths = [ "repos/source/packages/pkg" ];'
extract_task_script "$workspace" "status" "$tmpdir/pnpm-source-install.status.sh" 'packages = [ ]; sourceInputPaths = [ "repos/source/packages/pkg" ];'
extract_task_script "$workspace" "exec" "$tmpdir/pnpm-source-update.exec.sh" 'packages = [ ]; sourceInputPaths = [ "repos/source/packages/pkg" ];' "pnpm:update"
extract_task_script "$workspace" "exec" "$tmpdir/pnpm-source-dedupe.exec.sh" 'packages = [ ]; sourceInputPaths = [ "repos/source/packages/pkg" ];' "pnpm:dedupe"
extract_task_script "$workspace" "exec" "$tmpdir/pnpm-update-nested.exec.sh" 'packages = [ ]; workspaceRoot = "nested"; taskSuffix = "nested";' "pnpm:update:nested"
extract_task_script "$workspace" "exec" "$tmpdir/pnpm-install-nested.exec.sh" 'packages = [ "pkg" ]; workspaceRoot = "nested"; taskSuffix = "nested";' "pnpm:install:nested"
extract_task_script "$workspace" "status" "$tmpdir/pnpm-install-nested.status.sh" 'packages = [ "pkg" ]; workspaceRoot = "nested"; taskSuffix = "nested";' "pnpm:install:nested"
extract_task_script "$workspace" "exec" "$tmpdir/pnpm-install-flags.exec.sh" 'packages = [ "." ]; installFlags = [ "--config.public-hoist-pattern=*" ]; preInstall = "touch .preinstall-marker";'
extract_task_script "$workspace" "exec" "$tmpdir/pnpm-install-darwin.exec.sh" 'packages = [ "." ];' "pnpm:install" "true"
extract_task_script "$workspace" "exec" "$tmpdir/pnpm-install-impure-flags.exec.sh" 'packages = [ "." ]; installFlags = [ "--no-frozen-lockfile" ];' "pnpm:install"
extract_task_script "$workspace" "exec" "$tmpdir/pnpm-install-impure-equals.exec.sh" 'packages = [ "." ]; installFlags = [ "--frozen-lockfile=false" ];' "pnpm:install"
extract_task_script "$workspace" "exec" "$tmpdir/pnpm-install-impure-separated.exec.sh" 'packages = [ "." ]; installFlags = [ "--config.package-import-method" "hardlink" ];' "pnpm:install"
extract_task_script "$workspace" "exec" "$tmpdir/pnpm-install-impure-store-dir-separated.exec.sh" 'packages = [ "." ]; installFlags = [ "--store-dir" "/tmp/other-pnpm-store" ];' "pnpm:install"
extract_task_script "$workspace" "exec" "$tmpdir/pnpm-install-impure-strict-store.exec.sh" 'packages = [ "." ]; installFlags = [ "--config.strict-store-pkg-content-check=false" ];' "pnpm:install"
extract_task_script "$workspace" "exec" "$tmpdir/pnpm-install-impure-pm-on-fail.exec.sh" 'packages = [ "." ]; installFlags = [ "--pm-on-fail=download" ];' "pnpm:install"
extract_task_script "$workspace" "exec" "$tmpdir/pnpm-install-impure-ignore-scripts.exec.sh" 'packages = [ "." ]; installFlags = [ "--config.ignore-scripts=false" ];' "pnpm:install"
extract_task_script "$workspace" "exec" "$tmpdir/pnpm-install-impure-ignore-dep-scripts.exec.sh" 'packages = [ "." ]; installFlags = [ "--config.ignore-dep-scripts=false" ];' "pnpm:install"
extract_task_script "$workspace" "exec" "$tmpdir/pnpm-install-impure-gvs.exec.sh" 'packages = [ "." ]; installFlags = [ "--config.enable-global-virtual-store=true" ];' "pnpm:install"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-install.exec.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-install.status.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-doctor.exec.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-repair.exec.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-clean.exec.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-update.exec.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-dedupe.exec.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-source-install.exec.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-source-install.status.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-source-update.exec.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-source-dedupe.exec.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-update-nested.exec.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-install-nested.exec.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-install-nested.status.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-install-flags.exec.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-install-darwin.exec.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-install-impure-flags.exec.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-install-impure-equals.exec.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-install-impure-separated.exec.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-install-impure-strict-store.exec.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-install-impure-pm-on-fail.exec.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-install-impure-ignore-scripts.exec.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-install-impure-ignore-dep-scripts.exec.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-install-impure-gvs.exec.sh"

export PATH="$tmpdir/bin:$PATH"
export TEST_PNPM_LOG="$tmpdir/pnpm.log"
export TEST_FLOCK_LOG="$tmpdir/flock.log"
export TEST_INSTALL_SCRIPT="$tmpdir/pnpm-install.exec.sh"
export TEST_PNPM_MUTATOR_LOG="$tmpdir/pnpm-mutator.log"
export TEST_GENIE_LOG="$tmpdir/genie.log"
unset CI
unset PNPM_STORE_DIR
unset PNPM_CONFIG_STORE_DIR
unset npm_config_store_dir

echo "Test 0: install ignores disposable historical root-local cache content"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  unset PNPM_HOME
  legacy_files="$workspace/.devenv/pnpm-store-pure-v1/v11/files"
  mkdir -p "$legacy_files"
  printf 'preserve-me\n' > "$legacy_files/sentinel"
  bash "$tmpdir/pnpm-install.exec.sh"
  test -f "$legacy_files/sentinel"
  test ! -L "$legacy_files"
  rm -rf "$legacy_files"
  rm -rf "$workspace/node_modules" "$workspace/vendor" "$workspace/.devenv/task-cache/pnpm-install"
)

echo "Test 1: status misses before install"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export PNPM_HOME="$workspace/.pnpm-home-a"
  set +e
  bash "$tmpdir/pnpm-install.status.sh"
  exit_code=$?
  set -e
  assert_exit_code 1 "$exit_code" "status should miss before install"
)

echo "Test 2: exec runs fake pnpm and populates cache"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export PNPM_HOME="$workspace/.pnpm-home-a"
  : > "$tmpdir/flock.log"
  bash "$tmpdir/pnpm-install.exec.sh"
  test -f "$workspace/.devenv/task-cache/pnpm-install/install-state.hash"
  test -f "$workspace/.devenv/task-cache/pnpm-install/projection-state.hash"
  test -f "$workspace/.devenv/task-cache/pnpm-install/pnpm-storage-state"
  test -f "$workspace/.post-install-projection-marker"
  test -d "$workspace/node_modules"
  test -f "$workspace/node_modules/.modules.yaml"
  grep -qxF "flock -w 600 200" "$tmpdir/flock.log"
  grep -qxF "flock -w 600 201" "$tmpdir/flock.log"
  grep -qxF "flock --shared -w 600 202" "$tmpdir/flock.log"
  ! grep -qF -- '--exclusive' "$tmpdir/flock.log"
  test "$(wc -l < "$tmpdir/flock.log")" -eq 3
  grep -qxF "install --frozen-lockfile --config.confirmModulesPurge=false --ignore-scripts --config.side-effects-cache=false --config.verify-store-integrity=true --config.strict-store-pkg-content-check=true --child-concurrency=1 --network-concurrency=4 --config.enable-global-virtual-store=false --config.virtual-store-dir=node_modules/.pnpm --pm-on-fail=ignore --config.package-import-method=auto --config.store-dir=$tmpdir/home/.local/share/pnpm/store-shared-v1" "$tmpdir/pnpm.log"
  grep -qF ".effect-utils-pnpm-install.lock" "$tmpdir/pnpm-install.exec.sh"
  ! grep -qF ".effect-utils-pnpm-store.lock" "$tmpdir/pnpm-install.exec.sh"
  test -w "$workspace/.devenv/task-cache/pnpm-install/pnpm-install-contract.json"
)

echo "Test 2b: exec replaces a read-only cached generated contract snapshot"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export PNPM_HOME="$workspace/.pnpm-home-a"
  chmod 444 "$workspace/.devenv/task-cache/pnpm-install/pnpm-install-contract.json"
  bash "$tmpdir/pnpm-install.exec.sh"
  test -w "$workspace/.devenv/task-cache/pnpm-install/pnpm-install-contract.json"
)

echo "Test 2c: lockfile mutation entrypoints stay lockfile-only, never realizing a topology"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export PNPM_HOME="$workspace/.pnpm-home-a"
  : > "$tmpdir/pnpm.log"
  : > "$tmpdir/pnpm-mutator.log"
  : > "$tmpdir/flock.log"
  bash "$tmpdir/pnpm-update.exec.sh"
  bash "$tmpdir/pnpm-dedupe.exec.sh"
  # Lock maintenance mutates pnpm-lock.yaml only: dependency realization
  # belongs to Buck, so no live-topology flags (virtual store, import method)
  # are passed and every mutation runs --lockfile-only.
  policy_flags="--config.confirmModulesPurge=false --ignore-scripts --config.side-effects-cache=false --config.verify-store-integrity=true --config.strict-store-pkg-content-check=true --child-concurrency=1 --network-concurrency=4 --pm-on-fail=ignore"
  grep -qxF "install --fix-lockfile --lockfile-only $policy_flags --config.store-dir=$tmpdir/home/.local/share/pnpm/store-shared-v1" "$tmpdir/pnpm-mutator.log"
  grep -qxF "dedupe --lockfile-only $policy_flags --config.store-dir=$tmpdir/home/.local/share/pnpm/store-shared-v1" "$tmpdir/pnpm.log"
  ! grep -qF -- "--config.package-import-method" "$tmpdir/pnpm-mutator.log"
  ! grep -qF -- "--config.virtual-store-dir" "$tmpdir/pnpm-mutator.log"
  ! grep -qF -- "--config.package-import-method" "$tmpdir/pnpm.log"
  ! grep -qF -- "--config.virtual-store-dir" "$tmpdir/pnpm.log"
  test "$(grep -cFx 'flock -w 600 200' "$tmpdir/flock.log")" -eq 2
  test "$(grep -cFx 'flock -w 600 201' "$tmpdir/flock.log")" -eq 2
  test "$(grep -cFx 'flock --shared -w 600 202' "$tmpdir/flock.log")" -eq 2
  ! grep -qF -- '--exclusive' "$tmpdir/flock.log"
  test "$(wc -l < "$tmpdir/flock.log")" -eq 6
  ! grep -qF "migrate_legacy_pnpm_store" "$tmpdir/pnpm-update.exec.sh"
  grep -qF "assert_pnpm_storage_capacity" "$tmpdir/pnpm-update.exec.sh"
  ! grep -qF "migrate_legacy_pnpm_store" "$tmpdir/pnpm-dedupe.exec.sh"
  grep -qF "assert_pnpm_storage_capacity" "$tmpdir/pnpm-dedupe.exec.sh"
)

echo "Test 2d: source-input publication has mutation parity and bounded generations"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export PNPM_HOME="$workspace/.pnpm-home-a"
  bash "$tmpdir/pnpm-source-install.exec.sh"
  published=".devenv/pnpm-source-inputs/current/repos/source/packages/pkg/value.txt"
  grep -qxF source-v1 "$published"
  bash "$tmpdir/pnpm-source-install.status.sh" 2>/dev/null
  bash "$tmpdir/pnpm-source-update.exec.sh"
  bash "$tmpdir/pnpm-source-dedupe.exec.sh"
  test "$(find .devenv/pnpm-source-inputs/generations -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 1

  printf 'source-v2\n' > repos/source/packages/pkg/value.txt
  set +e
  bash "$tmpdir/pnpm-source-install.status.sh" 2>/dev/null
  exit_code=$?
  set -e
  assert_exit_code 1 "$exit_code" "source change should invalidate install status"
  bash "$tmpdir/pnpm-source-install.exec.sh"
  grep -qxF source-v2 "$published"
  bash "$tmpdir/pnpm-source-install.status.sh"
  test "$(find .devenv/pnpm-source-inputs/generations -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 1
  bash "$tmpdir/pnpm-install.exec.sh"
)

echo "Test 3: status hits after install with the same root-local virtual topology"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export PNPM_HOME="$workspace/.pnpm-home-a"
  set +e
  bash "$tmpdir/pnpm-install.status.sh"
  exit_code=$?
  set -e
  assert_exit_code 0 "$exit_code" "status should hit after install"
)

echo "Test 3b: cached status rejects a nested dependency edge outside the root-local topology"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export PNPM_HOME="$workspace/.pnpm-home-a"
  export DEVENV_SETUP_OUTER_CACHE_HIT=1
  ln -snf "$workspace/vendor/foreign-root/node_modules/.pnpm/dep@2.0.0/node_modules/dep" node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/node_modules/dep
  set +e
  bash "$tmpdir/pnpm-install.status.sh"
  exit_code=$?
  set -e
  unset DEVENV_SETUP_OUTER_CACHE_HIT
  assert_exit_code 1 "$exit_code" "cached status should reject a foreign nested dependency edge"
  ln -snf ../../../../dep@1.0.0/node_modules/dep node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/node_modules/dep
)

echo "Test 4: outer cache hit still misses when projection metadata is missing"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export PNPM_HOME="$workspace/.pnpm-home-a"
  export DEVENV_SETUP_OUTER_CACHE_HIT=1
  rm -f node_modules/.modules.yaml
  set +e
  bash "$tmpdir/pnpm-install.status.sh"
  exit_code=$?
  set -e
  unset DEVENV_SETUP_OUTER_CACHE_HIT
  assert_exit_code 1 "$exit_code" "outer-hit status should miss when .modules.yaml is missing"
)

echo "Test 5: exec restores projection metadata after a miss"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export PNPM_HOME="$workspace/.pnpm-home-a"
  bash "$tmpdir/pnpm-install.exec.sh"
  test -f "$workspace/node_modules/.modules.yaml"
)

echo "Test 6: outer cache hit misses when a projected package symlink breaks"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export PNPM_HOME="$workspace/.pnpm-home-a"
  export DEVENV_SETUP_OUTER_CACHE_HIT=1
  mkdir -p node_modules/@scope
  ln -s ../missing-package node_modules/@scope/broken
  set +e
  bash "$tmpdir/pnpm-install.status.sh"
  exit_code=$?
  set -e
  unset DEVENV_SETUP_OUTER_CACHE_HIT
  assert_exit_code 1 "$exit_code" "outer-hit status should miss when a projected symlink is broken"
  rm node_modules/@scope/broken
)

echo "Test 7: exec defaults PNPM_HOME to a workspace-local projection"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  unset PNPM_HOME
  : > "$tmpdir/pnpm.log"
  bash "$tmpdir/pnpm-install.exec.sh"
  grep -qxF "PNPM_HOME=$workspace/.devenv/pnpm-home" "$tmpdir/pnpm.log"
  grep -qxF "PNPM_STORE_DIR=$tmpdir/home/.local/share/pnpm/store-shared-v1" "$tmpdir/pnpm.log"
  grep -qxF "PNPM_CONFIG_STORE_DIR=$tmpdir/home/.local/share/pnpm/store-shared-v1" "$tmpdir/pnpm.log"
  grep -qxF "npm_config_store_dir=$tmpdir/home/.local/share/pnpm/store-shared-v1" "$tmpdir/pnpm.log"
  test -d "$tmpdir/home/.local/share/pnpm/store-shared-v1/v11/files"
  doctor_decision="$(bash "$tmpdir/pnpm-doctor.exec.sh" | node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).decision)')"
  assert_eq "healthy" "$doctor_decision" "doctor validates the root-local graph"
  mkdir -p "$workspace/node_modules/corrupt-edge"
  touch "$workspace/node_modules/corrupt-edge/sentinel"
  : > "$tmpdir/pnpm.log"
  bash "$tmpdir/pnpm-repair.exec.sh" >/dev/null
  test ! -e "$workspace/node_modules/corrupt-edge"
  test -f "$workspace/node_modules/.install-ok"
  grep -qxF "PWD=$workspace" "$tmpdir/pnpm.log"
  CI=1 bash "$tmpdir/pnpm-install.exec.sh"
  set +e
  bash "$tmpdir/pnpm-install.status.sh"
  exit_code=$?
  set -e
  assert_exit_code 1 "$exit_code" "local status should miss after a CI job-local store install"
  bash "$tmpdir/pnpm-install.exec.sh"
)

echo "Test 8: status hits after install with the default root-local topology"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  unset PNPM_HOME
  set +e
  bash "$tmpdir/pnpm-install.status.sh"
  exit_code=$?
  set -e
  assert_exit_code 0 "$exit_code" "status should hit after default-PNPM_HOME install"
)

echo "Test 9: outer cache hit misses when a projected symlink disappears"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export PNPM_HOME="$workspace/.pnpm-home-a"
  export DEVENV_SETUP_OUTER_CACHE_HIT=1
  bash "$tmpdir/pnpm-install.exec.sh"
  rm -f node_modules/pkg
  set +e
  bash "$tmpdir/pnpm-install.status.sh"
  exit_code=$?
  set -e
  unset DEVENV_SETUP_OUTER_CACHE_HIT
  assert_exit_code 1 "$exit_code" "outer-hit status should miss when a projected symlink disappears"
  bash "$tmpdir/pnpm-install.exec.sh"
)

echo "Test 10: status still hits when PNPM_HOME changes but store-dir stays shared"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export PNPM_HOME="$workspace/.pnpm-home-b"
  set +e
  bash "$tmpdir/pnpm-install.status.sh"
  exit_code=$?
  set -e
  assert_exit_code 0 "$exit_code" "status should hit when only PNPM_HOME changes"
)

echo "Test 11: ambient pnpm store variables do not split the canonical host store"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export PNPM_CONFIG_STORE_DIR="$workspace/.other-pnpm-store"
  unset PNPM_STORE_DIR
  unset npm_config_store_dir
  set +e
  bash "$tmpdir/pnpm-install.status.sh"
  exit_code=$?
  set -e
  assert_exit_code 0 "$exit_code" "status should retain the canonical host store"
)

echo "Test 12: exec invoked pnpm install"
grep -q "^install " "$tmpdir/pnpm.log"

echo "Test 13: nested workspace exec uses its own cwd, cache, and PNPM_HOME with the host store"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  unset PNPM_HOME
  unset PNPM_STORE_DIR
  unset npm_config_store_dir
  : > "$tmpdir/pnpm.log"
  bash "$tmpdir/pnpm-install-nested.exec.sh"
  test -f "$workspace/.devenv/task-cache/pnpm-install/nested/install-state.hash"
  test ! -e "$workspace/.devenv/task-cache/pnpm-install/nested/pnpm-install-contract.json"
  test -d "$workspace/nested/node_modules"
  grep -qxF "PWD=$workspace/nested" "$tmpdir/pnpm.log"
  grep -qxF "PNPM_HOME=$workspace/.devenv/pnpm-home/nested" "$tmpdir/pnpm.log"
  grep -qxF "PNPM_STORE_DIR=$tmpdir/home/.local/share/pnpm/store-shared-v1" "$tmpdir/pnpm.log"
  grep -qxF "PNPM_CONFIG_STORE_DIR=$tmpdir/home/.local/share/pnpm/store-shared-v1" "$tmpdir/pnpm.log"
  grep -qxF "npm_config_store_dir=$tmpdir/home/.local/share/pnpm/store-shared-v1" "$tmpdir/pnpm.log"
)

echo "Test 14: nested workspace status hits after nested install"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  unset PNPM_HOME
  unset PNPM_STORE_DIR
  unset npm_config_store_dir
  set +e
  bash "$tmpdir/pnpm-install-nested.status.sh"
  exit_code=$?
  set -e
  assert_exit_code 0 "$exit_code" "nested status should hit after nested install"
)

echo "Test 14b: root contract evidence is fail-closed and never inherited by nested roots"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export PNPM_HOME="$workspace/.pnpm-home-a"
  mv pnpm-install-contract.json pnpm-install-contract.json.hidden
  set +e
  output="$(bash "$tmpdir/pnpm-install.status.sh" 2>&1)"
  exit_code=$?
  set -e
  mv pnpm-install-contract.json.hidden pnpm-install-contract.json
  assert_exit_code 1 "$exit_code" "repo root requires root-local generated contract evidence"
  grep -qF "Missing generated pnpm-install-contract.json at repo root" <<< "$output"

  bash "$tmpdir/pnpm-install-nested.status.sh"
)

echo "Test 15: nested workspace ignores ambient store-dir in favor of host authority"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  unset PNPM_HOME
  unset PNPM_STORE_DIR
  export PNPM_CONFIG_STORE_DIR="$workspace/.inherited-pnpm-store"
  unset npm_config_store_dir
  : > "$tmpdir/pnpm.log"
  bash "$tmpdir/pnpm-install-nested.exec.sh"
  grep -qxF "PNPM_STORE_DIR=$tmpdir/home/.local/share/pnpm/store-shared-v1" "$tmpdir/pnpm.log"
  grep -qxF "PNPM_CONFIG_STORE_DIR=$tmpdir/home/.local/share/pnpm/store-shared-v1" "$tmpdir/pnpm.log"
  grep -qxF "npm_config_store_dir=$tmpdir/home/.local/share/pnpm/store-shared-v1" "$tmpdir/pnpm.log"
)

echo "Test 16: install flags and pre-install hooks are applied"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  unset PNPM_HOME
  unset PNPM_STORE_DIR
  unset npm_config_store_dir
  rm -f .preinstall-marker
  : > "$tmpdir/pnpm.log"
  bash "$tmpdir/pnpm-install-flags.exec.sh"
  test -f .preinstall-marker
  grep -qxF "install --config.public-hoist-pattern=* --frozen-lockfile --config.confirmModulesPurge=false --ignore-scripts --config.side-effects-cache=false --config.verify-store-integrity=true --config.strict-store-pkg-content-check=true --child-concurrency=1 --network-concurrency=4 --config.enable-global-virtual-store=false --config.virtual-store-dir=node_modules/.pnpm --pm-on-fail=ignore --config.package-import-method=auto --config.store-dir=$tmpdir/home/.local/share/pnpm/store-shared-v1" "$tmpdir/pnpm.log"
)

echo "Test 17: impure no-frozen install flags are rejected before pnpm runs"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  unset PNPM_HOME
  unset PNPM_STORE_DIR
  unset npm_config_store_dir
  : > "$tmpdir/pnpm.log"
  set +e
  output="$(bash "$tmpdir/pnpm-install-impure-flags.exec.sh" 2>&1)"
  exit_code=$?
  set -e
  assert_exit_code 1 "$exit_code" "impure install flags should be rejected"
  grep -qF "[pnpm] Refusing impure install argument: --no-frozen-lockfile" <<< "$output"
  if grep -q "^install " "$tmpdir/pnpm.log"; then
    echo "FAIL: impure install flags should be rejected before invoking pnpm"
    exit 1
  fi
)

echo "Test 18: impure equals-form install flags are rejected before pnpm runs"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  unset PNPM_HOME
  unset PNPM_STORE_DIR
  unset npm_config_store_dir
  : > "$tmpdir/pnpm.log"
  set +e
  output="$(bash "$tmpdir/pnpm-install-impure-equals.exec.sh" 2>&1)"
  exit_code=$?
  set -e
  assert_exit_code 1 "$exit_code" "equals-form impure install flags should be rejected"
  grep -qF "[pnpm] Refusing impure install argument: --frozen-lockfile=false" <<< "$output"
  if grep -q "^install " "$tmpdir/pnpm.log"; then
    echo "FAIL: equals-form impure install flags should be rejected before invoking pnpm"
    exit 1
  fi
)

echo "Test 19: impure separated install flags are rejected before pnpm runs"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  unset PNPM_HOME
  unset PNPM_STORE_DIR
  unset npm_config_store_dir
  : > "$tmpdir/pnpm.log"
  set +e
  output="$(bash "$tmpdir/pnpm-install-impure-separated.exec.sh" 2>&1)"
  exit_code=$?
  set -e
  assert_exit_code 1 "$exit_code" "separated impure install flags should be rejected"
  grep -qF "[pnpm] Refusing impure install argument: --config.package-import-method" <<< "$output"
  if grep -q "^install " "$tmpdir/pnpm.log"; then
    echo "FAIL: separated impure install flags should be rejected before invoking pnpm"
    exit 1
  fi
)

echo "Test 20: impure separated store-dir flags are rejected before pnpm runs"
grep -qF -- "--config.store-dir=* | --config.store-dir | --store-dir=* | --store-dir)" "$tmpdir/pnpm-install-impure-store-dir-separated.exec.sh"
grep -qF -- 'reject_impure_pnpm_install_args "$@" --store-dir /tmp/other-pnpm-store' "$tmpdir/pnpm-install-impure-store-dir-separated.exec.sh"

echo "Test 21: impure strict-store flags are rejected before pnpm runs"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  unset PNPM_HOME
  unset PNPM_STORE_DIR
  unset npm_config_store_dir
  : > "$tmpdir/pnpm.log"
  set +e
  output="$(bash "$tmpdir/pnpm-install-impure-strict-store.exec.sh" 2>&1)"
  exit_code=$?
  set -e
  assert_exit_code 1 "$exit_code" "strict-store override should be rejected"
  grep -qF "[pnpm] Refusing impure install argument: --config.strict-store-pkg-content-check=false" <<< "$output"
  if grep -q "^install " "$tmpdir/pnpm.log"; then
    echo "FAIL: strict-store override should be rejected before invoking pnpm"
    exit 1
  fi
)

echo "Test 22: impure pm-on-fail flags are rejected before pnpm runs"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  unset PNPM_HOME
  unset PNPM_STORE_DIR
  unset npm_config_store_dir
  : > "$tmpdir/pnpm.log"
  set +e
  output="$(bash "$tmpdir/pnpm-install-impure-pm-on-fail.exec.sh" 2>&1)"
  exit_code=$?
  set -e
  assert_exit_code 1 "$exit_code" "pm-on-fail override should be rejected"
  grep -qF "[pnpm] Refusing impure install argument: --pm-on-fail=download" <<< "$output"
  if grep -q "^install " "$tmpdir/pnpm.log"; then
    echo "FAIL: pm-on-fail override should be rejected before invoking pnpm"
    exit 1
  fi
)

echo "Test 23: impure ignore-scripts overrides are rejected before pnpm runs"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  unset PNPM_HOME
  unset PNPM_STORE_DIR
  unset npm_config_store_dir
  : > "$tmpdir/pnpm.log"
  set +e
  output="$(bash "$tmpdir/pnpm-install-impure-ignore-scripts.exec.sh" 2>&1)"
  exit_code=$?
  set -e
  assert_exit_code 1 "$exit_code" "ignore-scripts override should be rejected"
  grep -qF "[pnpm] Refusing impure install argument: --config.ignore-scripts=false" <<< "$output"
  if grep -q "^install " "$tmpdir/pnpm.log"; then
    echo "FAIL: ignore-scripts override should be rejected before invoking pnpm"
    exit 1
  fi
)

echo "Test 24: impure ignore-dep-scripts overrides are rejected before pnpm runs"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  unset PNPM_HOME
  unset PNPM_STORE_DIR
  unset npm_config_store_dir
  : > "$tmpdir/pnpm.log"
  set +e
  output="$(bash "$tmpdir/pnpm-install-impure-ignore-dep-scripts.exec.sh" 2>&1)"
  exit_code=$?
  set -e
  assert_exit_code 1 "$exit_code" "ignore-dep-scripts override should be rejected"
  grep -qF "[pnpm] Refusing impure install argument: --config.ignore-dep-scripts=false" <<< "$output"
  if grep -q "^install " "$tmpdir/pnpm.log"; then
    echo "FAIL: ignore-dep-scripts override should be rejected before invoking pnpm"
    exit 1
  fi
)

echo "Test 24b: shared writable virtual topology overrides are rejected before pnpm runs"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  : > "$tmpdir/pnpm.log"
  set +e
  output="$(bash "$tmpdir/pnpm-install-impure-gvs.exec.sh" 2>&1)"
  exit_code=$?
  set -e
  assert_exit_code 1 "$exit_code" "GVS override should be rejected"
  grep -qF "Refusing impure install argument: --config.enable-global-virtual-store=true" <<< "$output"
  test ! -s "$tmpdir/pnpm.log"
)

echo "Test 25: CI install failures preserve and classify the pnpm log"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export CI=1
  export CI_DIAGNOSTICS_DIR="$tmpdir/diagnostics"
  export TEST_PNPM_FAIL_NETWORK=1
  unset PNPM_HOME
  unset PNPM_STORE_DIR
  unset npm_config_store_dir
  rm -f "$workspace/.devenv/task-cache/pnpm-install/install-state.hash"
  set +e
  output="$(bash "$tmpdir/pnpm-install.exec.sh" 2>&1)"
  exit_code=$?
  set -e
  unset TEST_PNPM_FAIL_NETWORK
  unset CI
  assert_exit_code 42 "$exit_code" "CI install should return the pnpm failure code"
  test -f "$tmpdir/diagnostics/pnpm-install.log"
  grep -qF "ERR_PNPM_META_FETCH_FAIL" "$tmpdir/diagnostics/pnpm-install.log"
  grep -qF "[pnpm] Install failed: registry/network fetch failure" <<< "$output"
  grep -qF "Socket timeout" <<< "$output"
)

echo "Test 26: Darwin CI install accepts completed pnpm materialization after teardown abort"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export CI=1
  export CI_DIAGNOSTICS_DIR="$tmpdir/diagnostics-darwin"
  export TEST_PNPM_DARWIN_TEARDOWN_STATUS=134
  unset PNPM_HOME
  unset PNPM_STORE_DIR
  unset npm_config_store_dir
  rm -f "$workspace/.devenv/task-cache/pnpm-install/install-state.hash"
  output="$(bash "$tmpdir/pnpm-install-darwin.exec.sh" 2>&1)"
  unset TEST_PNPM_DARWIN_TEARDOWN_STATUS
  unset CI
  grep -qF "[pnpm] Install completed materialization before darwin install teardown; continuing after node teardown exit 134" <<< "$output"
  test -f "$workspace/.devenv/task-cache/pnpm-install/install-state.hash"
)

echo "Test 27: Darwin CI install rejects SIGKILL even after apparent materialization"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export CI=1
  export CI_DIAGNOSTICS_DIR="$tmpdir/diagnostics-darwin-kill"
  export TEST_PNPM_DARWIN_TEARDOWN_STATUS=137
  unset PNPM_HOME
  unset PNPM_STORE_DIR
  unset npm_config_store_dir
  rm -f "$workspace/.devenv/task-cache/pnpm-install/install-state.hash"
  set +e
  output="$(bash "$tmpdir/pnpm-install-darwin.exec.sh" 2>&1)"
  exit_code=$?
  set -e
  unset TEST_PNPM_DARWIN_TEARDOWN_STATUS
  unset CI
  assert_exit_code 137 "$exit_code" "SIGKILL must not be promoted to a successful shared-store install"
  grep -qF "[pnpm] Install failed: pnpm install failure" <<< "$output"
  test ! -f "$workspace/.devenv/task-cache/pnpm-install/install-state.hash"
)

echo "Test 30: clean removes only root-owned topology and leaves shared content intact"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  mkdir -p "$tmpdir/home/.local/share/pnpm/store-shared-v1/v11/files/shared-pkg"
  mkdir -p "$workspace/node_modules" "$workspace/packages/demo/node_modules"
  bash "$tmpdir/pnpm-clean.exec.sh"
  test -d "$tmpdir/home/.local/share/pnpm/store-shared-v1/v11/files/shared-pkg"
  test ! -e "$workspace/node_modules"
  test ! -e "$workspace/packages/demo/node_modules"
)

echo "Test 31: affected pnpm 11 lock mutators are rejected at evaluation"
set +e
affected_output="$(eval_versioned_lock_mutator 11.8.0 2>&1)"
affected_exit=$?
set -e
assert_exit_code 1 "$affected_exit" "affected lock mutator should fail module evaluation"
grep -qF "pnpm lock mutator version 11.8.0 is not supported" <<< "$affected_output"

echo "Test 32: unverified pnpm 12 lock mutators are rejected at evaluation"
set +e
unverified_v12_output="$(eval_versioned_lock_mutator 12.0.0 2>&1)"
unverified_v12_exit=$?
set -e
assert_exit_code 1 "$unverified_v12_exit" "unverified pnpm 12 mutator should fail module evaluation"
grep -qF "pnpm lock mutator version 12.0.0 is not supported" <<< "$unverified_v12_output"

echo "Test 33: unversioned lock mutator overrides fail closed"
set +e
unversioned_output="$(eval_unversioned_lock_mutator 2>&1)"
unversioned_exit=$?
set -e
assert_exit_code 1 "$unversioned_exit" "unversioned lock mutator should fail module evaluation"
grep -qF "pnpm lock mutator version unknown is not supported" <<< "$unversioned_output"

echo "Test 34: root update defers validation, mutates with the dedicated binary, then validates"
cat > "$workspace/pnpm-lock.yaml" <<'EOF'
lockfileVersion: '9.0'
settings: {}
importers: {}
packages:
  fake-tool@1.0.0:
    resolution: {integrity: sha512-fixture}
    hasBin: true
snapshots: {}
EOF
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  unset PNPM_HOME
  unset PNPM_STORE_DIR
  unset PNPM_CONFIG_STORE_DIR
  unset npm_config_store_dir
  : > "$tmpdir/pnpm-mutator.log"
  : > "$tmpdir/genie.log"
  bash "$tmpdir/pnpm-update.exec.sh"
  grep -qxF -- "--defer-validation" "$tmpdir/genie.log"
  grep -qxF -- "--check" "$tmpdir/genie.log"
  policy_flags="--config.confirmModulesPurge=false --ignore-scripts --config.side-effects-cache=false --config.verify-store-integrity=true --config.strict-store-pkg-content-check=true --child-concurrency=1 --network-concurrency=4 --pm-on-fail=ignore"
  grep -qxF "install --fix-lockfile --lockfile-only $policy_flags --config.store-dir=$tmpdir/home/.local/share/pnpm/store-shared-v1" "$tmpdir/pnpm-mutator.log"
  grep -qF "hasBin: true" pnpm-lock.yaml
)

echo "Test 35: metadata loss fails closed and restores the previous lockfile"
cp "$workspace/pnpm-lock.yaml" "$tmpdir/pnpm-lock.before-strip.yaml"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export TEST_PNPM_MUTATOR_STRIP_HAS_BIN=1
  set +e
  strip_output="$(bash "$tmpdir/pnpm-update.exec.sh" 2>&1)"
  strip_exit=$?
  set -e
  assert_exit_code 1 "$strip_exit" "hasBin stripping should fail the update"
  grep -qF "stripped hasBin from retained package records" <<< "$strip_output"
  grep -qF "fake-tool@1.0.0" <<< "$strip_output"
  cmp -s pnpm-lock.yaml "$tmpdir/pnpm-lock.before-strip.yaml"
)

echo "Test 36: nested updates use the safe mutator without invoking root Genie"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  unset TEST_PNPM_MUTATOR_STRIP_HAS_BIN
  : > "$tmpdir/pnpm-mutator.log"
  : > "$tmpdir/genie.log"
  bash "$tmpdir/pnpm-update-nested.exec.sh"
  grep -qxF "PWD=$workspace/nested" "$tmpdir/pnpm-mutator.log"
  test ! -s "$tmpdir/genie.log"
)

echo ""
echo "pnpm task smoke test passed"
