#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"
FIXTURES="$TESTS_DIR/fixtures"

SYSTEM="${NIX_SYSTEM:-}"
SKIP_GENIE=0
SKIP_MEGAREPO=0
SKIP_OXLINT=0
SKIP_DEVENV_SHELL=0
SKIP_DOWNSTREAM=0
SKIP_DOWNSTREAM_MEGAREPO=0
WORKSPACE=""
KEEP=0

usage() {
  cat <<'USAGE'
Usage: run.sh [options]

Options:
  --system <system>   Nix system to build (defaults to builtins.currentSystem)
  --workspace <path>  Use a fixed temp workspace directory for downstream tests
  --keep              Keep the temp workspace after the run
  --skip-genie        Skip building the genie CLI
  --skip-megarepo     Skip building the megarepo CLI
  --skip-oxlint       Skip the downstream oxlint-npm regression build
  --skip-devenv-shell Skip downstream devenv shell coverage
  --skip-downstream   Skip downstream flake-input regression coverage
  --skip-downstream-megarepo
                     Skip the downstream megarepo regression build
  --help              Show this help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --system)
      if [ $# -lt 2 ]; then
        usage
        exit 1
      fi
      SYSTEM="$2"
      shift 2
      ;;
    --workspace)
      if [ $# -lt 2 ]; then
        usage
        exit 1
      fi
      WORKSPACE="$2"
      shift 2
      ;;
    --keep)
      KEEP=1
      shift
      ;;
    --skip-genie)
      SKIP_GENIE=1
      shift
      ;;
    --skip-megarepo)
      SKIP_MEGAREPO=1
      shift
      ;;
    --skip-oxlint)
      SKIP_OXLINT=1
      shift
      ;;
    --skip-devenv-shell)
      SKIP_DEVENV_SHELL=1
      shift
      ;;
    --skip-downstream)
      SKIP_DOWNSTREAM=1
      shift
      ;;
    --skip-downstream-megarepo)
      SKIP_DOWNSTREAM_MEGAREPO=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

cleanup() {
  if [ "$KEEP" -eq 0 ] && [ -n "$WORKSPACE" ] && [ -d "$WORKSPACE" ] && [ -z "${EXPLICIT_WORKSPACE:-}" ]; then
    rm -rf "$WORKSPACE"
  fi
}
trap cleanup EXIT

if [ -z "$SYSTEM" ]; then
  SYSTEM="$(nix eval --impure --raw --expr builtins.currentSystem)"
fi

copy_repo() {
  local src="$1"
  local dest="$2"
  local excludes=(
    ".git"
    ".devenv"
    ".cache"
    ".turbo"
    ".next"
    ".bun"
    "node_modules"
    "dist"
    "result"
    "coverage"
    "tmp"
    "out"
  )
  local tar_args=()
  for name in "${excludes[@]}"; do
    tar_args+=(--exclude="$name")
  done
  mkdir -p "$dest"
  (cd "$src" && tar "${tar_args[@]}" -cf - .) | (cd "$dest" && tar -xf -)
}

build_and_smoke() {
  local attr="$1"
  local bin_name="$2"

  echo "Build: $attr ($SYSTEM)"
  local out
  out="$(
    cd "$ROOT" &&
      nix build --no-link --no-write-lock-file --print-out-paths ".#packages.$SYSTEM.$attr"
  )"

  echo "Smoke: $bin_name --help"
  "$out/bin/$bin_name" --help >/dev/null

  check_completions "$out" "$bin_name"
}

prepare_downstream_workspace() {
  if [ -z "$WORKSPACE" ]; then
    WORKSPACE="$(mktemp -d "${TMPDIR:-/tmp}/mk-pnpm-cli-downstream.XXXXXX")"
  else
    EXPLICIT_WORKSPACE=1
    mkdir -p "$WORKSPACE"
    if [ -n "$(ls -A "$WORKSPACE")" ]; then
      echo "Workspace directory is not empty: $WORKSPACE" >&2
      exit 1
    fi
  fi

  WORKSPACE_REAL="$(cd "$WORKSPACE" && pwd -P)"
  DOWNSTREAM_DIR="$WORKSPACE_REAL/downstream"

  cp -R "$FIXTURES/downstream" "$DOWNSTREAM_DIR"
  copy_repo "$ROOT" "$WORKSPACE_REAL/effect-utils"
  mkdir -p "$WORKSPACE_REAL/repos"
  copy_repo "$ROOT" "$WORKSPACE_REAL/repos/effect-utils"
}

