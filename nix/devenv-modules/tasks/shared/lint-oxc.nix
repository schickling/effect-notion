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
      emptySelectionDiagnostic ? null,
      # Optional shell prelude injected before the file scan (e.g. trace.instr,
      # which defines the _otel_instr / _otel_instr_flags arrays the command uses).
      prelude ? "",
    }:
    ''
      set -euo pipefail
      ${prelude}
      lint_pathspec_args=()
      ${lintPathspecsSetup}

      files=$(mktemp)
      trap 'rm -f "$files"' EXIT
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

        ${
          if emptySelectionDiagnostic == null then
            "${pkgs.findutils}/bin/xargs -0 ${command} < \"$files\""
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
                "''${#_otel_instr[@]}" "''${_otel_instr[@]}" < "$files"
            ''
        }
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
      extraFlags ? "",
      instrName ? null,
    }:
    let
      flags = "${warningsFlag} ${extraFlags}";
    in
    mkLintExec {
      command =
        if instrName != null then
          ''"''${_otel_instr[@]}" oxlint "''${_otel_instr_flags[@]}" --import-plugin ${flags} ${typeAwareFlags}''
        else
          "oxlint --import-plugin ${flags} ${typeAwareFlags}";
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
        instrName = "lint:check:oxlint";
      });
      execIfModified = [ ];
    };
    "lint:fix:format" = {
      guard = "oxfmt";
      description = "Fix code formatting with oxfmt";
      exec = trace.exec "lint:fix:format" (mkLintExec {
        command = "${resolvedOxfmtPkg}/bin/oxfmt";
        includeCase = oxfmtIncludeCase;
        emptySelectionDiagnostic = "Expected at least one target file";
      });
    };
    "lint:fix:oxlint" = {
      guard = "oxlint";
      description = "Fix lint issues with oxlint";
      exec = trace.exec "lint:fix:oxlint" (mkOxlintCmd {
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
