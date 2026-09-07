#!/usr/bin/env bash
set -euo pipefail

# Validates the ts:check OTEL diagnostics parser against real tsgo
# `--build --extendedDiagnostics --verbose` output (captured fixture).
#
# It extracts the actual ts:check exec script from ts.nix via `nix eval`, runs
# it with stub `tsgo`/`otel-span` binaries, and asserts that:
#   - one child span per built project is emitted with correct per-project timing
#   - tsgo's aggregate build summary is emitted as a single build-level span and
#     is NOT mis-attributed to the last project
#   - tsgo's Effect lint warnings are re-surfaced to the user (not swallowed)

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"
FIXTURE="$TESTS_DIR/fixtures/tsgo-extended-diagnostics.txt"

fail() {
  echo "FAIL: $1"
  exit 1
}

echo "Running ts diagnostics parser test..."
echo ""

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
mkdir -p "$tmpdir/bin"

# Extract the real ts:check exec script so we test the shipped parser, not a copy.
if ! nix eval --impure --raw --expr "
  let
    flake = builtins.getFlake \"$NIX_FLAKE_REF\";
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    evaluated = pkgs.lib.evalModules {
      modules = [
        ({ ... }: {
          options.tasks = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
          options.processes = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
          options.packages = pkgs.lib.mkOption { type = pkgs.lib.types.listOf pkgs.lib.types.anything; default = [ ]; };
        })
        ((import $ROOT/nix/devenv-modules/tasks/shared/ts.nix {
          tsconfigFile = \"tsconfig.check.json\";
        }) {
          pkgs = pkgs;
          lib = pkgs.lib;
          config = { };
        })
      ];
    };
  in evaluated.config.tasks.\"ts:check\".exec
" > "$tmpdir/ts-check.exec.sh" 2> "$tmpdir/nix-eval.err"; then
  echo "---- nix eval stderr ----" >&2
  cat "$tmpdir/nix-eval.err" >&2
  echo "---- end nix eval stderr ----" >&2
  fail "nix eval of the ts:check exec failed"
fi
chmod +x "$tmpdir/ts-check.exec.sh"

# Stub tsgo: ignore args, emit the captured diagnostics fixture, exit 0.
cat > "$tmpdir/bin/tsgo" <<EOF
#!/usr/bin/env bash
cat "$FIXTURE"
exit 0
EOF
chmod +x "$tmpdir/bin/tsgo"

# Stub otel-span: two call shapes.
#   "otel-span run <svc> <name> ... -- <cmd...>" must exec the wrapped command.
#   "otel-span emit-span" records the typed measurement span arguments as
#   OTLP-shaped JSON so this test validates the parser's shipped call contract.
cat > "$tmpdir/bin/otel-span" <<EOF
#!/usr/bin/env bash
append_attr() {
  local key="\$1"
  local value_json="\$2"
  if [ -n "\$attrs" ]; then attrs="\$attrs,"; fi
  attrs="\$attrs"{\\"key\\":\\"\$key\\",\\"value\\":\$value_json}
}

if [ "\${1:-}" = "emit-span" ]; then
  shift
  service="\$1"
  name="\$2"
  shift 2
  trace_id=""
  span_id=""
  parent_span_id=""
  start_ns=""
  end_ns=""
  attrs=""
  while [ "\$#" -gt 0 ]; do
    case "\$1" in
      --scope-name) shift 2 ;;
      --trace-id) trace_id="\$2"; shift 2 ;;
      --span-id) span_id="\$2"; shift 2 ;;
      --parent-span-id) parent_span_id="\$2"; shift 2 ;;
      --start-time-ns) start_ns="\$2"; shift 2 ;;
      --end-time-ns) end_ns="\$2"; shift 2 ;;
      --attr-string)
        key="\${2%%=*}"
        value="\${2#*=}"
        append_attr "\$key" "{\\"stringValue\\":\\"\$value\\"}"
        shift 2
        ;;
      --attr-double)
        key="\${2%%=*}"
        value="\${2#*=}"
        append_attr "\$key" "{\\"doubleValue\\":\$value}"
        shift 2
        ;;
      --attr-int)
        key="\${2%%=*}"
        value="\${2#*=}"
        append_attr "\$key" "{\\"intValue\\":\\"\$value\\"}"
        shift 2
        ;;
      --attr-bool)
        key="\${2%%=*}"
        value="\${2#*=}"
        append_attr "\$key" "{\\"boolValue\\":\$value}"
        shift 2
        ;;
      *)
        echo "unexpected emit-span arg: \$1" >&2
        exit 1
        ;;
    esac
  done
  printf '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"%s"}}]},"scopeSpans":[{"spans":[{"traceId":"%s","spanId":"%s","parentSpanId":"%s","name":"%s","startTimeUnixNano":"%s","endTimeUnixNano":"%s","attributes":[%s],"status":{"code":1}}]}]}]}\n' \
    "\$service" "\$trace_id" "\$span_id" "\$parent_span_id" "\$name" "\$start_ns" "\$end_ns" "\$attrs" >> "$tmpdir/spans.ndjson"
  printf '\n---SPAN-SEPARATOR---\n' >> "$tmpdir/spans.ndjson"
  exit 0
