#!/usr/bin/env bash
set -euo pipefail

# Behavioral coverage for the oxfmt adapter="none" wiring (roadmap Phase 0).
#
# The static/gating tests (otel-instr-gating.test.sh) prove the _otel_instr
# prelude toggles correctly, but they do NOT exercise the mkLintExec
# emptySelectionDiagnostic branch — the branch that runs the tool inside an
# xargs-spawned child shell, which a bash `_otel_instr` array cannot cross into.
# A naive wrap there would either error or silently run oxfmt bare. This test
# drives the REAL extracted `lint:check:format` exec end-to-end with stub
# otel-span / otel-scrape / oxfmt on PATH and asserts:
#
#   (A) gate ACTIVE  -> otel-scrape is actually invoked, wrapping the concrete
#       `oxfmt` binary as the child AFTER `--` (basename oxfmt, NOT the helper
#       shell), with `--adapter none`, and oxfmt still receives `--check <files>`.
#   (B) gate INACTIVE (no traceparent, binaries present) -> otel-scrape is NOT
#       invoked and oxfmt runs bare with `--check <files>`, i.e. the wrap is fully
#       disengaged and the non-instrumented path is unchanged.

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}
test_bash="${BASH_BIN:-$BASH}"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

echo "Running otel-scrape oxfmt wrap test..."

# --- stub binaries -----------------------------------------------------------
# oxfmt: records its argv so we can prove --check + files reach the real tool.
# The fake oxfmt "package" lives at $tmpdir (bin/oxfmt), passed to the module as
# oxfmtPkg so the exec embeds an absolute ${oxfmtPkg}/bin/oxfmt path.
mkdir -p "$tmpdir/bin" "$tmpdir/stubbin"
cat > "$tmpdir/bin/oxfmt" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >> "${TEST_OXFMT_ARGS:?}"
# Optional simulated outcome (default: success). TEST_OXFMT_STDERR is emitted to
# stderr and TEST_OXFMT_EXIT is the exit code, so cases can model oxfmt's real
# all-ignored (exit 2 + diagnostic), parse-error (exit 2), and diff (exit 1) paths.
if [ -n "${TEST_OXFMT_STDERR:-}" ]; then
  printf '%s\n' "$TEST_OXFMT_STDERR" >&2
fi
exit "${TEST_OXFMT_EXIT:-0}"
EOF
chmod +x "$tmpdir/bin/oxfmt"
export TEST_FAKE_OXFMT_PKG="$tmpdir"

# otel-span: task-level wrapper. Exec the wrapped command (everything after the
# first `--`) so the exec body actually runs; otherwise a no-op stub would hide
# whether oxfmt was reached at all.
cat > "$tmpdir/stubbin/otel-span" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
child=()
seen=0
for a in "$@"; do
  if [ "$seen" = 1 ]; then
    child+=("$a")
  elif [ "$a" = "--" ]; then
    seen=1
  fi
done
if [ "${#child[@]}" -gt 0 ]; then
  exec "${child[@]}"
fi
exit 0
EOF
chmod +x "$tmpdir/stubbin/otel-span"

# otel-scrape: command-level wrapper. Records its full argv (one arg per line) so
# we can prove it was invoked and that the child after `--` is oxfmt, then execs
# that child so oxfmt still runs. Appends (never pre-created) so the log's mere
# existence proves otel-scrape was reached.
cat > "$tmpdir/stubbin/otel-scrape" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for a in "$@"; do printf '%s\n' "$a" >> "${OTEL_SCRAPE_LOG:?}"; done
# Real otel-scrape prints its own note lines (e.g. an OTLP protocol note) to the
# child's stderr stream. Simulate that pollution so the swallow logic is exercised
# against wrapper stderr, not just the bare oxfmt diagnostic.
if [ -n "${TEST_SCRAPE_EXTRA_STDERR:-}" ]; then
  printf '%s\n' "$TEST_SCRAPE_EXTRA_STDERR" >&2
fi
child=()
seen=0
for a in "$@"; do
  if [ "$seen" = 1 ]; then
    child+=("$a")
  elif [ "$a" = "--" ]; then
    seen=1
  fi
done
[ "${#child[@]}" -gt 0 ] || { echo "otel-scrape stub: no child after --" >&2; exit 3; }
basename "${child[0]}" >> "${OTEL_SCRAPE_CHILD0:?}"
exec "${child[@]}"
EOF
chmod +x "$tmpdir/stubbin/otel-scrape"

