#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"
MATERIALIZER="$ROOT/scripts/typescript-materialize-dist.sh"
PACKAGE_PATH="packages/@overeng/tui-core"
TARGET="effect_utils//packages/@overeng/tui-core:dist"
DECLARATION_ENTRYPOINT="src/mod.d.ts"
PROJECT="tsconfig.json"
DIFF_BIN="$(command -v diff)"
REAL_MV="$(command -v mv)"
TEST_ROOT="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$TEST_ROOT"' EXIT
export AGENT_POLICY_BYPASS=1

test_count=0
run_test() {
  name="$1"
  shift
  "$@"
  test_count=$((test_count + 1))
  echo "ok $test_count - $name"
}

make_repo() {
  repo="$1"
  rm -rf -- "$repo"
  mkdir -p "$repo/$PACKAGE_PATH/dist/src" "$repo/bin"
  printf 'old declarations\n' > "$repo/$PACKAGE_PATH/dist/$DECLARATION_ENTRYPOINT"
  cat > "$repo/bin/buck2" <<'BUCK'
#!/usr/bin/env bash
set -euo pipefail
if [ -n "${FAKE_BUCK_LOG:-}" ]; then
  printf '%s\n' "$@" > "$FAKE_BUCK_LOG"
fi
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--out" ]; then
    out="$2"
    shift 2
  else
    shift
  fi
done
case "${FAKE_BUCK_SCENARIO:?}" in
  missing-directory)
    ;;
  missing-mod)
    mkdir -p "$out/src"
    printf 'not the declaration\n' > "$out/src/other.d.ts"
    ;;
  success)
    mkdir -p "$out/src"
    printf '%s\n' "${NEW_DECLARATIONS:-new declarations}" > "$out/src/mod.d.ts"
    ;;
  *)
    echo "unknown fake Buck scenario: $FAKE_BUCK_SCENARIO" >&2
    exit 2
    ;;
esac
BUCK
  chmod +x "$repo/bin/buck2"
}

assert_old_dist() {
  repo="$1"
  expected='old declarations'
  actual="$(cat "$repo/$PACKAGE_PATH/dist/$DECLARATION_ENTRYPOINT")"
  [ "$actual" = "$expected" ] || {
    echo "FAIL: expected old dist to remain, got: $actual" >&2
    return 1
  }
}

# `compgen` is a programmable-completion builtin that the non-interactive
# nixpkgs `bash` is built without, so it is unavailable here and this assertion
# silently passed. Iterate the glob instead, which every POSIX shell supports.
assert_no_staging() {
  repo="$1"
  for staging in "$repo/$PACKAGE_PATH"/.dist-buck2.*; do
    [ -e "$staging" ] || continue
    echo "FAIL: materializer left a staging directory: $staging" >&2
    return 1
  done
}

test_missing_directory() {
  repo="$TEST_ROOT/missing-directory"
  make_repo "$repo"
  if FAKE_BUCK_SCENARIO=missing-directory TYPESCRIPT_DIST_MODE=publish \
    WORKSPACE_ROOT="$repo" BUCK2_BIN="$repo/bin/buck2" \
    bash "$MATERIALIZER" "$repo" "$PACKAGE_PATH" "$TARGET" "$DECLARATION_ENTRYPOINT" "$PROJECT"; then
    echo "FAIL: missing Buck output directory was accepted" >&2
    return 1
  fi
  assert_old_dist "$repo"
  assert_no_staging "$repo"
}

test_missing_mod() {
  repo="$TEST_ROOT/missing-mod"
  make_repo "$repo"
  if FAKE_BUCK_SCENARIO=missing-mod TYPESCRIPT_DIST_MODE=publish \
    WORKSPACE_ROOT="$repo" BUCK2_BIN="$repo/bin/buck2" \
    bash "$MATERIALIZER" "$repo" "$PACKAGE_PATH" "$TARGET" "$DECLARATION_ENTRYPOINT" "$PROJECT"; then
    echo "FAIL: Buck output without src/mod.d.ts was accepted" >&2
    return 1
  fi
  assert_old_dist "$repo"
  assert_no_staging "$repo"
}