fi
if [ "\${1:-}" = "run" ]; then
  shift
  # Drop everything up to and including the "--" separator, then exec the rest.
  while [ "\$#" -gt 0 ] && [ "\$1" != "--" ]; do shift; done
  [ "\${1:-}" = "--" ] && shift
  exec "\$@"
fi
exit 0
EOF
chmod +x "$tmpdir/bin/otel-span"

# Stub otel-scrape: the command-level wrapper trace.instr composes around the
# compiler. Records nothing, execs the child after `--`, so the wrap shape is
# preserved while the compiler stream stays exactly the fixture bytes.
cat > "$tmpdir/bin/otel-scrape" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
[ "${1:-}" = "--" ] && shift
exec "$@"
EOF
chmod +x "$tmpdir/bin/otel-scrape"

export PATH="$tmpdir/bin:$PATH"
# The devenv environment pins the real otel-span bridge through OTEL_SPAN_BIN
# (nix/devenv-modules/observability.nix), which bypasses a PATH-only stub;
# otel-scrape resolves through OTEL_SCRAPE_BIN or ambient PATH (see
# nix/devenv-modules/lib/trace.nix). Pin both to this test's stubs so the parser
# is exercised against the shipped call contract and nothing ambient is reached.
export OTEL_SPAN_BIN="$tmpdir/bin/otel-span"
export OTEL_SCRAPE_BIN="$tmpdir/bin/otel-scrape"
export OTEL_EXPORTER_OTLP_ENDPOINT=
export OTELITE_HTTP_ENDPOINT=
export OTEL_SPAN_SPOOL_DIR="$tmpdir/spool"
mkdir -p "$OTEL_SPAN_SPOOL_DIR"
export OTEL_SCRAPE_SUMMARY_DIR="$tmpdir/scrape-summaries"
export OTEL_TASK_TRACEPARENT="00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
export DEVENV_ROOT="$tmpdir/workspace"
mkdir -p "$DEVENV_ROOT"
: > "$tmpdir/spans.ndjson"

# Capture the exec's status explicitly: a bare command substitution under
# `set -e` would kill this test with the compiler/parser stream still trapped
# inside the unassigned variable, leaving no diagnostic at all.
exec_exit=0
stdout="$(cd "$tmpdir" && bash "$tmpdir/ts-check.exec.sh" 2>&1)" || exec_exit=$?
echo "$stdout" > "$tmpdir/stdout.txt"
if [ "$exec_exit" -ne 0 ]; then
  echo "---- ts:check exec output (exit=$exec_exit) ----" >&2
  cat "$tmpdir/stdout.txt" >&2
  echo "---- end ts:check exec output ----" >&2
  fail "extracted ts:check exec exited $exec_exit (stub tsgo exits 0, so it must exit 0)"
fi

# 1. Effect lint warnings must be re-surfaced (not swallowed by the parser path).
grep -q "warning TS377030" "$tmpdir/stdout.txt" \
  || fail "tsgo Effect lint warning was not surfaced to the user"

