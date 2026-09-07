#!/usr/bin/env bash
set -euo pipefail

# Nix-layer coverage for the SecretSpec task module (tasks/shared/secretspec.nix)
# after the clean break onto native SecretSpec 0.20. Proven WITHOUT a real
# provider, a real op-proxy, or any real secret: the module is evaluated against
# an overlay whose `secretspec` is a stub that records every invocation, so the
# argv the module produces IS the observable contract.
#
#   1. ONE RESOLUTION CALL: `secrets:prefetch` over a 3-profile manifest makes
#      exactly one `secretspec run -- true` call — one selected profile, no
#      per-secret and no per-profile fan-out.
#   2. VALUE-FREE CHECK: `secrets:check` is `check --explain` (never `run`,
#      never `--provider env`) and prints no value.
#   3. PROFILE FORWARDING: `secrets-run -P NAME` forwards the native flag
#      verbatim; with no flag the module injects none, so the native
#      SECRETSPEC_PROFILE channel decides. Same for --provider/--scope/--reason.
#   4. FILE PRECEDENCE: a caller's SECRETSPEC_FILE is never overridden; the repo
#      manifest is only a fallback default.
#   5. REASON: tasks default the reason through the native env channel, and a
#      caller-provided SECRETSPEC_REASON wins.
#   6. ERROR PROPAGATION: a failing resolution exits with the same code from
#      both `secrets-run` and the task exec.
#   7. NO LEGACY PATH: no gawk parser, no `[x-op-proxy.refs]`, no per-ref
#      `op-proxy read`, no provider-local `--cache`, no env skip/filter, no
#      exports, no env-provider handoff anywhere in the module or its scripts.
#   8. STANDALONE REPO: with no manifest both tasks are a clean no-op (exit 0,
#      zero resolution calls), which keeps repos without secrets working.

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"
MODULE="$ROOT/nix/devenv-modules/tasks/shared/secretspec.nix"

_pass=0
_fail=0
fail() {
  echo "FAIL: $1" >&2
  _fail=$((_fail + 1))
}
ok() {
  _pass=$((_pass + 1))
}

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

echo "Running secretspec-native-tasks test..."

# --- stub `secretspec`: records argv + the native env channels, then exits ---
cat > "$tmpdir/secretspec-stub.sh" <<'STUB'
: "${SECRETSPEC_STUB_CAPTURE:?stub needs SECRETSPEC_STUB_CAPTURE}"
{
  printf 'CALL'
  for arg in "$@"; do printf '\t%s' "$arg"; done
  printf '\n'
  printf 'ENV\tfile=%s\tprofile=%s\tprovider=%s\treason=%s\n' \
    "${SECRETSPEC_FILE:-}" "${SECRETSPEC_PROFILE:-}" "${SECRETSPEC_PROVIDER:-}" "${SECRETSPEC_REASON:-}"
} >> "$SECRETSPEC_STUB_CAPTURE"
exit "${SECRETSPEC_STUB_EXIT:-0}"
STUB

nix_expr_prelude="
  let
    flake = builtins.getFlake \"$NIX_FLAKE_REF\";
    pkgs = import flake.inputs.nixpkgs {
      system = builtins.currentSystem;
      overlays = [
        (final: prev: {
          secretspec = prev.writeShellScriptBin \"secretspec\" (builtins.readFile \"$tmpdir/secretspec-stub.sh\");
        })
      ];
    };
    mod = (import $MODULE { }) { lib = pkgs.lib; inherit pkgs; };
  in"

# `packages` is what devenv puts on PATH, so build exactly that.
nix build --impure --no-link --print-out-paths --expr "
  $nix_expr_prelude
  pkgs.symlinkJoin {
    name = \"secretspec-tasks-test-env\";
    paths = mod.packages;
  }
" > "$tmpdir/env-path" || {
  echo "FAIL: nix build of module packages" >&2
  exit 1
}
binDir="$(cat "$tmpdir/env-path")/bin"
[ -x "$binDir/secrets-run" ] || {
  echo "FAIL: secrets-run not built at $binDir" >&2
  exit 1
}
[ -x "$binDir/secretspec" ] || {
  echo "FAIL: module must ship the secretspec CLI in packages" >&2
  exit 1
}

task_exec() {
  nix eval --impure --raw --expr "
    $nix_expr_prelude
    mod.tasks.\"$1\".exec
  "
}
check_exec="$(task_exec secrets:check)"
prefetch_exec="$(task_exec secrets:prefetch)"

# --- a repo whose manifest declares three profiles ---
repo="$tmpdir/repo"
mkdir -p "$repo"
cat > "$repo/secretspec.toml" <<'TOML'
[project]
name = "secretspec-tasks-test"
revision = "1.0"

[profiles.default]
NOTION_TOKEN = { description = "notion", required = true }
AIRTABLE_API_KEY = { description = "airtable", required = true }

