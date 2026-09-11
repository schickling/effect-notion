#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"
MATERIALIZER="$ROOT/scripts/typescript-materialize-dist.sh"
PACKAGE_PATH="packages/@overeng/tui-core"
TARGET="effect_utils//packages/@overeng/tui-core:dist"
DECLARATION_ENTRYPOINT="src/mod.d.ts"
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
  if FAKE_BUCK_SCENARIO=missing-directory WORKSPACE_ROOT="$repo" \
    BUCK2_BIN="$repo/bin/buck2" \
    bash "$MATERIALIZER" "$repo" "$PACKAGE_PATH" "$TARGET" "$DECLARATION_ENTRYPOINT"; then
    echo "FAIL: missing Buck output directory was accepted" >&2
    return 1
  fi
  assert_old_dist "$repo"
  assert_no_staging "$repo"
}

test_missing_mod() {
  repo="$TEST_ROOT/missing-mod"
  make_repo "$repo"
  if FAKE_BUCK_SCENARIO=missing-mod WORKSPACE_ROOT="$repo" \
    BUCK2_BIN="$repo/bin/buck2" \
    bash "$MATERIALIZER" "$repo" "$PACKAGE_PATH" "$TARGET" "$DECLARATION_ENTRYPOINT"; then
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
    FAKE_BUCK_LOG="$repo/buck-args" WORKSPACE_ROOT="$repo" \
    BUCK2_BIN="$repo/bin/buck2" \
    bash "$MATERIALIZER" "$repo" "$PACKAGE_PATH" "$TARGET" "$DECLARATION_ENTRYPOINT"
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
    FAKE_BUCK_SCENARIO=success WORKSPACE_ROOT="$repo" \
    BUCK2_BIN="$repo/bin/buck2" \
    bash "$MATERIALIZER" "$repo" "$PACKAGE_PATH" "$TARGET" "$DECLARATION_ENTRYPOINT"; then
    echo "FAIL: post-publish validation failure returned success" >&2
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
      inputs = { };
      config = { };
    };
  in {
    materializeTask = pkgs.writeShellScript "test-materialize-task"
      module.tasks."buck2:typescript:materialize-dist".exec;
  }'
  cp "$(nix build --no-link --print-out-paths --impure --expr "$nix_expr.materializeTask")" \
    "$TEST_ROOT/materialize-task.sh"
  chmod +x "$TEST_ROOT/materialize-task.sh"
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
  process.env.WORKSPACE_ROOT ?? '',
  process.env.BUCK2_BIN ?? '',
].join('|'))
PROBE
}

test_composed_worktree_selection() {
  local standalone seed repo_root workspace_root member_root mode admin_dir status output
  standalone="$TEST_ROOT/lookalike/repos/effect-utils"
  mkdir -p "$(dirname "$standalone")"
  make_git_commit "$standalone"
  make_runtime_probe "$standalone"
  set +e
  output="$(DEVENV_ROOT="$standalone" bash "$TEST_ROOT/materialize-task.sh" 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || {
    echo "FAIL: standalone lookalike was allowed to publish declarations" >&2
    return 1
  }
  case "$output" in
    *"requires a composed megarepo workspace"*) ;;
    *) echo "FAIL: standalone refusal was not actionable: $output" >&2; return 1 ;;
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
  mode="$(DEVENV_ROOT="$member_root" bash "$TEST_ROOT/materialize-task.sh")"
  expected_mode="$workspace_root|$workspace_root/.megarepo/bin/buck2"
  if [ "$mode" != "$expected_mode" ]; then
    echo "FAIL: composed materializer mode: expected '$expected_mode', got '$mode'" >&2
    return 1
  fi

  admin_dir="$(git -C "$member_root" rev-parse --path-format=absolute --git-dir)"
  mkdir -p "$TEST_ROOT/foreign"
  printf 'gitdir: nowhere\n' > "$TEST_ROOT/foreign/.git"
  printf '%s\n' "$TEST_ROOT/foreign/.git" > "$admin_dir/gitdir"
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

run_test 'missing Buck directory fails and preserves old dist' test_missing_directory
run_test 'missing src/mod.d.ts fails and preserves old dist' test_missing_mod
run_test 'stale dist is atomically replaced by fresh bytes' test_replaces_stale_dist
run_test 'post-publish validation failure is nonzero and restores old dist' test_post_publish_validation_failure
extract_devenv_scripts
run_test 'only reciprocal composed worktrees select parent publication' test_composed_worktree_selection
run_test 'cleanup refuses non-reciprocal worktree metadata without deletion' test_cleanup_refuses_nonreciprocal_worktree

echo "1..$test_count"