# 2. Diagnostics scaffolding must be stripped from user output.
if grep -qE "^([[:space:]]*\* .*tsconfig\.json|Building project |Project .* is being forcibly rebuilt|Projects in this build:|Files:|Parse time:|Total time:|Aggregate)" "$tmpdir/stdout.txt"; then
  fail "diagnostics scaffolding leaked into user output"
fi

# Helper: extract a numeric attribute value from a span JSON block.
attr_double() { grep -oE "\"$1\",\"value\":\{\"doubleValue\":[0-9.]+" | grep -oE '[0-9.]+$' | tail -1; }

# Split captured spans on the separator.
spans_count=$(grep -c -- '---SPAN-SEPARATOR---' "$tmpdir/spans.ndjson" || echo 0)
[ "$spans_count" -eq 3 ] \
  || fail "expected 3 spans (2 projects + 1 aggregate), got $spans_count"

flat="$(tr -d '\n ' < "$tmpdir/spans.ndjson")"

# 3. Per-project spans carry their own per-project totals (0.339s and 0.274s),
#    proving the aggregate (18.107s) was NOT mis-attributed to the last project.
echo "$flat" | grep -q '"typescript.total_time_s","value":{"doubleValue":0.339}' \
  || fail "first project span missing typescript.total_time_s=0.339"
echo "$flat" | grep -q '"typescript.total_time_s","value":{"doubleValue":0.274}' \
  || fail "second (last) project span missing total_time_s=0.274"

# 4. Exactly one span is the aggregate, with the build-level total (18.107s) and
#    projects_built count.
agg_count=$( (echo "$flat" | grep -oE '"typescript.aggregate","value":\{"boolValue":true\}' || true) | grep -c . || true)
[ "$agg_count" -eq 1 ] || fail "expected exactly 1 aggregate span, got $agg_count"
echo "$flat" | grep -q '"typescript.total_time_s","value":{"doubleValue":18.107}' \
  || fail "aggregate span missing total_time_s=18.107"
echo "$flat" | grep -q '"typescript.projects_built","value":{"intValue":"34"}' \
  || fail "aggregate span missing projects_built=34"
echo "$flat" | grep -q '"span.label","value":{"stringValue":"aggregate"}' \
  || fail "aggregate span missing span.label=aggregate"
echo "$flat" | grep -q '"span.label","value":{"stringValue":"socket"}' \
  || fail "project span missing concise span.label"
echo "$flat" | grep -q '"compiler.name","value":{"stringValue":"tsgo"}' \
  || fail "span missing compiler identity"
echo "$flat" | grep -q '"diagnostics.source","value":{"stringValue":"extendedDiagnostics"}' \
  || fail "span missing diagnostics source"
echo "$flat" | grep -q '"name":"typescript.build.aggregate"' \
  || fail "aggregate span should use the stable typescript.build.aggregate name"
echo "$flat" | grep -q '"name":"typescript.project.check"' \
  || fail "project spans should use the stable typescript.project.check name"
echo "$flat" | grep -q '"service.name","value":{"stringValue":"effect-utils-devenv"}' \
  || fail "spans should use the unified effect-utils-devenv service"
echo "$flat" | grep -q '"tool.name","value":{"stringValue":"typescript"}' \
  || fail "span missing tool.name=typescript"
echo "$flat" | grep -q '"ts.project.name","value":{"stringValue":"socket"}' \
  || fail "project span missing typed project name"
echo "$flat" | grep -q '"tsconfig.path","value":{"stringValue":"tsconfig.check.json"}' \
  || fail "project span missing typed tsconfig path"

# 5. No per-project span should carry the aggregate total. (grep may match
#    nothing — guard against pipefail killing the assignment.)
proj_with_agg_total=$( (echo "$flat" \
  | grep -oE '"name":"[^"]*","kind":1[^]]*"typescript.total_time_s","value":\{"doubleValue":18.107\}' \
  | grep -v '"name":"typescript.build.aggregate"' || true) | grep -c . || true)
[ "$proj_with_agg_total" -eq 0 ] \
  || fail "a per-project span was mis-attributed the aggregate total (18.107s)"

echo ""
echo "ts diagnostics parser test passed"
