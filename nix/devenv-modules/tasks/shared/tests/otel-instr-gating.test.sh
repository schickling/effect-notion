#!/usr/bin/env bash
set -euo pipefail

# Nix-layer coverage for the trace.instr command-level instrumentation gating
# (decision 0018 + the M25.2 gating-unification fix). Two things are proven:
#
#   1. GATING (trace.instr prelude): the _otel_instr / _otel_instr_flags arrays
#      that oxlint/vitest wrap themselves with are EMPTY unless an OTEL task trace
#      context is active AND otel-scrape is present AND instrumentation is enabled — the same
#      gate tsc uses (otelTraceContextActive). A non-interactive run (no traceparent)
#      keeps the command bare even when the binaries are on PATH, so oxlint's stdout
#      is never silently swapped for --format=json.
#
#   2. WIRING (static): the real lint:check:oxlint task exec actually consumes the
#      arrays — it embeds `"${_otel_instr[@]}" oxlint` and the --format=json child
#      flag — so the gating above is not dead code.
#
# Fully hermetic: a stub otel-scrape / otel-span on PATH, so the arrays are toggled
# ONLY by the env triggers under test (binaries stay present in every case).

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

test_bash="${BASH_BIN:-$BASH}"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

echo "Running otel-instr gating test..."
# Use exact fixture paths so shell startup behavior cannot replace the test's
# hermetic binaries through PATH initialization. The arrays must then be
# governed only by the environment triggers under test.
stubbin="$tmpdir/stubbin"
mkdir -p "$stubbin"
for tool in otel-scrape otel-span; do
  cat > "$stubbin/$tool" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$stubbin/$tool"
done

# A well-formed W3C traceparent (00-<32 hex>-<16 hex>-<2 hex>).
VALID_TRACEPARENT="00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"