check_completions() {
  local out="$1"
  local bin_name="$2"

  echo "Check: $bin_name shell completions"
  local fish_file="$out/share/fish/vendor_completions.d/${bin_name}.fish"
  local bash_file="$out/share/bash-completion/completions/${bin_name}"
  local zsh_file="$out/share/zsh/site-functions/_${bin_name}"
  for f in "$fish_file" "$bash_file" "$zsh_file"; do
    if [ ! -f "$f" ] && [ ! -L "$f" ]; then
      echo "error: missing completion file: $f" >&2
      exit 1
    fi
    if [ ! -s "$f" ]; then
      echo "error: empty completion file: $f" >&2
      exit 1
    fi
  done
}

run_downstream_regression() {
  local attr="$1"
  local bin_name="${2:-}"
  local start
  start="$(date +%s)"

  echo "Build: downstream $attr (standalone effect-utils path)"
  nix build --no-link --no-write-lock-file \
    --override-input effect-utils "path:$WORKSPACE_REAL/effect-utils" \
    "path:$DOWNSTREAM_DIR#packages.$SYSTEM.$attr"

  echo "Build: downstream $attr (composed repos/effect-utils path)"
  local out
  out="$(nix build --no-link --no-write-lock-file --print-out-paths \
    --override-input effect-utils "path:$WORKSPACE_REAL/repos/effect-utils" \
    "path:$DOWNSTREAM_DIR#packages.$SYSTEM.$attr")"

  if [ -n "$bin_name" ]; then
    check_completions "$out" "$bin_name"
  fi

  if [ "$SKIP_DEVENV_SHELL" -eq 0 ]; then
    echo "Devenv: downstream shell with composed repos/effect-utils path"
    (
      cd "$DOWNSTREAM_DIR" &&
        devenv shell \
          --override-input effect-utils "path:$WORKSPACE_REAL/repos/effect-utils" \
          --no-tui \
          -- true
    )
  fi

  echo "Timing: downstream-$attr $(( $(date +%s) - start ))s"
}