[profiles.deploy]
DEPLOY_TOKEN = { description = "deploy", required = true }

[profiles.signing]
SIGNING_KEY = { description = "signing", required = true }
TOML

empty="$tmpdir/empty-repo"
mkdir -p "$empty"

# run_case <capture> <cwd> <mode: run|exec> <payload...> ; extra env via ENV_ARGS
#
# PATH holds ONLY the module's own packages, so a task or wrapper that silently
# depends on an ambient tool (the old gawk/op-proxy path did) fails here.
bash_bin="${BASH_BIN:-$(command -v bash)}"
run_case() {
  local capture="$1" cwd="$2" mode="$3"
  shift 3
  : > "$capture"
  local rc=0
  if [ "$mode" = exec ]; then
    local body="$1"
    shift
    (
      cd "$cwd" && env -i PATH="$binDir" HOME="$tmpdir" \
        SECRETSPEC_STUB_CAPTURE="$capture" "${ENV_ARGS[@]}" \
        "$bash_bin" -c "$body"
    ) > "$capture.out" 2> "$capture.err" || rc=$?
  else
    (
      cd "$cwd" && env -i PATH="$binDir" HOME="$tmpdir" \
        SECRETSPEC_STUB_CAPTURE="$capture" "${ENV_ARGS[@]}" \
        secrets-run "$@"
    ) > "$capture.out" 2> "$capture.err" || rc=$?
  fi
  echo "$rc"
}

calls() { grep -c '^CALL' "$1" || true; }
argv() { sed -n 's/^CALL\t//p' "$1" | head -1; }
env_field() { sed -n "s/^ENV\t.*\b$2=\([^\t]*\).*/\1/p" "$1" | head -1; }

ENV_ARGS=()

# --- (1) ONE RESOLUTION CALL for one of three profiles ---
cap="$tmpdir/cap-prefetch"
ENV_ARGS=(SECRETSPEC_PROFILE=deploy)
rc="$(run_case "$cap" "$repo" exec "$prefetch_exec")"
[ "$rc" = 0 ] && ok || fail "secrets:prefetch exited $rc (stderr: $(cat "$cap.err"))"
[ "$(calls "$cap")" = 1 ] \
  && ok || fail "secrets:prefetch must make exactly ONE resolution call, made $(calls "$cap")"
[ "$(argv "$cap")" = "--file	secretspec.toml	run	--	true" ] \
  && ok || fail "secrets:prefetch argv should be '--file secretspec.toml run -- true', got '$(argv "$cap")'"
[ "$(env_field "$cap" profile)" = deploy ] \
  && ok || fail "secrets:prefetch must let the native SECRETSPEC_PROFILE channel select the profile"
printf '%s' "$prefetch_exec" | grep -qF -- "--profile" \
  && fail "secrets:prefetch must not inject its own --profile (native precedence owns it)" || ok
grep -q 'NOTION_TOKEN\|AIRTABLE_API_KEY\|SIGNING_KEY' "$cap" \
  && fail "secrets:prefetch must not name individual secrets or other profiles" || ok

# --- (1b) reason default flows through the native env channel ---
[ "$(env_field "$cap" reason)" = "devenv secrets:prefetch" ] \
  && ok || fail "secrets:prefetch should default SECRETSPEC_REASON, got '$(env_field "$cap" reason)'"
cap="$tmpdir/cap-prefetch-reason"
ENV_ARGS=(SECRETSPEC_REASON="caller owned reason")
rc="$(run_case "$cap" "$repo" exec "$prefetch_exec")"
[ "$rc" = 0 ] && [ "$(env_field "$cap" reason)" = "caller owned reason" ] \
  && ok || fail "a caller-provided SECRETSPEC_REASON must win, got '$(env_field "$cap" reason)'"

# --- (2) VALUE-FREE CHECK ---
cap="$tmpdir/cap-check"
ENV_ARGS=()
rc="$(run_case "$cap" "$repo" exec "$check_exec")"
[ "$rc" = 0 ] && ok || fail "secrets:check exited $rc (stderr: $(cat "$cap.err"))"
[ "$(calls "$cap")" = 1 ] \
  && ok || fail "secrets:check must make exactly one call, made $(calls "$cap")"
[ "$(argv "$cap")" = "--file	secretspec.toml	check	--explain" ] \
  && ok || fail "secrets:check argv should be '--file secretspec.toml check --explain', got '$(argv "$cap")'"
[ "$(env_field "$cap" reason)" = "devenv secrets:check" ] \
  && ok || fail "secrets:check should default SECRETSPEC_REASON, got '$(env_field "$cap" reason)'"

