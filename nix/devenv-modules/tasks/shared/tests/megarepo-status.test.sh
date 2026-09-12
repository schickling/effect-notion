#!/usr/bin/env bash
# Tests for megarepo task output checks.
#
# Warm shell setup may skip expensive task execution, but task status still has
# to validate the current workspace outputs against the current megarepo config.
set -euo pipefail

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
  echo "  ok: $label"
}

check_workspace_members() {
  set -o pipefail
  workspace_root="$(mr root --output json | jq -er '.root')"
  [ -d "$workspace_root/repos" ] || exit 1

  _mr_skip_csv="${MEGAREPO_SKIP_MEMBERS:-}"

  should_skip_member() {
    local member="$1"
    if [ -z "$_mr_skip_csv" ]; then
      return 1
    fi

    case ",$_mr_skip_csv," in
      *,"$member",*) return 0 ;;
      *) return 1 ;;
    esac
  }

  members=$(mr ls --output json | jq -r '
    select(._tag == "Success")
    | (.members // .value.members // .value.value.members // [])
    | .[].name
  ') || exit 1

  for member in $members; do
    if should_skip_member "$member"; then
      continue
    fi
    if [ ! -L "$workspace_root/repos/$member" ] && [ ! -d "$workspace_root/repos/$member" ]; then
      exit 1
    fi
  done
}

run_check() {
  (
    cd "${TASK_CWD:-$workspace}"
    check_workspace_members
  )
}

run_status_check() {
  (
    cd "${TASK_CWD:-$workspace}"
    check_workspace_members
    status_json=$(mr status --output json 2>/dev/null) || exit 1
    echo "$status_json" \
      | jq -e '(.syncNeeded // false) == false and (.applyNeeded // false) == false' \
      >/dev/null 2>&1
  )
}

echo "Running megarepo status tests..."
echo ""

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

workspace="$tmpdir/workspace"
mkdir -p "$workspace/repos/one" "$workspace/.devenv/task-cache/mr-apply" "$tmpdir/bin"
touch "$workspace/megarepo.kdl"

cat > "$tmpdir/bin/mr" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [ "$1" = "root" ] && [ "$2" = "--output" ] && [ "$3" = "json" ]; then
  printf '{"_tag":"Success","root":"%s"}\n' "${MR_ROOT:?MR_ROOT not set}"
  exit 0
fi
if [ "$1" = "ls" ] && [ "$2" = "--output" ] && [ "$3" = "json" ]; then
  cat <<'JSON'
{
  "_tag": "Success",
  "members": [
    { "name": "one" },
    { "name": "two" }
  ]
}
JSON
  exit 0
fi

if [ "$1" = "status" ] && [ "$2" = "--output" ] && [ "$3" = "json" ]; then
  if [ -n "${MR_STATUS_JSON:-}" ]; then
    printf '%s\n' "$MR_STATUS_JSON"
  else
    cat <<'JSON'
{"syncNeeded":false,"applyNeeded":false}
JSON
  fi
  exit 0
fi

echo "unexpected mr invocation: $*" >&2
exit 2
EOF
chmod +x "$tmpdir/bin/mr"
export PATH="$tmpdir/bin:$PATH"
export MR_ROOT="$workspace"

echo "Test 1: missing configured member fails even with stale cached manifest"
printf 'one\n' > "$workspace/.devenv/task-cache/mr-apply/members.txt"
set +e
run_check
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "current mr ls output is authoritative"

echo ""
echo "Test 2: materialized configured members pass"
mkdir -p "$workspace/repos/two"
set +e
run_check
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "all current members materialized"

echo ""
echo "Test 3: explicit skip allows intentionally omitted member"
rm -rf "$workspace/repos/two"
set +e
MEGAREPO_SKIP_MEMBERS=two run_check
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "skipped member is ignored"

echo ""
echo "Test 4: status check re-runs when apply or sync is needed"
mkdir -p "$workspace/repos/two"
export MR_STATUS_JSON='{"syncNeeded":false,"applyNeeded":false}'
set +e
run_status_check
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "clean status is cacheable"

export MR_STATUS_JSON='{"syncNeeded":true,"applyNeeded":false}'
set +e
run_status_check
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "syncNeeded invalidates cache"

export MR_STATUS_JSON='{"syncNeeded":false,"applyNeeded":true}'
set +e
run_status_check
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "applyNeeded invalidates cache"
unset MR_STATUS_JSON

echo ""
echo "Test 5: member-root checks resolve the synthesized workspace"
set +e
TASK_CWD="$workspace/repos/one" run_check
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "owned member cwd checks workspace repos"

echo ""
echo "Test 6: shared module points setup checks at mr:setup"
module_file="$(cd "$(dirname "$0")/.." && pwd)/megarepo.nix"
if ! grep -F 'after = [ "mr:setup" ];' "$module_file" >/dev/null; then
  echo "FAIL: mr:check should depend on mr:setup"
  exit 1
fi
if grep -F '[devenv] Fix: devenv tasks run mr:apply' "$module_file" >/dev/null; then
  echo "FAIL: setup repair hint should not point at mr:apply"
  exit 1
fi
if ! grep -F '[devenv] Fix: devenv tasks run mr:setup' "$module_file" >/dev/null; then
  echo "FAIL: setup repair hint should point at mr:setup"
  exit 1
fi
echo "  ok: setup task is the canonical setup dependency"

echo ""
echo "Test 7: shared mutation tasks select worktree strategies explicitly"
for command in \
  'mr apply --worktree-mode commit' \
  'mr apply --worktree-mode tracking --lock-sync off' \
  'mr fetch --apply --worktree-mode tracking' \
  'mr apply --worktree-mode tracking${if syncAll'
do
  if ! grep -F "$command" "$module_file" >/dev/null; then
    echo "FAIL: shared task does not select an explicit worktree strategy: $command"
    exit 1
  fi
done
echo "  ok: shared mutation tasks select explicit worktree strategies"

echo ""
echo "Test 8: source-mode mr receives the canonical composition runtime"
devenv_file="$(cd "$(dirname "$module_file")/../../../.." && pwd)/devenv.nix"
for runtime_name in \
  MR_COMPOSITION_CP_BIN \
  MR_COMPOSITION_BUCK2_BIN \
  MR_COMPOSITION_BUCK2_PROTOCOL \
  MR_COMPOSITION_SYSTEM \
  MR_COMPOSITION_PLATFORM \
  MR_COMPOSITION_GIT_BIN \
  MR_COMPOSITION_WATCHMAN_BIN \
  MR_CAPABILITY_NIX_BIN \
  MR_CAPABILITY_MV_BIN
do
  if ! grep -F "env.$runtime_name =" "$devenv_file" >/dev/null; then
    echo "FAIL: source-mode mr is missing $runtime_name"
    exit 1
  fi
done
echo "  ok: source-mode mr receives the canonical composition runtime"

echo ""
echo "Test 9: shared mutation tasks preserve mr failures"
for task in mr:setup mr:fetch-apply mr:apply
do
  task_block="$(sed -n "/\"$task\" = {/,/status =/p" "$module_file")"
  if ! grep -F 'set -euo pipefail' <<< "$task_block" >/dev/null; then
    echo "FAIL: $task can mask a failed mr command"
    exit 1
  fi
done
echo "  ok: shared mutation tasks stop after a failed mr command"

echo ""
echo "All megarepo status tests passed"