run_downstream_pure_eval_regression() {
  local start
  start="$(date +%s)"

  echo "Build: downstream pure-eval regression (standalone effect-utils path)"
  nix build --no-link --no-write-lock-file \
    --override-input effect-utils "path:$WORKSPACE_REAL/effect-utils" \
    "path:$DOWNSTREAM_DIR#checks.$SYSTEM.pure-eval-external-install-roots"

  echo "Build: downstream pure-eval derived-workspace-root regression (standalone effect-utils path)"
  nix build --no-link --no-write-lock-file \
    --override-input effect-utils "path:$WORKSPACE_REAL/effect-utils" \
    "path:$DOWNSTREAM_DIR#checks.$SYSTEM.pure-eval-derived-workspace-root"

  echo "Build: downstream pure-eval regression (composed repos/effect-utils path)"
  nix build --no-link --no-write-lock-file \
    --override-input effect-utils "path:$WORKSPACE_REAL/repos/effect-utils" \
    "path:$DOWNSTREAM_DIR#checks.$SYSTEM.pure-eval-external-install-roots"

  echo "Build: downstream pure-eval derived-workspace-root regression (composed repos/effect-utils path)"
  nix build --no-link --no-write-lock-file \
    --override-input effect-utils "path:$WORKSPACE_REAL/repos/effect-utils" \
    "path:$DOWNSTREAM_DIR#checks.$SYSTEM.pure-eval-derived-workspace-root"

  echo "Check: prepared source-input locators resolve through transient manifest aliases"
  nix build --no-link --no-write-lock-file \
    --override-input effect-utils "path:$WORKSPACE_REAL/repos/effect-utils" \
    "path:$DOWNSTREAM_DIR#checks.$SYSTEM.prepared-source-input-manifest-aliases"

  echo "Check: non-canonical source-input stage paths fail evaluation"
  nix build --no-link --no-write-lock-file \
    --override-input effect-utils "path:$WORKSPACE_REAL/repos/effect-utils" \
    "path:$DOWNSTREAM_DIR#checks.$SYSTEM.invalid-source-input-stage-path"

  echo "Build: downstream pure-eval profile-dedup regression (standalone effect-utils path)"
  nix build --no-link --no-write-lock-file \
    --override-input effect-utils "path:$WORKSPACE_REAL/effect-utils" \
    "path:$DOWNSTREAM_DIR#checks.$SYSTEM.pure-eval-profile-dedup"

  echo "Build: downstream pure-eval profile-dedup regression (composed repos/effect-utils path)"
  nix build --no-link --no-write-lock-file \
    --override-input effect-utils "path:$WORKSPACE_REAL/repos/effect-utils" \
    "path:$DOWNSTREAM_DIR#checks.$SYSTEM.pure-eval-profile-dedup"

  echo "Build: downstream pure-eval dependency materialization evidence regression"
  nix build --no-link --no-write-lock-file \
    --override-input effect-utils "path:$WORKSPACE_REAL/repos/effect-utils" \
    "path:$DOWNSTREAM_DIR#checks.$SYSTEM.pure-eval-dependency-materialization-evidence"

  echo "Check: downstream prepared deps use frozen lockfile mode and skip optional native deps"
  local drv
  drv="$(
    nix eval --raw --no-write-lock-file \
      --override-input effect-utils "path:$WORKSPACE_REAL/repos/effect-utils" \
      "path:$DOWNSTREAM_DIR#packages.$SYSTEM.mk-pnpm-cli-pure-eval-fixture.passthru.depsBuildsByInstallRoot.root.drvPath"
  )"
  local install_phase
  install_phase="$(nix derivation show "$drv" | jq -r '.derivations | to_entries[0].value.env.installPhase')"
  if [[ "$install_phase" == *' --filter '* ]]; then
    echo "error: aggregate prepared deps install still applies a filter that breaks pnpm 12 lockfile validation: $drv" >&2
    exit 1
  fi
  if [[ "$install_phase" != *'install --frozen-lockfile --no-optional --ignore-scripts'* ]]; then
    echo "error: prepared deps derivation does not use --frozen-lockfile: $drv" >&2
    exit 1
  fi
  if [[ "$install_phase" == *'install --no-frozen-lockfile'* ]]; then
    echo "error: prepared deps derivation still uses --no-frozen-lockfile: $drv" >&2
    exit 1
  fi
  if [[ "$install_phase" != *'--pm-on-fail=ignore'* ]]; then
    echo "error: prepared deps derivation does not disable pnpm package-manager self-resolution: $drv" >&2
    exit 1
  fi
  if [[ "$install_phase" != *'--config.dedupe-injected-deps=false'* ]]; then
    echo "error: prepared deps derivation may traverse injected packages outside the staged workspace: $drv" >&2
    exit 1
  fi
  if [[ "$install_phase" != *'--no-optional'* ]]; then
    echo "error: prepared deps derivation does not skip optional dependencies: $drv" >&2
    exit 1
  fi
  if [[ "$install_phase" != *'-name .devenv'* || "$install_phase" != *"-name '.pnpm-store*'"* || "$install_phase" != *"-name '.pnpm-home*'"* ]]; then
    echo "error: prepared deps derivation does not purge workspace-local pnpm store state: $drv" >&2
    exit 1
  fi

  echo "Check: prepared workspace relinks injected packages by pnpm locator identity"
  nix build --no-link --no-write-lock-file \
    --override-input effect-utils "path:$WORKSPACE_REAL/repos/effect-utils" \
    "path:$DOWNSTREAM_DIR#checks.$SYSTEM.prepared-workspace-injected-locator-identity"

  echo "Check: restored ordinary source-input file links expose logical source content"
  nix build --no-link --no-write-lock-file \
    --override-input effect-utils "path:$WORKSPACE_REAL/repos/effect-utils" \
    "path:$DOWNSTREAM_DIR#checks.$SYSTEM.prepared-workspace-source-input-file-links"

  echo "Check: downstream staged pnpm-workspace.yaml strips live-worktree pnpm settings"
  local deps_src
  deps_src="$(nix build --no-link --no-write-lock-file --print-out-paths \
    --override-input effect-utils "path:$WORKSPACE_REAL/repos/effect-utils" \
    "path:$DOWNSTREAM_DIR#packages.$SYSTEM.mk-pnpm-cli-pure-eval-fixture.passthru.depsSrcByInstallRoot.root")"
  for key in \
    enableGlobalVirtualStore \
    globalVirtualStoreDir \
    storeDir \
    virtualStoreDir \
    stateDir \
    cacheDir \
    packageImportMethod \
    nodeLinker \
    optimisticRepeatInstall \
    verifyDepsBeforeRun \
    sideEffectsCache \
    sideEffectsCacheReadonly \
    verifyStoreIntegrity \
    strictStorePkgContentCheck \
    pmOnFail; do
    if grep -q "^$key:" "$deps_src/pnpm-workspace.yaml"; then
      echo "error: staged pnpm-workspace.yaml kept live-worktree setting: $key" >&2
      exit 1
    fi
  done
  if [ -f "$deps_src/.npmrc" ]; then
    for key in \
      enable-global-virtual-store \
      global-virtual-store-dir \
      store-dir \
      virtual-store-dir \
      state-dir \
      cache-dir \
      package-import-method \
      node-linker \
      verify-deps-before-run \
      side-effects-cache \
      side-effects-cache-readonly \
      verify-store-integrity \
      strict-store-pkg-content-check \
      pm-on-fail; do
      if grep -Eq "^$key[[:space:]]*=" "$deps_src/.npmrc"; then
        echo "error: staged .npmrc kept live-worktree setting: $key" >&2
        exit 1
      fi
    done
  fi

  echo "Timing: downstream-pure-eval $(( $(date +%s) - start ))s"
}