# --- extract the real lint:check:format exec --------------------------------
extract_format_exec() {
  local output_path="$1"
  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      oxfmtPkg = builtins.getEnv \"TEST_FAKE_OXFMT_PKG\";
      # lint-oxc.nix requires an explicit packaged Genie product; the format exec
      # never touches it, so a stub keeps this test hermetic.
      geniePkg = pkgs.writeShellScriptBin \"genie\" \"exit 0\";
      evaluated = pkgs.lib.evalModules {
        modules = [
          ({ ... }: {
            options.tasks = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.processes = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.packages = pkgs.lib.mkOption { type = pkgs.lib.types.listOf pkgs.lib.types.anything; default = [ ]; };
          })
          ((import $ROOT/nix/devenv-modules/tasks/shared/lint-oxc.nix {
            lintPaths = [ \".\" ];
            geniePatterns = [ ];
            genieCoverageDirs = [ \".\" ];
            oxfmtPkg = oxfmtPkg;
            geniePkg = geniePkg;
          }) {
            pkgs = pkgs;
            lib = pkgs.lib;
            config = { };
          })
        ];
      };
    in evaluated.config.tasks.\"lint:check:format\".exec
  " > "$output_path"
  chmod +x "$output_path"
}

format_exec="$tmpdir/lint-check-format.sh"
extract_format_exec "$format_exec"

# The extracted exec must wrap oxfmt with the otel-scrape prefix ARRAY (not a
# nested sh that can't see it) — the load-bearing structural fix.
grep -qF '"${_otel_instr[@]}"' "$format_exec" \
  || fail "extracted lint:check:format exec should reference the outer _otel_instr array"
grep -qF -- '--adapter none' "$format_exec" \
  || fail "extracted lint:check:format exec should pass --adapter none (adapter=none prelude)"

# --- workspace with a single .ts file ---------------------------------------
workspace="$tmpdir/workspace"
mkdir -p "$workspace"
cat > "$workspace/keep.ts" <<'EOF'
export const keep = true
EOF
(
  cd "$workspace"
  git init --quiet
  git add keep.ts
)

VALID_TRACEPARENT="00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"

# ============================================================================
# (A) gate ACTIVE: valid traceparent + delivery available + binaries present.
# ============================================================================
echo "  case A: gate active -> otel-scrape wraps oxfmt"
scrape_log="$tmpdir/scrape-argv.log"
scrape_child0="$tmpdir/scrape-child0.log"
oxfmt_args_a="$tmpdir/oxfmt-args-a.txt"
: > "$oxfmt_args_a"

(
  cd "$workspace"
  env -i \
    PATH="$tmpdir/stubbin:$PATH" \
    HOME="$tmpdir" \
    OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4318" \
    OTEL_TASK_TRACEPARENT="$VALID_TRACEPARENT" \
    OTEL_SCRAPE_SUMMARY_DIR="$tmpdir/summaries" \
    OTEL_SPAN_BIN="$tmpdir/stubbin/otel-span" \
    OTEL_SCRAPE_BIN="$tmpdir/stubbin/otel-scrape" \
    OTEL_SCRAPE_LOG="$scrape_log" \
    OTEL_SCRAPE_CHILD0="$scrape_child0" \
    TEST_OXFMT_ARGS="$oxfmt_args_a" \
    "$test_bash" "$format_exec"
)

[ -s "$scrape_log" ] || fail "case A: otel-scrape was not invoked (empty/missing argv log — oxfmt ran bare)"
[ -f "$scrape_child0" ] || fail "case A: otel-scrape recorded no wrapped child"
child0="$(cat "$scrape_child0")"
[ "$child0" = "oxfmt" ] \
  || fail "case A: wrapped command span child should be 'oxfmt' (basename), got '$child0'"
scrape_argv="$(paste -sd' ' "$scrape_log")"
printf '%s' "$scrape_argv" | grep -qF -- '--adapter none' \
  || fail "case A: otel-scrape argv should contain '--adapter none', got: $scrape_argv"
grep -qFx -- '--check' "$oxfmt_args_a" \
  || fail "case A: oxfmt should still receive --check"
grep -qFx 'keep.ts' "$oxfmt_args_a" \
  || fail "case A: oxfmt should still receive the target file keep.ts"

# ============================================================================
# (B) gate INACTIVE: binaries present + delivery available but NO traceparent.
#     The command-level wrap must disengage (otelTraceContextActive false), so
#     oxfmt runs bare exactly as on the non-instrumented path.
# ============================================================================
echo "  case B: gate inactive (no traceparent) -> oxfmt runs bare"
scrape_log_b="$tmpdir/scrape-argv-b.log"
oxfmt_args_b="$tmpdir/oxfmt-args-b.txt"
: > "$oxfmt_args_b"

(
  cd "$workspace"
  env -i \
    PATH="$tmpdir/stubbin:$PATH" \
    HOME="$tmpdir" \
    OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4318" \
    OTEL_SCRAPE_SUMMARY_DIR="$tmpdir/summaries" \
    OTEL_SPAN_BIN="$tmpdir/stubbin/otel-span" \
    OTEL_SCRAPE_BIN="$tmpdir/stubbin/otel-scrape" \
    OTEL_SCRAPE_LOG="$scrape_log_b" \
    OTEL_SCRAPE_CHILD0="$tmpdir/scrape-child0-b.log" \
    TEST_OXFMT_ARGS="$oxfmt_args_b" \
    "$test_bash" "$format_exec"
)

[ ! -e "$scrape_log_b" ] \
  || fail "case B: otel-scrape must NOT be invoked without an active trace context"
grep -qFx -- '--check' "$oxfmt_args_b" \
  || fail "case B: bare oxfmt should still receive --check"
grep -qFx 'keep.ts' "$oxfmt_args_b" \
  || fail "case B: bare oxfmt should still receive the target file keep.ts"

# ============================================================================
# (C) REGRESSION: all-ignored batch (oxfmt exit 2 + empty-selection diagnostic)
#     under an ACTIVE gate where otel-scrape ALSO prints its own note line to the
#     shared stderr stream. The swallow keys on exit-code 2 AND the diagnostic
#     substring, so it must hold DESPITE the extra wrapper stderr. With the old
#     exact-string match this batch propagated exit 1 and failed the task.
# ============================================================================
echo "  case C: all-ignored + wrapper stderr -> swallowed (exit 0)"
run_format_gate_active() {
  # $1 = oxfmt exit, $2 = oxfmt stderr, $3 = extra otel-scrape stderr line
  local oxfmt_args
  oxfmt_args="$tmpdir/oxfmt-args-$$.txt"
  : > "$oxfmt_args"
  (
    cd "$workspace"
    env -i \
      PATH="$tmpdir/stubbin:$PATH" \
      HOME="$tmpdir" \
      OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4318" \
      OTEL_TASK_TRACEPARENT="$VALID_TRACEPARENT" \
      OTEL_SCRAPE_SUMMARY_DIR="$tmpdir/summaries" \
      OTEL_SPAN_BIN="$tmpdir/stubbin/otel-span" \
      OTEL_SCRAPE_BIN="$tmpdir/stubbin/otel-scrape" \
      OTEL_SCRAPE_LOG="$tmpdir/scrape-argv-c.log" \
      OTEL_SCRAPE_CHILD0="$tmpdir/scrape-child0-c.log" \
      TEST_OXFMT_ARGS="$oxfmt_args" \
      TEST_OXFMT_EXIT="$1" \
      TEST_OXFMT_STDERR="$2" \
      TEST_SCRAPE_EXTRA_STDERR="$3" \
      "$test_bash" "$format_exec"
  )
}

if run_format_gate_active \
  2 "Expected at least one target file. All matched files may have been excluded by ignore rules." \
  "otel-scrape: note: sending OTLP/HTTP JSON instead"; then
  : # swallow held despite wrapper stderr
else
  fail "case C: all-ignored batch (exit 2 + diagnostic) must be swallowed to exit 0 even with extra otel-scrape stderr"
fi

# ============================================================================
# (D) A real formatting diff (oxfmt exit 1) under the same active/polluted-stderr
#     conditions must STILL fail — the swallow only covers the all-ignored case.
# ============================================================================
echo "  case D: real formatting diff (exit 1) -> still fails"
if run_format_gate_active \
  1 "keep.ts (0ms)" \
  "otel-scrape: note: sending OTLP/HTTP JSON instead"; then
  fail "case D: a real formatting diff (oxfmt exit 1) must fail, not be swallowed"
fi

# ============================================================================
# (E) DISCRIMINATION: a genuine parse error also exits 2, but WITHOUT the
#     empty-selection diagnostic. The substring guard must keep it from being
#     swallowed even though it shares the all-ignored exit code.
# ============================================================================
echo "  case E: genuine parse error (exit 2, no diagnostic) -> still fails"
if run_format_gate_active \
  2 "Error occurred when checking code style in the above files." \
  "otel-scrape: note: sending OTLP/HTTP JSON instead"; then
  fail "case E: a genuine parse error (exit 2 without the empty-selection diagnostic) must fail, not be swallowed"
fi

echo ""
echo "otel-scrape oxfmt wrap test passed"