# --- (3) PROFILE / PROVIDER / REASON FORWARDING through secrets-run ---
cap="$tmpdir/cap-run-profile"
ENV_ARGS=()
rc="$(run_case "$cap" "$repo" run -P deploy --reason "run deploy" -- echo hi)"
[ "$rc" = 0 ] && ok || fail "secrets-run exited $rc (stderr: $(cat "$cap.err"))"
[ "$(calls "$cap")" = 1 ] \
  && ok || fail "secrets-run must make exactly one call, made $(calls "$cap")"
[ "$(argv "$cap")" = "run	-P	deploy	--reason	run deploy	--	echo	hi" ] \
  && ok || fail "secrets-run must forward native flags verbatim, got '$(argv "$cap")'"
[ "$(env_field "$cap" file)" = "secretspec.toml" ] \
  && ok || fail "secrets-run should default the manifest to the repo's, got '$(env_field "$cap" file)'"

cap="$tmpdir/cap-run-bare"
rc="$(run_case "$cap" "$repo" run -- true)"
[ "$rc" = 0 ] && [ "$(argv "$cap")" = "run	--	true" ] \
  && ok || fail "secrets-run with no flags must add none, got '$(argv "$cap")'"

cap="$tmpdir/cap-run-usage"
rc="$(run_case "$cap" "$repo" run)"
[ "$rc" = 2 ] && [ "$(calls "$cap")" = 0 ] \
  && ok || fail "secrets-run with no command must print usage and exit 2, got $rc"

# --- (4) FILE PRECEDENCE: caller's SECRETSPEC_FILE is never overridden ---
cap="$tmpdir/cap-run-file"
ENV_ARGS=(SECRETSPEC_FILE="$tmpdir/caller.toml")
rc="$(run_case "$cap" "$repo" run -- true)"
[ "$(env_field "$cap" file)" = "$tmpdir/caller.toml" ] \
  && ok || fail "secrets-run must not override a caller's SECRETSPEC_FILE, got '$(env_field "$cap" file)'"

# --- (6) ERROR PROPAGATION ---
cap="$tmpdir/cap-run-fail"
ENV_ARGS=(SECRETSPEC_STUB_EXIT=17)
rc="$(run_case "$cap" "$repo" run -- true)"
[ "$rc" = 17 ] && ok || fail "secrets-run must propagate the resolution exit code 17, got $rc"
cap="$tmpdir/cap-prefetch-fail"
rc="$(run_case "$cap" "$repo" exec "$prefetch_exec")"
[ "$rc" = 17 ] && ok || fail "secrets:prefetch must propagate the resolution exit code 17, got $rc"
cap="$tmpdir/cap-check-fail"
rc="$(run_case "$cap" "$repo" exec "$check_exec")"
[ "$rc" = 17 ] && ok || fail "secrets:check must propagate the check exit code 17, got $rc"
ENV_ARGS=()

# --- (7) NO LEGACY PATH (module source + built script + task execs) ---
legacy_pattern='gawk|x-op-proxy|op-proxy read|--cache|provider env|SECRETSPEC_STUB'
for subject in "$MODULE" "$binDir/secrets-run"; do
  if grep -Eq "$legacy_pattern" "$subject"; then
    fail "legacy secrets path still present in $subject: $(grep -Eo "$legacy_pattern" "$subject" | sort -u | tr '\n' ' ')"
  else
    ok
  fi
done
for body in "$check_exec" "$prefetch_exec"; do
  if printf '%s' "$body" | grep -Eq "$legacy_pattern"; then
    fail "legacy secrets path still present in a task exec"
  else
    ok
  fi
done
# no per-ref public read and no value handling: the module never exports a
# resolved value and never inspects the ambient environment for declared names.
grep -Eq 'export "[^"]*=\$|\$\{!' "$MODULE" \
  && fail "module must not export resolved values or indirect-expand env names" || ok
# the closure must not need gawk any more
nix path-info -r "$(cat "$tmpdir/env-path")" 2>/dev/null | grep -q -- '-gawk-' \
  && fail "secrets-run closure still contains gawk" || ok

# --- (8) STANDALONE REPO: no manifest -> clean no-op ---
for pair in "check:$check_exec" "prefetch:$prefetch_exec"; do
  name="${pair%%:*}"
  body="${pair#*:}"
  cap="$tmpdir/cap-empty-$name"
  rc="$(run_case "$cap" "$empty" exec "$body")"
  [ "$rc" = 0 ] && [ "$(calls "$cap")" = 0 ] \
    && ok || fail "secrets:$name without a manifest must no-op (exit 0, no calls), got $rc/$(calls "$cap")"
  grep -q "No secretspec.toml" "$cap.out" \
    && ok || fail "secrets:$name without a manifest should say so, got '$(cat "$cap.out")'"
done

echo ""
echo "$_pass passed, $_fail failed"
[ "$_fail" -eq 0 ] && echo "secretspec-native-tasks test passed"
[ "$_fail" -eq 0 ]
