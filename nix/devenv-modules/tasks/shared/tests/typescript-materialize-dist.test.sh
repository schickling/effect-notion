#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"
MATERIALIZER="$ROOT/scripts/typescript-materialize-dist.sh"
PACKAGE_PATH="packages/@overeng/tui-core"
TARGET="effect_utils//packages/@overeng/tui-core:dist"
DECLARATION_ENTRYPOINT="src/mod.d.ts"
PROJECT="tsconfig.json"
REAL_MV="$(command -v mv)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

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
  if FAKE_BUCK_SCENARIO=missing-directory \
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
  if FAKE_BUCK_SCENARIO=missing-mod \
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
    FAKE_BUCK_LOG="$repo/buck-args" \
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
    FAKE_BUCK_SCENARIO=success \
    WORKSPACE_ROOT="$repo" BUCK2_BIN="$repo/bin/buck2" \
    bash "$MATERIALIZER" "$repo" "$PACKAGE_PATH" "$TARGET" "$DECLARATION_ENTRYPOINT" "$PROJECT"; then
    echo "FAIL: post-publish validation failure returned success" >&2
    return 1
  fi
  assert_old_dist "$repo"
  assert_no_staging "$repo"
}

run_test 'missing Buck directory fails and preserves old dist' test_missing_directory
run_test 'missing src/mod.d.ts fails and preserves old dist' test_missing_mod
run_test 'stale dist is atomically replaced by fresh bytes' test_replaces_stale_dist
run_test 'post-publish validation failure is nonzero and restores old dist' test_post_publish_validation_failure

echo "1..$test_count"