test_replaces_stale_dist() {
  repo="$TEST_ROOT/replaces-stale"
  make_repo "$repo"
  FAKE_BUCK_SCENARIO=success NEW_DECLARATIONS='fresh declarations' \
    FAKE_BUCK_LOG="$repo/buck-args" TYPESCRIPT_DIST_MODE=publish \
    WORKSPACE_ROOT="$repo" BUCK2_BIN="$repo/bin/buck2" \
    bash "$MATERIALIZER" "$repo" "$PACKAGE_PATH" "$TARGET" "$DECLARATION_ENTRYPOINT" "$PROJECT"
  mapfile -t buck_args < "$repo/buck-args"
  # The materializer anchors its staging directory on the physical repository
  # root (`pwd -P`), so the expectation has to be stated in the same resolved
  # form. On macOS `$repo` is under the `/tmp` -> `/private/tmp` symlink; on
  # Linux `/tmp` is a real directory and this is the identity.
  repo_physical="$(cd "$repo" && pwd -P)"
  [ "${#buck_args[@]}" -eq 4 ] &&
    [ "${buck_args[0]}" = build ] &&
    [ "${buck_args[1]}" = "$TARGET" ] &&
    [ "${buck_args[2]}" = --out ] &&
    [[ "${buck_args[3]}" = "$repo_physical/$PACKAGE_PATH/.dist-buck2."*/dist ]] || {
      echo "FAIL: materializer did not invoke the expected Buck build" >&2
      return 1
    }
  actual="$(cat "$repo/$PACKAGE_PATH/dist/$DECLARATION_ENTRYPOINT")"
  [ "$actual" = 'fresh declarations' ] || {
    echo "FAIL: stale dist was not replaced by fresh bytes" >&2
    return 1
  }
  assert_no_staging "$repo"
}

test_post_publish_validation_failure() {
  repo="$TEST_ROOT/post-publish-validation"
  make_repo "$repo"
  cat > "$repo/bin/mv" <<'MV'
#!/usr/bin/env bash
set -euo pipefail
"$REAL_MV" "$@"
count=0
if [ -f "$MV_COUNT_FILE" ]; then
  count="$(cat "$MV_COUNT_FILE")"
fi
count=$((count + 1))
printf '%s\n' "$count" > "$MV_COUNT_FILE"
if [ "$count" -eq 1 ]; then
  target="${!#}"
  rm -f -- "$target/src/mod.d.ts"
fi
MV
  chmod +x "$repo/bin/mv"
  if PATH="$repo/bin:$PATH" REAL_MV="$REAL_MV" MV_COUNT_FILE="$repo/mv-count" \
    FAKE_BUCK_SCENARIO=success TYPESCRIPT_DIST_MODE=publish \
    WORKSPACE_ROOT="$repo" BUCK2_BIN="$repo/bin/buck2" \
    bash "$MATERIALIZER" "$repo" "$PACKAGE_PATH" "$TARGET" "$DECLARATION_ENTRYPOINT" "$PROJECT"; then
    echo "FAIL: post-publish validation failure returned success" >&2
    return 1
  fi
  assert_old_dist "$repo"
  assert_no_staging "$repo"
}

make_freshness_tools() {
  repo="$1"
  cat > "$repo/bin/tsgo" <<'TSGO'
#!/usr/bin/env bash
set -euo pipefail
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--outDir" ]; then
    out="$2"
    shift 2
  else
    shift
  fi
done
mkdir -p "$out/src"
printf '%s\n' "${FAKE_EMIT_DECLARATIONS:?}" > "$out/src/mod.d.ts"
TSGO
  chmod +x "$repo/bin/tsgo"
}

test_standalone_freshness_passes() {
  repo="$TEST_ROOT/standalone-fresh"
  make_repo "$repo"
  make_freshness_tools "$repo"
  FAKE_EMIT_DECLARATIONS='old declarations' TYPESCRIPT_DIST_MODE=check \
    TSGO_BIN="$repo/bin/tsgo" DIFF_BIN="$DIFF_BIN" \
    bash "$MATERIALIZER" "$repo" "$PACKAGE_PATH" "$TARGET" "$DECLARATION_ENTRYPOINT" "$PROJECT"
  assert_old_dist "$repo"
  assert_no_staging "$repo"
}