run_inherit_root_patched_dependencies_regression() {
  local start
  start="$(date +%s)"

  echo "Check: inherit-root-patched-dependencies scalar lockfile and selector handling"
  local script
  script="$(
    cd "$ROOT" &&
      nix build --no-link --no-write-lock-file --print-out-paths ".#packages.$SYSTEM.genie.passthru.inheritRootPatchedDependenciesScript"
  )"

  local fixture
  fixture="$(mktemp -d "${TMPDIR:-/tmp}/mk-pnpm-cli-patches.XXXXXX")"
  mkdir -p "$fixture/authority/patches" "$fixture/target/.root-patches/patches"
  cat >"$fixture/authority/pnpm-workspace.yaml" <<'YAML'
packages: []

patchedDependencies:
  foo@1.2.3: patches/foo.patch
  foo@1.2.30: patches/foo-1.2.30.patch
  peer-pkg@2.0.0: patches/peer.patch
YAML
  cat >"$fixture/authority/pnpm-lock.yaml" <<'YAML'
lockfileVersion: '9.0'

patchedDependencies:
  foo@1.2.3: hash-foo
  foo@1.2.30: hash-foo-30
  peer-pkg@2.0.0: hash-peer

importers:
  .: {}
YAML
  cat >"$fixture/target/pnpm-workspace.yaml" <<'YAML'
packages: []
YAML
  cat >"$fixture/target/pnpm-lock.yaml" <<'YAML'
lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      foo:
        specifier: 1.2.30
        version: 1.2.30
      peer-pkg:
        specifier: 2.0.0
        version: 2.0.0(peer@1.0.0)

packages:
  peer-pkg@2.0.0:
    resolution: {integrity: sha512-peer}
    peerDependencies:
      peer: ^1.0.0

snapshots:
  foo@1.2.30: {}
  peer-pkg@2.0.0(peer@1.0.0): {}
YAML
  touch \
    "$fixture/target/.root-patches/patches/foo.patch" \
    "$fixture/target/.root-patches/patches/foo-1.2.30.patch" \
    "$fixture/target/.root-patches/patches/peer.patch"

  node "$script" "$fixture/authority" "$fixture/target"

  if grep -q "'foo@1.2.3'" "$fixture/target/pnpm-lock.yaml"; then
    echo "error: inherited prefix-matched patch foo@1.2.3 for target foo@1.2.30" >&2
    exit 1
  fi
  grep -q "'foo@1.2.30': hash-foo-30" "$fixture/target/pnpm-lock.yaml"
  grep -q "'peer-pkg@2.0.0': hash-peer" "$fixture/target/pnpm-lock.yaml"
  grep -q "version: 2.0.0(patch_hash=hash-peer)(peer@1.0.0)" "$fixture/target/pnpm-lock.yaml"
  grep -q "  peer-pkg@2.0.0:" "$fixture/target/pnpm-lock.yaml"
  grep -q "'peer-pkg@2.0.0(patch_hash=hash-peer)':" "$fixture/target/pnpm-lock.yaml"
  grep -q "  peer-pkg@2.0.0(peer@1.0.0):" "$fixture/target/pnpm-lock.yaml"
  grep -q "'peer-pkg@2.0.0(patch_hash=hash-peer)(peer@1.0.0)':" "$fixture/target/pnpm-lock.yaml"
  grep -q "'peer-pkg@2.0.0': .root-patches/patches/peer.patch" "$fixture/target/pnpm-workspace.yaml"
  rm -rf "$fixture"

  echo "Timing: inherit-root-patched-dependencies $(( $(date +%s) - start ))s"
}

if [ "$SKIP_GENIE" -eq 0 ]; then
  build_and_smoke "genie" "genie"
fi

if [ "$SKIP_MEGAREPO" -eq 0 ]; then
  build_and_smoke "megarepo" "mr"
fi

if [ "$SKIP_DOWNSTREAM" -eq 0 ]; then
  run_inherit_root_patched_dependencies_regression
  prepare_downstream_workspace
  run_downstream_pure_eval_regression
  run_downstream_regression "genie" "genie"
  if [ "$SKIP_DOWNSTREAM_MEGAREPO" -eq 0 ]; then
    run_downstream_regression "megarepo" "mr"
  fi
  if [ "$SKIP_OXLINT" -eq 0 ]; then
    run_downstream_regression "oxlint-npm"
  fi
fi

echo "mk-pnpm-cli smoke tests passed"
