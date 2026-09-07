# Lint tasks using oxlint/oxfmt
#
# Uses default config file paths (.oxfmtrc.json, .oxlintrc.json) - no explicit -c flags needed.
# Ignore patterns should be configured in the config files themselves (via genie).
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.lint-oxc {
#       # Git pathspecs that define the lint surface.
#       lintPaths = [ "packages" "scripts" ];
#       # Glob patterns for .genie.ts files (for genie check caching)
#       # Should match all *.genie.ts files without traversing node_modules
#       geniePatterns = [
#         "packages/*/*.genie.ts"
#       ];
#       # Directories to scan for genie coverage check
#       genieCoverageDirs = [ "packages" ];  # required
#       # Path prefixes to exclude from genie coverage (git pathspec patterns)
#       genieCoverageExcludes = [ "packages/vendored/" ];  # optional
#       # Config file names to check for genie coverage (default: package.json + tsconfig.json)
#       genieCoverageFiles = [ "package.json" "tsconfig.json" ];  # optional
#       # Path to tsconfig for type-aware linting (enables typescript/no-deprecated etc)
#       tsconfig = "tsconfig.check.json";  # optional
#       # Whether to fail on warnings (default: true for CI strictness)
#       # denyWarnings = false;  # optional
#     })
#   ];
#
# Provides: lint:check, lint:check:format, lint:check:oxlint, lint:check:genie, lint:check:genie:coverage
#           lint:fix, lint:fix:format, lint:fix:oxlint
{
  geniePatterns,
  genieCoverageDirs,
  genieCoverageExcludes ? [ ],
  genieCoverageFiles ? [
    "package.json"
    "tsconfig.json"
  ],
  # Git pathspecs that define the lint surface. Lint tasks enumerate tracked and
  # untracked non-ignored files below these paths, so ignored dependency/build
  # trees are never walked by devenv or the lint tools.
  lintPaths ? [ "." ],
  # Type-aware linting: provide tsconfig to enable --type-aware flag.
  # Requires pkgs.tsgolint in devenv packages (auto-discovered on PATH by oxlint).
  tsconfig ? null,
  # Whether to treat warnings as errors. Set to false for repos with many
  # existing warnings that can't be fixed immediately.
  denyWarnings ? true,
  # Real derivation/path backing the formatter guard. Defaults to pkgs.oxfmt but
  # stays injectable so module tests can prove absolute-path execution without
  # depending on PATH shadowing.
  oxfmtPkg ? null,
  # Real derivation/path backing the `oxlint` guard (e.g. the plugin-injecting
  # oxlint wrapper). When set, the guard owns `bin/oxlint` and exec's this by
  # absolute path under passthrough (see cli-guard.nix).
  oxlintPkg ? null,
  # Explicit packaged Genie product and install-free lockfile task.
  geniePkg,
  lockfileCheckTask ? "pnpm:check-lockfile",
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
  megarepoStoreEnv = builtins.getEnv "MEGAREPO_STORE";
  genieTaskEnv = lib.optionalAttrs (megarepoStoreEnv != "") {
    MEGAREPO_STORE = megarepoStoreEnv;
  };
  genieBin = "${geniePkg}/bin/genie";
  git = "${pkgs.git}/bin/git";
  scanDirsSetup = builtins.concatStringsSep "\n" (
    map (dir: "scan_dir_args+=(${builtins.toJSON dir})") genieCoverageDirs
  );
  excludePathspecsSetup = builtins.concatStringsSep "\n" (
    map (p: "pathspec_args+=(${builtins.toJSON ":(exclude)${p}"})") genieCoverageExcludes
  );
  coverageFileMatches = builtins.concatStringsSep " || " (
    lib.concatMap (f: [
      ''"$f" == ${builtins.toJSON f}''
      ''"$f" == */${f}''
    ]) genieCoverageFiles
  );
  lintPathspecsSetup = builtins.concatStringsSep "\n" (
    map (pathspec: "lint_pathspec_args+=(${builtins.toJSON pathspec})") lintPaths
  );

  mkLintExec =
    {
      command,
      includeCase,
      # Task identity ("lane") reported in failure diagnostics, so a nonzero
      # status arriving at the task boundary names which task produced it.
      lane,
      # Human-readable form of `command` for those diagnostics. Defaults to the
      # command itself; call sites whose command carries shell plumbing (the
      # otel-scrape `_otel_instr` array expansions) pass the concrete tool line
      # so the diagnostic names the tool, not the plumbing.
      commandLabel ? command,
      emptySelectionDiagnostic ? null,
      # Split the selected file list into ownership units and run the command
      # once per unit, sequentially. Only the oxlint lanes need this: oxlint
      # hands the whole selection to tsgolint in ONE type-aware program, whose
      # memory grows superlinearly with the number of heavy packages (CI #5370:
      # oom_kill=1, peak 14.78 GiB of 16 GiB, tsgolint SIGKILL; a bounded
      # prototype measured >23 GiB at four heavy packages versus 1.354 GiB
      # maximum across 38 sequential units for the same 1644-file surface).
      # oxfmt has no such program and keeps its single invocation.
      partition ? false,
      # Optional shell prelude injected before the file scan (e.g. trace.instr,
      # which defines the _otel_instr / _otel_instr_flags arrays the command uses).
      prelude ? "",
    }:
    ''
      set -euo pipefail

      # Failure attribution. A nonzero status used to leave this exec with no
      # stdout and no stderr whatsoever: `xargs` collapses any child status in
      # 1..125 to 123, and a setup/scan step failing under `errexit` aborted the
      # exec without naming itself — so a red CI task showed only "exit 1" with
      # nothing to distinguish a real lint finding from a broken wrapper. The
      # diagnostics below NEVER alter the status, NEVER buffer tool output, and
      # print one line to stderr; lint findings keep streaming as before.
      lint_lane=${lib.escapeShellArg lane}
      lint_cmd_label=${lib.escapeShellArg commandLabel}
      lint_stage=setup
      trap 'lint_rc=$?; printf "lint-oxc: lane=%s stage=%s aborted at line %s with status %s (command: %s)\n" "$lint_lane" "$lint_stage" "$LINENO" "$lint_rc" "$lint_cmd_label" >&2' ERR

      ${prelude}
      lint_pathspec_args=()
      ${lintPathspecsSetup}

      lint_stage=scan
      files=$(mktemp)
      lint_scratch=$(mktemp -d)
      trap 'rm -f "$files"; rm -rf "$lint_scratch"' EXIT
        {
          ${git} ls-files -z -- "''${lint_pathspec_args[@]}"
          ${git} ls-files -z --others --exclude-standard -- "''${lint_pathspec_args[@]}"
        } | ${pkgs.coreutils}/bin/sort -zu | while IFS= read -r -d "" path; do
          [ -e "$path" ] || [ -L "$path" ] || continue
          case "$path" in
            ${includeCase}
              printf '%s\0' "$path"
              ;;
          esac
        done > "$files"

      if [ ! -s "$files" ]; then
        echo "No lint files matched"
        exit 0
      fi

      lint_file_count=$(${pkgs.coreutils}/bin/tr -cd '\0' < "$files" | ${pkgs.coreutils}/bin/wc -c)

      # Ownership partitioning. Every directory holding a LITERAL tsconfig.json
      # under the lint pathspecs owns the files whose nearest such ancestor it
      # is; files owned by none form ONE residual unit (keyed ".", which is also
      # where a repo-root tsconfig.json lands, so the two can never split the
      # same file). The union is therefore exactly `$files` — no file dropped,
      # none linted twice — and the per-invocation flags are untouched, so lint
      # semantics do not change. `--tsconfig` is NOT what partitions tsgolint
      # (it neither selects compilerOptions nor bounds the program: each file is
      # resolved against its own nearest literal tsconfig.json), so the split
      # has to happen at the invocation boundary.
      lint_unit_files=()
      lint_unit_labels=()
      ${
        if partition then
          ''
            lint_stage=partition
            lint_units_dir="$lint_scratch/units"
            ${pkgs.coreutils}/bin/mkdir -p "$lint_units_dir"
            declare -A lint_unit_slot=()
            declare -A lint_owner_of_dir=()
            while IFS= read -r -d "" lint_path; do
              lint_dir=''${lint_path%/*}
              if [ "$lint_dir" = "$lint_path" ]; then
                lint_dir=.
              fi
              # Directory -> owner is memoized: a package with hundreds of files
              # then costs one upward walk, not one per file.
              if [ -n "''${lint_owner_of_dir[$lint_dir]+set}" ]; then
                lint_owner=''${lint_owner_of_dir[$lint_dir]}
              else
                lint_owner=.
                lint_probe=$lint_dir
                while true; do
                  if [ -f "$lint_probe/tsconfig.json" ]; then
                    lint_owner=$lint_probe
                    break
                  fi
                  if [ "$lint_probe" = "." ]; then
                    break
                  fi
                  lint_parent=''${lint_probe%/*}
                  if [ "$lint_parent" = "$lint_probe" ]; then
                    lint_parent=.
                  fi
                  lint_probe=$lint_parent
                done
                lint_owner_of_dir[$lint_dir]=$lint_owner
              fi
              if [ -z "''${lint_unit_slot[$lint_owner]+set}" ]; then
                lint_slot=''${#lint_unit_files[@]}
                lint_unit_slot[$lint_owner]=$lint_slot
                lint_unit_labels[lint_slot]=$lint_owner
                lint_unit_files[lint_slot]="$lint_units_dir/$lint_slot"
                : > "$lint_units_dir/$lint_slot"
              fi
              lint_slot=''${lint_unit_slot[$lint_owner]}
              # NUL-separated throughout: paths carrying spaces or newlines are
              # never re-split, exactly as the `xargs -0` contract requires.
              printf '%s\0' "$lint_path" >> "''${lint_unit_files[$lint_slot]}"
            done < "$files"
          ''
        else
          ''
            lint_unit_files=("$files")
            lint_unit_labels=(all)
          ''
      }
      lint_unit_count=''${#lint_unit_files[@]}
      lint_stage=run

      # The invocation lives in a function so its exact form (including the
      # `< "$lint_unit_file"` redirect and the outer-shell `_otel_instr` array)
      # is unchanged, while its status can be captured instead of aborting the
      # exec anonymously under `errexit`. It is called once per ownership unit
      # with that unit's NUL-separated file list; an unpartitioned lane passes
      # the whole `$files` list, so its single invocation is byte-identical to
      # before.
      _run_lint_unit() {
        local lint_unit_file="$1"

        ${
          if emptySelectionDiagnostic == null then
            "${pkgs.findutils}/bin/xargs -0 ${command} < \"$lint_unit_file\""
          else
            # The empty-selection stderr swallow must run PER xargs batch (a later
            # all-ignored chunk emits the diagnostic independently), so it lives in
            # the batch child, not the outer shell. To wrap the tool with the
            # otel-scrape prefix — which is a bash array (`_otel_instr`) that only
            # exists in the OUTER shell and cannot cross into a POSIX `sh` child —
            # we expand it in the outer shell and pass its elements as leading
            # positional args (preceded by a count) into a `bash -c` child, which
            # reconstructs the array and applies it to the concrete command. That
            # names the command span after the wrapped child (`oxfmt`), never the
            # helper shell. `${command}` runs bare when the prefix is empty
            # (otel-scrape absent / gate inactive), so this path is behaviorally
            # identical to a plain `xargs -0 ${command}` in that case.
            #
            # `_otel_instr` is defined by the trace.instr prelude when a task opts
            # in; the guard keeps the branch valid for tasks that don't (the prefix
            # is then empty and the command runs bare).
            ''
              declare -p _otel_instr >/dev/null 2>&1 || _otel_instr=()
              ${pkgs.findutils}/bin/xargs -0 ${pkgs.bash}/bin/bash -c '
                empty_selection_diagnostic="$1"
                shift
                otel_prefix_count="$1"
                shift
                otel_prefix=()
                while [ "$otel_prefix_count" -gt 0 ]; do
                  otel_prefix+=("$1")
                  shift
                  otel_prefix_count=$((otel_prefix_count - 1))
                done

                stderr_file=$(mktemp)
                trap "rm -f \"$stderr_file\"" EXIT

                if "''${otel_prefix[@]}" ${command} "$@" 2>"$stderr_file"; then
                  if [ -s "$stderr_file" ]; then
                    cat "$stderr_file" >&2
                  fi
                  exit 0
                else
                  status=$?
                fi

                stderr="$(cat "$stderr_file")"
                # All-ignored batch: oxfmt exits 2 and prints the empty-selection
                # diagnostic. Detect it by BOTH exit code 2 AND the diagnostic
                # substring, so the swallow survives extra wrapper stderr (the
                # otel-scrape prefix prints its own note lines to this same stream)
                # yet never hides a genuine parse error (also exit 2, but WITHOUT
                # the diagnostic) or a formatting diff (exit 1). Substring, not
                # exact equality: real oxfmt appends "All matched files may have
                # been excluded by ignore rules." and the wrapper interleaves lines.
                case "$stderr" in
                  *"$empty_selection_diagnostic"*)
                    if [ "$status" -eq 2 ]; then
                      exit 0
                    fi
                    ;;
                esac

                printf "%s\n" "$stderr" >&2
                exit "$status"
              ' bash ${lib.escapeShellArg emptySelectionDiagnostic} \
                "''${#_otel_instr[@]}" "''${_otel_instr[@]}" < "$lint_unit_file"
            ''
        }
      }

      # Classify the RETAINED FINAL BYTE of a stream. The comparison is
      # NUMERICAL (10 = LF) because inspecting the byte as text cannot classify
      # it: command substitution strips trailing newlines AND drops NUL bytes,
      # so a stream ending in a literal NUL (a truncated/holed tail) produced an
      # empty string and was mislabelled `newline`, suppressing the
      # line-completing newline. `od` renders the byte as digits, which survive
      # substitution. An empty retention file means the stream had no bytes.
      _lint_classify_tail() {
        if [ ! -s "$1" ]; then
          printf 'empty'
        elif [ "$(${pkgs.coreutils}/bin/od -An -N1 -tu1 < "$1" \
          | ${pkgs.coreutils}/bin/tr -d '[:space:]')" = 10 ]; then
          printf 'newline'
        else
          printf 'no-newline'
        fi
      }

      # Per-unit output boundary. Byte accounting and tail classification are
      # PER UNIT rather than per task because a unit whose stdout ends WITHOUT a
      # newline (the tsgolint SIGKILL report) is otherwise concatenated with the
      # next unit's first line: two reports fuse into one corrupt line, and the
      # aggregate tail reads `newline` merely because some LATER unit ended
      # cleanly — so the diagnostic denied a truncation that had already
      # happened. Every unit therefore OWNS and COMPLETES its own final line
      # before the next unit starts, regardless of whether the inherited stdout
      # is a terminal or a redirect.
      #
      # `tee` relays bytes as they arrive, preserving interactive rendering and
      # progress output rather than collecting a unit before displaying it. Only
      # the final byte is retained (`tail -c 1`) and only bytes are counted
      # (`wc -c`): no lint output is ever buffered, in memory or on disk. The
      # real stdout is reached with `>&3`, which DUPLICATES the inherited
      # descriptor. It must never be named as a path: `tee /dev/fd/3` reopens the
      # file with O_TRUNC on Linux, so a task whose stdout is a redirected
      # regular file (a CI log) lost everything written before this point and
      # left a NUL hole where the outer offset had advanced. The readers get
      # FIFOs — paths `tee` may safely open — as known background jobs that are
      # waited on before their results are read.
      lint_unit_bytes=0
      lint_unit_tail=empty
      _run_lint_unit_observed() {
        local unit_file="$1"
        local rc=0
        local wc_pid tail_pid
        ${pkgs.coreutils}/bin/rm -f "$lint_stdout_fifo" "$lint_tail_fifo"
        ${pkgs.coreutils}/bin/mkfifo "$lint_stdout_fifo" "$lint_tail_fifo"
        ${pkgs.coreutils}/bin/wc -c < "$lint_stdout_fifo" > "$lint_bytes" &
        wc_pid=$!
        ${pkgs.coreutils}/bin/tail -c 1 < "$lint_tail_fifo" > "$lint_last" &
        tail_pid=$!
        {
          _run_lint_unit "$unit_file" \
            | ${pkgs.coreutils}/bin/tee "$lint_stdout_fifo" "$lint_tail_fifo" >&3
        } 3>&1 || rc=$?
        wait "$wc_pid"
        wait "$tail_pid"
        lint_unit_bytes=$(${pkgs.coreutils}/bin/tr -d ' ' < "$lint_bytes")
        lint_unit_tail=$(_lint_classify_tail "$lint_last")
        # Complete the line the tool never terminated, on the real stdout and
        # OUTSIDE the counted stream, so the inserted byte is never reported as
        # tool output. devenv relays a failing task's output line by line and
        # DROPS the trailing chunk after the last newline at EOF, so an
        # unterminated report was invisible in CI even when it was the only line
        # naming the failure. Nothing is inserted after output that already ends
        # in a newline, and nothing at all after a silent unit.
        if [ "$lint_unit_tail" = no-newline ]; then
          printf '\n'
        fi
        return "$rc"
      }

      # Units run STRICTLY SEQUENTIALLY: the whole point is that only one
      # tsgolint program is resident at a time. A failing unit does not
      # short-circuit — later units still lint, so one broken package cannot
      # mask findings elsewhere — and the FIRST nonzero status is what the task
      # returns, so a single-unit lane keeps its exact previous exit behaviour.
      _run_lint() {
        local unit_index=0
        local unit_rc
        while [ "$unit_index" -lt "$lint_unit_count" ]; do
          unit_rc=0
          _run_lint_unit_observed "''${lint_unit_files[$unit_index]}" || unit_rc=$?
          lint_stdout_bytes=$((lint_stdout_bytes + lint_unit_bytes))
          # The aggregate tail describes the last unit that actually WROTE
          # something: a silent later unit must not make a newline-less report
          # look terminated.
          if [ "$lint_unit_tail" != empty ]; then
            lint_stdout_tail=$lint_unit_tail
          fi
          if [ "$unit_rc" -ne 0 ]; then
            lint_failed_units=$((lint_failed_units + 1))
            if [ "$lint_status" -eq 0 ]; then
              lint_status=$unit_rc
              lint_first_failed_unit=''${lint_unit_labels[$unit_index]}
            fi
          fi
          unit_index=$((unit_index + 1))
        done
      }

      # Memory evidence for a lint child that dies mute. A kernel OOM kill
      # (SIGKILL) leaves NO message of its own — `tsgolint` reporting
      # `signal: 9 (SIGKILL)` is otherwise indistinguishable from any other
      # signal death, so "the runner ran out of memory" stayed an inference.
      # cgroup v2 answers it directly: memory.events records `oom`/`oom_kill`
      # counts and memory.peak the high-water mark against memory.max.
      #
      # Every read is optional and LABELLED when missing: cgroup v1 hosts,
      # restricted mounts and macOS (no /proc, no cgroups) report
      # `memory=unavailable` instead of turning diagnostics into a failure.
      _lint_cgroup_field() {
        local value
        if [ -r "$1" ]; then
          # memory.events is multi-line ("low 0", "high 0", "max 0", "oom 0",
          # "oom_kill 0"); flatten it so the whole record stays one log line.
          value=$(${pkgs.coreutils}/bin/tr '\n' ' ' < "$1" 2>/dev/null || true)
          printf '%s' "''${value% }"
        else
          printf 'unavailable'
        fi
      }

      _lint_memory_evidence() {
        local line rel dir
        rel=""
        dir=""
        if [ -r /proc/self/cgroup ]; then
          # A unified-hierarchy host has exactly one "0::<path>" line; hybrid
          # v1 hosts carry extra controller lines that are of no use here.
          while IFS= read -r line; do
            case "$line" in
              0::*) rel=''${line#0::} ;;
            esac
          done < /proc/self/cgroup
        fi
        if [ -n "$rel" ] && [ -r "/sys/fs/cgroup$rel/memory.events" ]; then
          dir="/sys/fs/cgroup$rel"
        elif [ -r /sys/fs/cgroup/memory.events ]; then
          # Inside a cgroup namespace (containers, some CI runners) the process's
          # own cgroup IS the mount root, so the /proc path does not resolve.
          dir=/sys/fs/cgroup
        fi
        if [ -z "$dir" ]; then
          printf 'lint-oxc: lane=%s stage=run memory=unavailable (no readable cgroup v2)\n' "$lint_lane" >&2
          return 0
        fi
        printf 'lint-oxc: lane=%s stage=run cgroup=%s memory.events=[%s] memory.peak=%s memory.max=%s\n' \
          "$lint_lane" "$dir" \
          "$(_lint_cgroup_field "$dir/memory.events")" \
          "$(_lint_cgroup_field "$dir/memory.peak")" \
          "$(_lint_cgroup_field "$dir/memory.max")" >&2
      }

      # oxlint/oxfmt findings go to STDOUT, so "did the tool print anything at
      # all" is what separates a real finding from a tool that died mute — the
      # ambiguity that made a red CI oxlint task unattributable (devenv dumps a
      # failing task's stdout, and there was none). The reported byte count is
      # the SUM of the per-unit counts, so it stays the number of bytes the
      # TOOLS wrote: line-completing newlines are inserted outside the counted
      # stream and never inflate it. Observation uses the same streaming relay
      # for terminal and redirected stdout, so both paths enforce identical unit
      # boundaries and retain identical aggregate diagnostics.
      lint_status=0
      lint_failed_units=0
      lint_first_failed_unit=-
      lint_stdout_bytes=0
      lint_stdout_tail=empty
      lint_probe_dir=$(mktemp -d)
      trap 'rm -f "$files"; rm -rf "$lint_scratch" "$lint_probe_dir"' EXIT
      lint_bytes="$lint_probe_dir/bytes"
      lint_last="$lint_probe_dir/last"
      lint_stdout_fifo="$lint_probe_dir/stdout"
      lint_tail_fifo="$lint_probe_dir/tail"
      _run_lint
      if [ "$lint_status" -ne 0 ]; then
        # `xargs` never forwards the child's own status; translate its documented
        # codes so the line says what actually happened rather than "123".
        lint_hint=""
        case "$lint_status" in
          123) lint_hint=" (xargs: a child command exited 1-125)" ;;
          124) lint_hint=" (xargs: a child command exited 255)" ;;
          125) lint_hint=" (xargs: a child command was killed by a signal)" ;;
          126) lint_hint=" (xargs: command found but not executable)" ;;
          127) lint_hint=" (xargs: command not found)" ;;
        esac
        # The final line was already completed at its unit's output boundary, so
        # nothing is appended here: the reported tail describes what the TOOL
        # wrote, not what reached stdout after completion.
        printf "lint-oxc: lane=%s stage=run status=%s files=%s units=%s failed_units=%s first_failed_unit=%s stdout_bytes=%s stdout_tail=%s command=%s%s\n" \
          "$lint_lane" "$lint_status" "$lint_file_count" "$lint_unit_count" \
          "$lint_failed_units" "$lint_first_failed_unit" "$lint_stdout_bytes" \
          "$lint_stdout_tail" "$lint_cmd_label" "$lint_hint" >&2
        _lint_memory_evidence
        exit "$lint_status"
      fi
    '';

  oxlintIncludeCase = ''
    *.js|*.jsx|*.mjs|*.cjs|*.ts|*.tsx|*.mts|*.cts|*.vue|*.svelte|*.astro)
  '';
  oxfmtIncludeCase = ''
    *.js|*.jsx|*.mjs|*.cjs|*.ts|*.tsx|*.mts|*.cts|*.json|*.jsonc|*.json5|*.yaml|*.yml|*.toml|*.html|*.vue|*.css|*.scss|*.sass|*.less|*.md|*.markdown|*.mdx|*.graphql|*.gql|*.hbs|*.handlebars)
  '';

  # Type-aware linting flags (enabled when tsconfig is provided)
  typeAwareFlags = if tsconfig != null then "--type-aware --tsconfig ${tsconfig}" else "";
  warningsFlag = if denyWarnings then "--deny-warnings" else "";
  resolvedOxfmtPkg = if oxfmtPkg == null then pkgs.oxfmt else oxfmtPkg;

  # Plugin injection is handled by oxlint-with-plugins wrapper on PATH.
  # Consumers should add oxlint-with-plugins to devenv packages instead of
  # passing jsPlugins here.
  #
  # instrName: when set, the concrete oxlint invocation is wrapped with
  # trace.instr { adapter = "oxlint"; } (decision 0018), so otel-scrape owns a
  # named `oxlint` command span beneath the task span and re-renders a human
  # diagnostics summary from `--format=json` (decision 0017). The `--format=json`
  # child flag is gated together with the otel-scrape prefix (via _otel_instr_flags)
  # so a repo without otel-scrape never sees raw JSON on the terminal.
  mkOxlintCmd =
    {
      lane,
      extraFlags ? "",
      instrName ? null,
    }:
    let
      flags = "${warningsFlag} ${extraFlags}";
    in
    mkLintExec {
      inherit lane;
      # oxlint owns the tsgolint program, so both oxlint lanes are partitioned
      # per nearest owning tsconfig.json (see `partition` in mkLintExec).
      partition = true;
      command =
        if instrName != null then
          ''"''${_otel_instr[@]}" oxlint "''${_otel_instr_flags[@]}" --import-plugin ${flags} ${typeAwareFlags}''
        else
          "oxlint --import-plugin ${flags} ${typeAwareFlags}";
      commandLabel = "oxlint --import-plugin ${flags} ${typeAwareFlags}";
      includeCase = oxlintIncludeCase;
      prelude = lib.optionalString (instrName != null) (
        trace.instr {
          adapter = "oxlint";
          name = instrName;
        }
      );
    };

  guardedTasks = {
    "lint:check:format" = {
      guard = "oxfmt";
      description = "Check code formatting with oxfmt";
      # oxfmt exposes no declared structured source (adapters/.experiments/0005),
      # so it opts into otel-scrape as adapter="none" (decision 0018): a timed,
      # named `oxfmt` command span beneath the task span, no parser, stdout
      # untouched. The otel-scrape prefix (_otel_instr) is composed in the OUTER
      # bash and passed through xargs as leading positional args, so oxfmt — not
      # the nested empty-selection helper shell — is the wrapped child (see the
      # emptySelectionDiagnostic branch of mkLintExec). Arrays are empty (command
      # runs bare, empty-selection diagnostic still swallowed) without otel-scrape.
      exec = trace.exec "lint:check:format" (mkLintExec {
        lane = "lint:check:format";
        command = "${resolvedOxfmtPkg}/bin/oxfmt --check";
        includeCase = oxfmtIncludeCase;
        emptySelectionDiagnostic = "Expected at least one target file";
        prelude = trace.instr {
          adapter = "none";
          name = "lint:check:format";
        };
      });
      execIfModified = [ ];
    };
    "lint:check:oxlint" = {
      guard = "oxlint";
      description = "Run oxlint linter";
      exec = trace.exec "lint:check:oxlint" (mkOxlintCmd {
        lane = "lint:check:oxlint";
        instrName = "lint:check:oxlint";
      });
      execIfModified = [ ];
    };
    "lint:fix:format" = {
      guard = "oxfmt";
      description = "Fix code formatting with oxfmt";
      exec = trace.exec "lint:fix:format" (mkLintExec {
        lane = "lint:fix:format";
        command = "${resolvedOxfmtPkg}/bin/oxfmt";
        includeCase = oxfmtIncludeCase;
        emptySelectionDiagnostic = "Expected at least one target file";
      });
    };
    "lint:fix:oxlint" = {
      guard = "oxlint";
      description = "Fix lint issues with oxlint";
      exec = trace.exec "lint:fix:oxlint" (mkOxlintCmd {
        lane = "lint:fix:oxlint";
        extraFlags = "--fix";
      });
    };
  };

  otherTasks = {
    "lint:check:genie" = {
      description = "Check generated files are up to date";
      after = [ "genie:prepare" ];
      env = genieTaskEnv;
      exec = trace.exec "lint:check:genie" "${genieBin} --check";
      execIfModified = geniePatterns;
    };
    "lint:check:genie:coverage" = {
      description = "Check all config files have .genie.ts sources";
      exec = trace.exec "lint:check:genie:coverage" ''
        set -euo pipefail

        scan_dir_args=()
        ${scanDirsSetup}
        pathspec_args=()
        ${excludePathspecsSetup}

        # Enumerate config files via git instead of scanning the filesystem.
        #
        # Rationale:
        # - Avoids traversing huge trees (node_modules) even when excluded.
        # - Correctly checks files that are tracked or about to be committed
        #   (untracked but not ignored).
        # - Prevents false negatives from caching based only on *.genie.ts files.
        files=$(
          {
            ${git} ls-files -- "''${scan_dir_args[@]}" "''${pathspec_args[@]}"
            ${git} ls-files --others --exclude-standard -- "''${scan_dir_args[@]}" "''${pathspec_args[@]}"
          } | sort -u | while IFS= read -r f; do
            if [[ ${coverageFileMatches} ]]; then
              echo "$f"
            fi
          done
        )

        missing=$(echo "$files" | while IFS= read -r f; do
          [ -z "$f" ] && continue
          [ -f "$f.genie.ts" ] || echo "$f"
        done | sort)
        if [ -n "$missing" ]; then
          echo "Missing .genie.ts sources for:"
          echo "$missing"
          exit 1
        fi
        echo "All config files have .genie.ts sources"
      '';
      # Intentionally no execIfModified caching: new unmanaged config files are exactly
      # what this task exists to detect.
    };
    "lint:check:lockfile" = {
      description = "Verify pnpm-lock.yaml matches package.json specifiers without realizing node_modules";
      after = [ lockfileCheckTask ];
    };
    "lint:check" = {
      description = "Run all lint checks";
      after = [
        "lint:check:format"
        "lint:check:oxlint"
        "lint:check:genie"
        "lint:check:genie:coverage"
        "lint:check:lockfile"
      ];
    };
    "lint:fix" = {
      description = "Fix all lint issues";
      after = [
        "lint:fix:format"
        "lint:fix:oxlint"
      ];
    };
  };
in
{
  # Provide tsgolint when type-aware linting is enabled.
  # The oxlint/oxfmt guards own their command names (exec the reals via absolute
  # path, see cli-guard.nix), so oxfmt is dropped as a top-level provider here and
  # oxlint is dropped from the consumer's `packages` — removing the buildEnv
  # collision while keeping both reachable under passthrough.
  packages =
    lib.optionals (tsconfig != null) [ pkgs.tsgolint ]
    ++ cliGuard.fromTasks {
      tasks = guardedTasks;
      reals = {
        oxfmt = resolvedOxfmtPkg;
      }
      // lib.optionalAttrs (oxlintPkg != null) { oxlint = oxlintPkg; };
    };

  tasks = cliGuard.stripGuards (guardedTasks // otherTasks);
}