test_standalone_staleness_fails() {
  repo="$TEST_ROOT/standalone-stale"
  make_repo "$repo"
  make_freshness_tools "$repo"
  if FAKE_EMIT_DECLARATIONS='fresh declarations' TYPESCRIPT_DIST_MODE=check \
    TSGO_BIN="$repo/bin/tsgo" DIFF_BIN="$DIFF_BIN" \
    bash "$MATERIALIZER" "$repo" "$PACKAGE_PATH" "$TARGET" "$DECLARATION_ENTRYPOINT" "$PROJECT"; then
    echo "FAIL: stale standalone declarations were accepted" >&2
    return 1
  fi
  assert_old_dist "$repo"
  assert_no_staging "$repo"
}

extract_devenv_scripts() {
  local nix_expr
  nix_expr='let
    flake = builtins.getFlake "path:'"$ROOT"'";
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    module = import '"$ROOT"'/devenv.nix {
      inherit pkgs;
      lib = pkgs.lib;
      config = { };
      inputs.tsgo.packages.${pkgs.stdenv.hostPlatform.system}.effect-tsgo = "/tsgo";
    };
  in {
    enterShell = pkgs.writeShellScript "test-enter-shell" module.enterShell;
    materializeTask = pkgs.writeShellScript "test-materialize-task"
      module.tasks."buck2:typescript:materialize-dist".exec;
  }'
  cp "$(nix build --no-link --print-out-paths --impure --expr "$nix_expr.enterShell")" \
    "$TEST_ROOT/enter-shell.sh"
  cp "$(nix build --no-link --print-out-paths --impure --expr "$nix_expr.materializeTask")" \
    "$TEST_ROOT/materialize-task.sh"
  chmod +x "$TEST_ROOT/enter-shell.sh" "$TEST_ROOT/materialize-task.sh"
}

make_git_commit() {
  local checkout="$1"
  git init -q "$checkout"
  git -C "$checkout" config user.email test@example.invalid
  git -C "$checkout" config user.name Test
  printf 'fixture\n' > "$checkout/README"
  git -C "$checkout" add README
  git -C "$checkout" commit --no-verify -qm fixture
}

make_runtime_probe() {
  local checkout="$1"
  mkdir -p "$checkout/genie/buck2"
  cat > "$checkout/genie/buck2/typescript-authority-runtime.ts" <<'PROBE'
console.log([
  process.env.TYPESCRIPT_DIST_MODE,
  process.env.WORKSPACE_ROOT ?? '',
  process.env.BUCK2_BIN ?? '',
].join('|'))
PROBE
}

test_composed_worktree_selection() {
  local standalone seed repo_root workspace_root member_root mode admin_dir
  standalone="$TEST_ROOT/lookalike/repos/effect-utils"
  mkdir -p "$(dirname "$standalone")"
  make_git_commit "$standalone"
  make_runtime_probe "$standalone"
  printf 'parent sentinel\n' > "$TEST_ROOT/lookalike/.buckconfig.local"
  (
    cd "$standalone"
    env -u BUCK2_NO_REMOTE_CACHE DEVENV_ROOT="$standalone" bash "$TEST_ROOT/enter-shell.sh"
  )
  grep -qxF 'parent sentinel' "$TEST_ROOT/lookalike/.buckconfig.local"
  test -f "$standalone/.buckconfig.local"
  mode="$(DEVENV_ROOT="$standalone" bash "$TEST_ROOT/materialize-task.sh")"
  case "$mode" in
    check\|*) ;;
    *) echo "FAIL: repos/<name> lookalike selected publish mode: $mode" >&2; return 1 ;;
  esac

  seed="$TEST_ROOT/composed-seed"
  repo_root="$TEST_ROOT/store/github.com/overengineeringstudio/effect-utils"
  workspace_root="$repo_root/refs/heads/composed"
  member_root="$workspace_root/repos/effect-utils"
  make_git_commit "$seed"
  mkdir -p "$repo_root" "$(dirname "$member_root")"
  git clone -q --bare "$seed" "$repo_root/.bare"
  git --git-dir="$repo_root/.bare" worktree add -q -b composed "$member_root" HEAD
  make_runtime_probe "$member_root"
  mkdir -p "$workspace_root/.megarepo/bin"
  (
    cd "$member_root"
    env -u BUCK2_NO_REMOTE_CACHE DEVENV_ROOT="$member_root" bash "$TEST_ROOT/enter-shell.sh"
  )
  test -f "$workspace_root/.buckconfig.local"
  test ! -e "$member_root/.buckconfig.local"
  mode="$(DEVENV_ROOT="$member_root" bash "$TEST_ROOT/materialize-task.sh")"
  expected_mode="publish|$workspace_root|$workspace_root/.megarepo/bin/buck2"
  if [ "$mode" != "$expected_mode" ]; then
    echo "FAIL: composed materializer mode: expected '$expected_mode', got '$mode'" >&2
    return 1
  fi

  admin_dir="$(git -C "$member_root" rev-parse --path-format=absolute --git-dir)"
  mkdir -p "$TEST_ROOT/foreign"
  printf 'gitdir: nowhere\n' > "$TEST_ROOT/foreign/.git"
  printf '%s\n' "$TEST_ROOT/foreign/.git" > "$admin_dir/gitdir"
  rm -f "$workspace_root/.buckconfig.local"
  (
    cd "$member_root"
    env -u BUCK2_NO_REMOTE_CACHE DEVENV_ROOT="$member_root" bash "$TEST_ROOT/enter-shell.sh"
  )
  test ! -e "$workspace_root/.buckconfig.local"
  test ! -e "$member_root/.buckconfig.local"
  if DEVENV_ROOT="$member_root" bash "$TEST_ROOT/materialize-task.sh"; then
    echo 'FAIL: materializer accepted non-reciprocal metadata' >&2
    return 1
  fi
}

