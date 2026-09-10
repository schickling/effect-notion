# TypeScript tasks
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.ts {})
#     # Or with custom tsconfig:
#     (inputs.effect-utils.devenvModules.tasks.ts { tsconfigFile = "tsconfig.dev.json"; })
#   ];
#
# Provides: ts:check, ts:check:strict, ts:build-watch, ts:build, ts:emit, ts:clean
#
# Dependencies:
#   - genie:run: config files must be generated before tsc can resolve paths
#   - pnpm:install: node_modules must exist for tsc to resolve types
#
# Project graph scope:
#   This module is the authority ONLY for the projects actually referenced by
#   `tsconfigFile` / `emitTsconfigFile`. Packages whose typecheck and `dist` are
#   owned by another build system (in this repo: the Buck-authoritative
#   packages) are NOT members of `tsconfig.check.json` /
#   `tsconfig.emit.json` — they are gated by that system's own check task
#   (`buck2:check`), and listing them here as well would duplicate the
#   authority and diverge on flags.
#
#   The residual root projects still CONSUME those packages' declarations, and
#   they read them from published `dist` directories in the source tree rather
#   than from `node_modules`. Those directories are produced by the owning
#   build system, not by `pnpm:install`, so type-checking or emitting before the
#   publisher has run reads a STALE or ABSENT `dist` and reports errors that
#   describe the previous build instead of the current sources. Ordering is
#   therefore the CALLER's job: a repo whose graph consumes such declarations
#   adds the publishing task to these tasks' `after` lists from its own
#   devenv module (devenv merges `after` across modules), e.g.
#   `tasks."ts:check".after = [ "buck2:typescript:materialize-dist" ];`. This
#   module takes no argument for it, so there is exactly one mechanism for
#   that edge.
#
# Caching notes:
#   TypeScript's incremental build (--build) uses .tsbuildinfo files to cache
#   results. Use `ts:check` for fast local feedback and `ts:check:strict`
#   when correctness matters more than incremental reuse, such as CI gates or
#   reused automation workspaces that may see dependency-only type changes.
#   `ts:check:strict` inherits the merged `ts:check.after` graph so repo-local
#   generators also run in strict mode.
#   `ts:clean` remains available as a heavier escape hatch when you suspect
#   corrupted build metadata. Ensure all packages that this solution owns are
#   listed in tsconfig.check.json references.
#
# Effect-LSP gate (issue #811):
#   The `@effect/language-service` gate is ENABLED (see `effectDiagnosticsGate`
#   in genie/external.ts -> baseTsconfigCompilerOptions): any `tsgo --build` over
#   the project graph gates on Effect diagnostics via the exit code — an Effect
#   warning OR suggestion in any member project fails the build (errors always
#   gate). The gate rides the normal type-check, so there is no extra compiler
#   pass: `ts:check` (incremental) and `ts:check:strict` (--force) both enforce it,
#   and thus so do `check:quick`/`check:all` and the CI `typecheck` lane.
#   `--force` is NOT required for the gate to hold: tsgo persists and replays the
#   Effect (plugin) diagnostics from .tsbuildinfo, so incremental `ts:check` stays
#   red until the diagnostic is fixed (verified).
#
# tsBin:
#   Path to the TypeScript build/check binary. Defaults to "tsgo" so normal
#   workspace checks use Nix-managed TypeScript 7.
#
# OTEL tracing:
#   When OTEL is available, ts:check and ts:build run with --extendedDiagnostics
#   --verbose (adds ~3% overhead) and emit per-project child spans with timing
#   attributes (typescript.check_time_s, typescript.parse_time_s, etc.). This applies to both
#   the JS tsc and Effect tsgo, whose build diagnostics share the same shape;
#   tsgo additionally yields a build-level "aggregate" span. The timing
#   scaffolding is stripped from the user's view, but real errors and tsgo's
#   Effect lints are always re-surfaced.
#
# Status checks:
#   - ts:emit uses `tsgo --build --dry --noCheck` to skip when no outputs would be produced.
{
  tsconfigFile ? "tsconfig.check.json",
  emitTsconfigFile ? "tsconfig.emit.json",
  tsBin ? "tsgo",
  # Real derivation/path backing the `tsBin` guard. When set, the guard owns
  # `bin/<tsBin>` and exec's this by absolute path under passthrough (see
  # cli-guard.nix).
  tsBinPkg ? null,
}:
{
  lib,
  pkgs,
  config,
  ...
}:
let
  trace = import ../lib/trace.nix { inherit lib; };
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
  inheritedCheckAfter =
    config.tasks."ts:check".after or [
      "genie:run"
      "pnpm:install"
    ];
  requireEmitTsconfig = ''
    if [ ! -r ${lib.escapeShellArg emitTsconfigFile} ]; then
      echo "ts:emit: emit tsconfig ${lib.escapeShellArg emitTsconfigFile} is missing or unreadable; run genie:run to generate it" >&2
      exit 1
    fi
  '';
  emitGraphHasReferences = "grep -q '\"path\"[[:space:]]*:' ${lib.escapeShellArg emitTsconfigFile}";

  # Script that runs the selected TypeScript compiler with --extendedDiagnostics --verbose,
  # parses per-project timing, and emits OTEL child spans.
  # The outer trace.exec wrapper provides the parent ts:check/ts:build span.
  #
  # tsc/tsgo has no structured diagnostics source (decision 0017), so the compiler
  # is instrumented adapter=none (decision 0018): otel-scrape wraps ONLY the
  # compiler invocation, yielding a `tsgo`-named command span beneath the task
  # span. The `typescript.project.check` / `typescript.build.aggregate` phase spans
  # are emitted from the task shell (outside otel-scrape) and so remain
  # task-siblings of the `tsgo` span — the wrap-only-compiler tradeoff from
  # experiment 0009 that keeps the honest `tsgo` name (the nested alternative would
  # name the command span `bash`). Instrumentation is scoped to the OTEL-active
  # branch; the no-OTEL fallback runs the compiler bare.
  #
  # When OTEL is not available, runs the compiler without diagnostics flags.
  tscWithDiagnostics = name: compilerBin: tscInvocation: extraArgs: ''
    set -euo pipefail

    _ts_compiler_name="$(${pkgs.coreutils}/bin/basename ${lib.escapeShellArg compilerBin})"

    # Only add diagnostics flags when OTEL tracing is active.
    #
    # Both the JS `tsc` and Effect `tsgo` emit `--build --extendedDiagnostics
    # --verbose` output in the same shape (`Building project '...'` blocks with
    # `Parse time:`/`Check time:`/`Emit time:`/`Total time:`/`Memory used:`), so
    # a single parser below handles both. tsgo additionally emits an aggregate
    # build summary (`Projects in scope:` ... `Aggregate Total time:`); the
    # parser resets the current project on that boundary so the aggregate totals
    # never get attributed to the last project, and emits them as one
    # build-level span instead.
    #
    # tsgo's per-project blocks also carry Effect language-service lints
    # (`warning`/`suggestion TS377...`). On this OTEL path the raw compiler
    # output is captured to a temp file, so those lints are re-surfaced through
    # `filter_diagnostics_noise` on BOTH success and failure — otherwise routing
    # tsgo through this path would silently swallow them.
    # Same command-level gate as trace.instr (oxlint/vitest) — otelTraceContextActive
    # requires OTEL delivery AND a well-formed traceparent. _ts_parent_context below
    # is still parsed for the trace/span ids when the gate holds.
    _ts_parent_context="''${OTEL_TASK_TRACEPARENT:-''${TRACEPARENT:-}}"
    if ${trace.otelTraceContextActive}; then
      _tsc_output="$(mktemp)"
      trap 'rm -f "$_tsc_output"' EXIT

      # Strip the diagnostics/timing scaffolding so only real compiler output
      # (errors, and tsgo's Effect `warning`/`suggestion` lints) is shown.
      # Drops both tsc-style counters/timers and tsgo's extra build-progress and
      # aggregate-summary lines (`Building project`, timestamped project status,
      # `Projects in scope:`, `Aggregate ...`).
      filter_diagnostics_noise() {
        sed -E 's/^[0-9]{1,2}:[0-9]{2}:[0-9]{2} (AM|PM) - //' "$1" \
          | grep -v -E "^([[:space:]]*\* .*tsconfig\.json|Building project |Project .* is being forcibly rebuilt|Files:|Lines:|Lines of|Identifiers:|Symbols:|Types:|Instantiations:|Memory used:|Memory allocs:|Assignability|Identity|Subtype|Strict subtype|I/O|Config time:|BuildInfo read time:|Parse time:|ResolveModule|ResolveTypeReference|ResolveLibrary|Program time:|Bind time:|Changes compute time:|Check time:|Emit time:|Total time:|Build time:|Projects in this build:|Projects in scope:|Projects built:|Timestamps only updates:|Aggregate)" \
          || true
      }

      # Wrap ONLY the compiler with otel-scrape (adapter=none) for a `tsgo`-named
      # command span. adapter=none uses stdio inherit (byte-clean passthrough), so
      # the `> "$_tsc_output" 2>&1` capture below still sees exactly the compiler's
      # own output — no otel-scrape lines leak into the diagnostics parser.
      ${trace.instr {
        adapter = "none";
        inherit name;
      }}
      _tsc_exit=0
      if [[ "${tscInvocation}" == --build* ]]; then
        "''${_otel_instr[@]}" ${compilerBin} ${tscInvocation} ${extraArgs} --extendedDiagnostics --verbose > "$_tsc_output" 2>&1 || _tsc_exit=$?
      else
        "''${_otel_instr[@]}" ${compilerBin} ${tscInvocation} ${extraArgs} > "$_tsc_output" 2>&1 || _tsc_exit=$?
      fi

      # Preserve the complete compiler failure stream. Besides making compiler
      # crashes diagnosable, this avoids mistaking a new diagnostic shape for
      # timing scaffolding. Successful checks retain the concise filtered view.
      if [ "$_tsc_exit" -ne 0 ]; then
        cat "$_tsc_output" >&2
      else
        filter_diagnostics_noise "$_tsc_output"
      fi

      if [[ "${tscInvocation}" == --build* ]]; then
        # Parse task-scoped trace context to get trace ID and current task span ID.
        IFS='-' read -r _tp_ver _tp_trace _tp_parent _tp_flags <<< "$_ts_parent_context"

        emit_tsc_measurement_span() {
          local _span_name="$1"
          local _span_id="$2"
          local _start_ns="$3"
          local _end_ns="$4"
          local _label="$5"
          shift 5

          otel-span emit-span "effect-utils-devenv" "$_span_name" \
            --scope-name "typescript-diagnostics" \
            --trace-id "$_tp_trace" \
            --span-id "$_span_id" \
            --parent-span-id "$_tp_parent" \
            --start-time-ns "$_start_ns" \
            --end-time-ns "$_end_ns" \
            --attr-string "span.label=$_label" \
            --attr-string "tool.name=typescript" \
            --attr-string "compiler.name=$_ts_compiler_name" \
            --attr-string "diagnostics.source=extendedDiagnostics" \
            --attr-string "diagnostics.kind=compiler_diagnostics" \
            "$@"
        }

        # Parse the diagnostics output for per-project timing
        # Pattern: "Building project '...'" followed by a diagnostics block ending with "Total time: X.XXs"
        _current_project=""
        _diag_block=""
        while IFS= read -r line; do
        # Match "Building project '/path/to/tsconfig.json'..."
        if [[ "$line" =~ "Building project '"(.+)"'" ]]; then
          _current_project="''${BASH_REMATCH[1]}"
          # Strip DEVENV_ROOT prefix for cleaner names
          _current_project="''${_current_project#$DEVENV_ROOT/}"
          # Strip /tsconfig.json suffix
          _current_project="''${_current_project%/tsconfig.json}"
          _diag_block=""
        fi

        # tsgo closes the per-project section with an aggregate build summary
        # ("Projects in scope: ..." ... "Aggregate Total time: ..."). Defensive
        # reset on that boundary: in all observed output every built project —
        # even errored ones — prints its own "Total time:" that already closes
        # it, and up-to-date projects never emit "Building project" at all, so
        # the aggregate is normally already orphaned. This guards the edge where
        # a project's block is left open, keeping the aggregate timers from being
        # attributed to it; the aggregate is captured separately below. tsc never
        # emits this line, so the reset is a no-op for the JS compiler.
        if [[ "$line" =~ ^"Projects in scope:" ]]; then
          _current_project=""
          _diag_block=""
        fi

        # Accumulate diagnostics lines for the current project
        if [[ -n "$_current_project" ]]; then
          _diag_block="$_diag_block"$'\n'"$line"
        fi

        # Match "Total time:    X.XXs"
        if [[ -n "$_current_project" ]] && [[ "$line" =~ "Total time:"[[:space:]]*([0-9]+\.[0-9]+)"s" ]]; then
          _total_time="''${BASH_REMATCH[1]}"

          # Extract additional timing from the accumulated diagnostics block
          _check_time=$(echo "$_diag_block" | grep "Check time:" | grep -oE '[0-9]+\.[0-9]+' || echo "")
          _parse_time=$(echo "$_diag_block" | grep "Parse time:" | grep -oE '[0-9]+\.[0-9]+' || echo "")
          _emit_time=$(echo "$_diag_block" | grep "Emit time:" | grep -oE '[0-9]+\.[0-9]+' || echo "")
          _files_count=$(echo "$_diag_block" | grep "^Files:" | grep -oE '[0-9]+' || echo "")
          _memory=$(echo "$_diag_block" | grep "Memory used:" | grep -oE '[0-9]+' || echo "")

          # Convert seconds to nanoseconds for span duration
          _total_ms=$(${pkgs.coreutils}/bin/printf "%.0f" "$(echo "$_total_time * 1000" | ${pkgs.bc}/bin/bc)")
          _duration_ns=$(echo "$_total_ms * 1000000" | ${pkgs.bc}/bin/bc)

          # Generate a span ID
          _span_id=$(${pkgs.coreutils}/bin/od -An -tx1 -N8 /dev/urandom | tr -d ' \n')

          # Compute timestamps: span ends "now" and started duration_ns ago
          _end_ns=$(${pkgs.coreutils}/bin/date +%s%N)
          _start_ns=$((_end_ns - _duration_ns))

          _project_label="''${_current_project##*/}"
          _span_args=(
            --attr-string "ts.project=$_current_project"
            --attr-string "ts.project.name=$_project_label"
            --attr-string "tsconfig.path=${tsconfigFile}"
            --attr-bool "typescript.aggregate=false"
            --attr-double "typescript.total_time_s=$_total_time"
          )
          [ -n "$_check_time" ] && _span_args+=(--attr-double "typescript.check_time_s=$_check_time")
          [ -n "$_parse_time" ] && _span_args+=(--attr-double "typescript.parse_time_s=$_parse_time")
          [ -n "$_emit_time" ] && _span_args+=(--attr-double "typescript.emit_time_s=$_emit_time")
          [ -n "$_files_count" ] && _span_args+=(--attr-int "typescript.files=$_files_count")
          [ -n "$_memory" ] && _span_args+=(--attr-int "typescript.memory_kb=$_memory")

          emit_tsc_measurement_span "typescript.project.check" "$_span_id" "$_start_ns" "$_end_ns" "$_project_label" "''${_span_args[@]}"

          _current_project=""
          _diag_block=""
        fi
        done < "$_tsc_output"

        # Emit one build-level span from tsgo's aggregate summary, if present.
        # This is the highest-fidelity whole-workspace timing tsgo exposes and is
        # not available from tsc (which has no aggregate block), so it is a
        # tsgo-only enrichment that complements the per-project spans above.
        _agg_total=$(grep "^Aggregate Total time:" "$_tsc_output" | grep -oE '[0-9]+\.[0-9]+' | tail -1 || echo "")
        if [ -n "$_agg_total" ]; then
          _agg_check=$(grep "^Aggregate Check time:" "$_tsc_output" | grep -oE '[0-9]+\.[0-9]+' | tail -1 || echo "")
          _agg_parse=$(grep "^Aggregate Parse time:" "$_tsc_output" | grep -oE '[0-9]+\.[0-9]+' | tail -1 || echo "")
          _agg_emit=$(grep "^Aggregate Emit time:" "$_tsc_output" | grep -oE '[0-9]+\.[0-9]+' | tail -1 || echo "")
          _agg_files=$(grep "^Aggregate Files:" "$_tsc_output" | grep -oE '[0-9]+' | tail -1 || echo "")
          _agg_memory=$(grep "^Aggregate Memory used:" "$_tsc_output" | grep -oE '[0-9]+' | tail -1 || echo "")
          _projects_built=$(grep "^Projects built:" "$_tsc_output" | grep -oE '[0-9]+' | tail -1 || echo "")

          _agg_total_ms=$(${pkgs.coreutils}/bin/printf "%.0f" "$(echo "$_agg_total * 1000" | ${pkgs.bc}/bin/bc)")
          _agg_duration_ns=$(echo "$_agg_total_ms * 1000000" | ${pkgs.bc}/bin/bc)
          _agg_span_id=$(${pkgs.coreutils}/bin/od -An -tx1 -N8 /dev/urandom | tr -d ' \n')
          _agg_end_ns=$(${pkgs.coreutils}/bin/date +%s%N)
          _agg_start_ns=$((_agg_end_ns - _agg_duration_ns))

          _agg_args=(
            --attr-bool "typescript.aggregate=true"
            --attr-double "typescript.total_time_s=$_agg_total"
          )
          [ -n "$_agg_check" ] && _agg_args+=(--attr-double "typescript.check_time_s=$_agg_check")
          [ -n "$_agg_parse" ] && _agg_args+=(--attr-double "typescript.parse_time_s=$_agg_parse")
          [ -n "$_agg_emit" ] && _agg_args+=(--attr-double "typescript.emit_time_s=$_agg_emit")
          [ -n "$_agg_files" ] && _agg_args+=(--attr-int "typescript.files=$_agg_files")
          [ -n "$_agg_memory" ] && _agg_args+=(--attr-int "typescript.memory_kb=$_agg_memory")
          [ -n "$_projects_built" ] && _agg_args+=(--attr-int "typescript.projects_built=$_projects_built")

          emit_tsc_measurement_span "typescript.build.aggregate" "$_agg_span_id" "$_agg_start_ns" "$_agg_end_ns" "aggregate" "''${_agg_args[@]}"
        fi
      fi

      exit "$_tsc_exit"
    else
      # No OTEL: retain the compiler stream and make an otherwise silent
      # non-zero exit diagnosable in CI.
      _tsc_output="$(mktemp)"
      trap 'rm -f "$_tsc_output"' EXIT
      _tsc_exit=0
      ${compilerBin} ${tscInvocation} ${extraArgs} > "$_tsc_output" 2>&1 || _tsc_exit=$?
      if [ "$_tsc_exit" -ne 0 ]; then
        echo "ts: compiler failed (exit=$_tsc_exit bytes=$(wc -c < "$_tsc_output"))" >&2
      fi
      cat "$_tsc_output" >&2
      exit "$_tsc_exit"
    fi
  '';

  guardedTasks = {
    "ts:check" = {
      guard = tsBin;
      description = "Type check the whole workspace (tsgo --build)";
      exec = trace.exec "ts:check" (
        tscWithDiagnostics "ts:check" tsBin "--build ${lib.escapeShellArg tsconfigFile}" ""
      );
      after = [
        "genie:run"
        "pnpm:install"
      ];
    };
    "ts:check:strict" = {
      guard = tsBin;
      description = "Type check the whole workspace without incremental reuse (tsgo --build --force)";
      exec = trace.exec "ts:check:strict" (
        tscWithDiagnostics "ts:check:strict" tsBin "--build --force ${lib.escapeShellArg tsconfigFile}" ""
      );
      after = inheritedCheckAfter;
    };
    "ts:build" = {
      guard = tsBin;
      description = "Build all packages with type checking (tsgo --build)";
      exec = trace.exec "ts:build" (
        tscWithDiagnostics "ts:build" tsBin "--build ${lib.escapeShellArg tsconfigFile}" ""
      );
      after = [
        "genie:run"
        "pnpm:install"
      ];
    };
  };

  otherTasks = {
    "ts:build-watch" = {
      description = "Build all packages in watch mode (tsgo --build --watch)";
      exec = trace.exec "ts:build-watch" "${tsBin} --build --watch ${lib.escapeShellArg tsconfigFile}";
      after = [
        "genie:run"
        "pnpm:install"
      ];
    };
    "ts:emit" = trace.withStatus "ts:emit" "binary" {
      description = "Emit build outputs without full type checking (tsgo --build --noCheck)";
      # trace-audit-allow: raw exec - argument to trace.withStatus "ts:emit" above.
      exec = ''
        set -euo pipefail
        ${requireEmitTsconfig}
        if ! ${emitGraphHasReferences}; then
          echo "ts:emit: no emit-capable referenced projects"
          exit 0
        fi
        ${tscWithDiagnostics "ts:emit" tsBin "--build ${lib.escapeShellArg emitTsconfigFile}" "--noCheck"}
      '';
      # trace-audit-allow: raw status - argument to trace.withStatus "ts:emit" above.
      status = ''
        set -euo pipefail
        ${requireEmitTsconfig}
        if ! ${emitGraphHasReferences}; then
          exit 0
        fi
        _out="$(${tsBin} --build ${lib.escapeShellArg emitTsconfigFile} --dry --noCheck --verbose --pretty false 2>&1)" || exit 1
        # tsc --build --dry reports pending work as:
        # - "A non-dry build would build project ..."
        # - "A non-dry build would update timestamps for output of project ..."
        # and potentially other variants. Treat any of them as "needs emit".
        echo "$_out" | grep -q "A non-dry build would" && exit 1
        exit 0
      '';
      after = [
        "genie:run"
        "pnpm:install"
      ];
    };
    "ts:clean" = {
      description = "Remove TypeScript build artifacts";
      exec = trace.exec "ts:clean" "${tsBin} --build --clean ${lib.escapeShellArg tsconfigFile}";
    };
  };
in
{
  packages = [
    pkgs.bc
  ]
  ++ cliGuard.fromTasks {
    tasks = guardedTasks;
    reals = lib.optionalAttrs (tsBinPkg != null) { ${tsBin} = tsBinPkg; };
  };

  tasks = cliGuard.stripGuards (guardedTasks // otherTasks);
}