eval_instr_prelude() {
  # $1 = adapter
  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      trace = import $ROOT/nix/devenv-modules/tasks/lib/trace.nix { lib = pkgs.lib; };
    in trace.instr { adapter = \"$1\"; name = \"lint:check:oxlint\"; }
  "
}

oxlint_prelude="$tmpdir/prelude-oxlint.sh"
vitest_prelude="$tmpdir/prelude-vitest.sh"
eval_instr_prelude oxlint > "$oxlint_prelude"
eval_instr_prelude vitest > "$vitest_prelude"

# Task-level wrappers must honor the module-pinned bridge even when no
# `otel-span` command is available through PATH. This models nested devenv task
# evaluation, which may reconstruct PATH independently of its parent process.
task_exec="$tmpdir/task-exec.sh"
nix eval --impure --raw --expr "
  let
    flake = builtins.getFlake \"$NIX_FLAKE_REF\";
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    trace = import $ROOT/nix/devenv-modules/tasks/lib/trace.nix { lib = pkgs.lib; };
  in trace.exec \"test:task\" \"exit 0\"
" > "$task_exec"

custom_otel_span="$tmpdir/custom-otel-span"
cat > "$custom_otel_span" <<'EOF'
#!/usr/bin/env bash
printf 'endpoint=%s\nargs=%s\n' "$OTEL_EXPORTER_OTLP_ENDPOINT" "$*" > "$OTEL_TEST_MARKER"
EOF
chmod +x "$custom_otel_span"

marker="$tmpdir/task-bridge-marker"
env -i \
  PATH="$(dirname "$BASH")" \
  OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
  OTELITE_HTTP_ENDPOINT=http://127.0.0.1:9876 \
  OTEL_SPAN_BIN="$custom_otel_span" \
  OTEL_TEST_MARKER="$marker" \
  "$BASH" "$task_exec"
grep -q '^endpoint=http://127.0.0.1:9876$' "$marker" \
  || fail "task/capture-endpoint: trace.exec should prefer the invocation-scoped otelite endpoint"
grep -q '^args=run effect-utils-devenv devenv.task.exec ' "$marker" \
  || fail "task/pinned-bridge: trace.exec should invoke OTEL_SPAN_BIN outside PATH"

# Common env for the "binaries present + delivery available" baseline. Each case
# below overrides exactly one trigger.
base_env=(
  "PATH=$stubbin:$PATH"
  "OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318"
  "OTEL_SCRAPE_SUMMARY_DIR=$tmpdir/summaries"
  "OTEL_SPAN_BIN=$stubbin/otel-span"
  "OTEL_SCRAPE_BIN=$stubbin/otel-scrape"
)

assert_bare() {
  # $1 = label, $2 = prelude captured output
  local label="$1" out="$2"
  local ic fc
  ic="$(printf '%s\n' "$out" | sed -n 's/^INSTR_COUNT=//p')"
  fc="$(printf '%s\n' "$out" | sed -n 's/^FLAGS_COUNT=//p')"
  [ "$ic" = "0" ] || fail "$label: expected _otel_instr empty (bare command), got count=$ic"
  [ "$fc" = "0" ] || fail "$label: expected _otel_instr_flags empty, got count=$fc"
}

# --- (a) NO wrap: delivery available but NO traceparent (the gating-unification fix) ---
# `env -i` starts from an empty environment, so no traceparent is present.
out="$(env -i "${base_env[@]}" HOME="$tmpdir" \
  "$test_bash" -c 'source "$1"; printf "INSTR_COUNT=%s\nFLAGS_COUNT=%s\n" "${#_otel_instr[@]}" "${#_otel_instr_flags[@]}"' _ "$oxlint_prelude")"
assert_bare "oxlint/no-trace-context" "$out"

# --- (a) NO wrap: OTEL_SCRAPE_ENABLED=0 ---
out="$(env -i "${base_env[@]}" HOME="$tmpdir" OTEL_TASK_TRACEPARENT="$VALID_TRACEPARENT" OTEL_SCRAPE_ENABLED=0 \
  "$test_bash" -c 'source "$1"; printf "INSTR_COUNT=%s\nFLAGS_COUNT=%s\n" "${#_otel_instr[@]}" "${#_otel_instr_flags[@]}"' _ "$oxlint_prelude")"
assert_bare "oxlint/instrumentation-disabled" "$out"

# --- (a) NO wrap: otel-scrape absent (override to a nonexistent bin) ---
out="$(env -i "${base_env[@]}" HOME="$tmpdir" OTEL_TASK_TRACEPARENT="$VALID_TRACEPARENT" OTEL_SCRAPE_BIN="$tmpdir/no-such-otel-scrape" \
  "$test_bash" -c 'source "$1"; printf "INSTR_COUNT=%s\nFLAGS_COUNT=%s\n" "${#_otel_instr[@]}" "${#_otel_instr_flags[@]}"' _ "$oxlint_prelude")"
assert_bare "oxlint/scrape-absent" "$out"

# --- (b) WRAP: binaries present + valid trace context + instrumentation enabled ---
out="$(env -i "${base_env[@]}" HOME="$tmpdir" OTEL_TASK_TRACEPARENT="$VALID_TRACEPARENT" \
  "$test_bash" -c 'source "$1"; printf "INSTR_COUNT=%s\nFLAGS_COUNT=%s\nINSTR=%s\nFLAGS=%s\n" "${#_otel_instr[@]}" "${#_otel_instr_flags[@]}" "${_otel_instr[*]-}" "${_otel_instr_flags[*]-}"' _ "$oxlint_prelude")"
ic="$(printf '%s\n' "$out" | sed -n 's/^INSTR_COUNT=//p')"
[ "$ic" -gt 0 ] || fail "oxlint/active: expected non-empty _otel_instr (otel-scrape wrap), got count=$ic"
printf '%s\n' "$out" | grep -q "^INSTR=$stubbin/otel-scrape " \
  || fail "oxlint/active: _otel_instr should start with the exact fixture otel-scrape wrapper"
printf '%s\n' "$out" | grep -q -- "--adapter oxlint" \
  || fail "oxlint/active: _otel_instr should pass --adapter oxlint"
printf '%s\n' "$out" | grep -q "^FLAGS=--format=json$" \
  || fail "oxlint/active: _otel_instr_flags should be exactly --format=json (needs-render child flag)"

# --- (b') vitest adapter: wraps when active, but injects NO --format=json child flag ---
out="$(env -i "${base_env[@]}" HOME="$tmpdir" OTEL_TASK_TRACEPARENT="$VALID_TRACEPARENT" \
  "$test_bash" -c 'source "$1"; printf "INSTR_COUNT=%s\nFLAGS_COUNT=%s\nINSTR=%s\n" "${#_otel_instr[@]}" "${#_otel_instr_flags[@]}" "${_otel_instr[*]-}"' _ "$vitest_prelude")"
ic="$(printf '%s\n' "$out" | sed -n 's/^INSTR_COUNT=//p')"
fc="$(printf '%s\n' "$out" | sed -n 's/^FLAGS_COUNT=//p')"
[ "$ic" -gt 0 ] || fail "vitest/active: expected non-empty _otel_instr, got count=$ic"
[ "$fc" = "0" ] || fail "vitest/active: expected NO child flags (side-channel adapter), got count=$fc"
printf '%s\n' "$out" | grep -q -- "--adapter vitest" \
  || fail "vitest/active: _otel_instr should pass --adapter vitest"

# --- WIRING: the real oxlint task exec consumes the arrays + the --format=json flag ---
oxlint_exec="$(nix eval --impure --raw --expr "
  let
    flake = builtins.getFlake \"$NIX_FLAKE_REF\";
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    mod = (import $ROOT/nix/devenv-modules/tasks/shared/lint-oxc.nix {
      geniePatterns = [ \"packages/*/*.genie.ts\" ];
      genieCoverageDirs = [ \"packages\" ];
      # lint-oxc.nix requires an explicit packaged Genie product; the oxlint exec
      # under test never runs it, so a stub keeps this eval hermetic.
      geniePkg = pkgs.writeShellScriptBin \"genie\" \"exit 0\";
    }) { lib = pkgs.lib; pkgs = pkgs; config = { }; };
  in mod.tasks.\"lint:check:oxlint\".exec
")"
printf '%s' "$oxlint_exec" | grep -qF '"${_otel_instr[@]}" oxlint' \
  || fail 'lint:check:oxlint exec should wrap oxlint with the "${_otel_instr[@]}" array'
printf '%s' "$oxlint_exec" | grep -qF '"${_otel_instr_flags[@]}"' \
  || fail 'lint:check:oxlint exec should pass the "${_otel_instr_flags[@]}" array to oxlint'
printf '%s' "$oxlint_exec" | grep -qF -- '--format=json' \
  || fail 'lint:check:oxlint exec should embed the gated --format=json child flag (via the trace.instr prelude)'

echo ""
echo "otel-instr gating test passed"