test_cleanup_refuses_nonreciprocal_worktree() {
  local runner store repo_root workspace_root member_root seed admin_dir
  runner="$TEST_ROOT/cleanup-runner"
  store="$runner/megarepo-store/cleanup"
  repo_root="$store/github.com/overengineeringstudio/effect-utils"
  workspace_root="$repo_root/refs/heads/ci-77-1-cleanup-test"
  member_root="$workspace_root/repos/effect-utils"
  seed="$TEST_ROOT/cleanup-seed"
  make_git_commit "$seed"
  mkdir -p "$repo_root" "$(dirname "$member_root")"
  git clone -q --bare "$seed" "$repo_root/.bare"
  git --git-dir="$repo_root/.bare" worktree add -q -b ci-77-1-cleanup-test \
    "$member_root" HEAD
  printf 'preserve until verified\n' > "$workspace_root/sentinel"
  admin_dir="$(git -C "$member_root" rev-parse --path-format=absolute --git-dir)"
  mkdir -p "$TEST_ROOT/cleanup-foreign"
  printf 'gitdir: nowhere\n' > "$TEST_ROOT/cleanup-foreign/.git"
  printf '%s\n' "$TEST_ROOT/cleanup-foreign/.git" > "$admin_dir/gitdir"

  if RUNNER_TEMP="$runner" MEGAREPO_STORE="$store" \
    GITHUB_RUN_ID=77 GITHUB_RUN_ATTEMPT=1 GITHUB_JOB=cleanup-test \
    bash "$ROOT/genie/ci-scripts/cleanup-effect-utils-composition.sh" 2>/dev/null; then
    echo 'FAIL: cleanup accepted non-reciprocal linked-worktree metadata' >&2
    return 1
  fi
  test -f "$workspace_root/sentinel"
  test -f "$member_root/README"
  git --git-dir="$repo_root/.bare" show-ref --verify --quiet \
    refs/heads/ci-77-1-cleanup-test
}

extract_devenv_scripts

run_test 'missing Buck directory fails and preserves old dist' test_missing_directory
run_test 'missing src/mod.d.ts fails and preserves old dist' test_missing_mod
run_test 'stale dist is atomically replaced by fresh bytes' test_replaces_stale_dist
run_test 'post-publish validation failure is nonzero and restores old dist' test_post_publish_validation_failure
run_test 'standalone fresh declarations pass without publication' test_standalone_freshness_passes
run_test 'standalone stale declarations fail without mutation' test_standalone_staleness_fails
run_test 'only reciprocal composed worktrees select parent publication' test_composed_worktree_selection
run_test 'cleanup refuses non-reciprocal worktree metadata without deletion' test_cleanup_refuses_nonreciprocal_worktree

echo "1..$test_count"
