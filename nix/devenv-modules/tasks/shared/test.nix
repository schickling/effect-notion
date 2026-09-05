# Test tasks (vitest)
#
# Self-contained test tasks that run in package cwd while resolving Vitest from
# the installed package graph directly.
#
# Usage in devenv.nix:
#   # Per-package tests (recommended):
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.test {
#       packages = [
#         { path = "packages/@overeng/genie"; name = "genie"; }
#         { path = "packages/@overeng/tui-core"; name = "tui-core"; }
#       ];
#       # Optional: install task name (default: "pnpm:install")
#       installTask = "pnpm:install";
#     })
#   ];
#
#   # Simple tests (no per-package):
#   imports = [ (inputs.effect-utils.devenvModules.tasks.test {}) ];
#
#   # Bound package-level fan-out for large repos / constrained CI runners:
#   imports = [ (inputs.effect-utils.devenvModules.tasks.test { packageConcurrency = 4; }) ];
#
# Each package must have:
#   - vitest as a devDependency in package.json
#   - vitest.config.ts in the package root
#   - optional `after = [ ... ]` for package-specific prerequisites
#
# Provides:
#   - test:run - Run all tests
#   - test:watch - Run tests in watch mode
#   - test:<name> - Run tests for specific package (when packages provided)
{
  targets ? [ ],
  packages ? [ ],
  legacy ? false,
  installTask ? "pnpm:install",
  extraTests ? [ ],
  packageConcurrency ? null,
  retainVitestJson ? false,
  buckAfter ? [ ],
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
  pnpmTaskHelpersScript = pkgs.writeText "pnpm-task-helpers.sh" (
    builtins.readFile ./pnpm-task-helpers.sh
  );
  hasPackages = packages != [ ];
  buckTaskName = target: "test:${target.name}";
  # Each capability is a `--config test_capabilities.<key>=<immutable path>`
  # argument, so a lane's executable inputs stay declared instead of ambient.
  capabilityArgs =
    target:
    lib.concatMap (key: [
      "--config"
      "test_capabilities.${key}=${target.capabilities.${key}}"
    ]) (lib.attrNames (target.capabilities or { }));
  mkBuckTask = target: {
    "${buckTaskName target}" = {
      description = "Run ${target.name} tests through Buck";
      after = buckAfter ++ (target.after or [ ]);
      exec = trace.exec (buckTaskName target) ''
        set -euo pipefail
        root="''${DEVENV_ROOT:-$PWD}"
        workspace_root="$(${pkgs.coreutils}/bin/realpath "$root/../..")"
        exec "$workspace_root/.megarepo/bin/buck2" test ${
          lib.escapeShellArgs ([ target.label ] ++ capabilityArgs target)
        }
      '';
    };
  };
  buckTasks = lib.mkMerge (
    (map mkBuckTask targets)
    ++ [
      {
        "test:run" = {
          description = "Run all Buck-owned JavaScript tests";
          after = map buckTaskName targets ++ extraTests;
        };
      }
    ]
  );
  hasPackageConcurrency = packageConcurrency != null;
  validatedPackageConcurrency =
    if hasPackageConcurrency && packageConcurrency < 1 then
      throw "packageConcurrency must be at least 1"
    else
      packageConcurrency;
  packagesWithIndexes = lib.imap0 (index: pkg: pkg // { __testIndex = index; }) packages;
  taskFileStem =
    taskName:
    builtins.replaceStrings
      [
        ":"
        "/"
        " "
        "."
      ]
      [
        "-"
        "-"
        "-"
        "_"
      ]
      taskName;

  # Do not force preserve-symlinks here. pnpm's projected workspace graph
  # relies on realpath-based resolution, and preserve-symlinks caused Vitest to
  # miss hoisted dependencies in CI.
  #
  # The concrete vitest binary is instrumented with trace.instr (decision 0018):
  # otel-scrape owns a named command span beneath the task span and consumes the
  # vitest `--reporter=json` SIDE-CHANNEL it injects itself (decision 0017), so the
  # human reporter output stays on the terminal unchanged. `run_package_bin` is a
  # shell function, so it is resolved to a real bin path first (experiment 0007)
  # and otel-scrape wraps that path directly. When retainVitestJson is enabled,
  # the managed task owns the JSON output path, so otel-scrape reads but does not
  # delete the job-local report. Its public summary remains counts-only.
  vitestExec =
    {
      name,
      extraArgs ? "",
    }:
    ''
      set -euo pipefail
      export PNPM_LEGACY_NODE_MODULES=1
      source ${lib.escapeShellArg pnpmTaskHelpersScript}
      ${trace.instr {
        adapter = "vitest";
        inherit name;
      }}
      _vitest_collection_args=()
      ${lib.optionalString retainVitestJson ''
        _vitest_collection_dir="''${VITEST_COLLECTION_REPORT_DIR:-''${DEVENV_ROOT:-$PWD}/tmp/otel-scrape/summaries}"
        mkdir -p "$_vitest_collection_dir"
        _vitest_collection_args=(
          --reporter=default
          --reporter=json
          "--outputFile.json=$_vitest_collection_dir/${taskFileStem name}.vitest.json"
        )
      ''}
      "''${_otel_instr[@]}" "$(resolve_package_bin vitest vitest)" run --testTimeout 30000 --hookTimeout 30000 "''${_vitest_collection_args[@]}" ${extraArgs}
    '';
  vitestWatchExec = ''
    set -euo pipefail
    export PNPM_LEGACY_NODE_MODULES=1
    source ${lib.escapeShellArg pnpmTaskHelpersScript}
    run_package_bin vitest vitest
  '';

  # Per-package test task using the workspace-aware vitest entrypoint.
  chunkList =
    size: items:
    if items == [ ] then [ ] else [ (lib.take size items) ] ++ chunkList size (lib.drop size items);

  packageTestTaskNames = map (pkg: "test:${pkg.name}") packages;
  packageTestBatches =
    if hasPackageConcurrency then chunkList validatedPackageConcurrency packageTestTaskNames else [ ];
  packageTestBatchTaskName = index: "test:run:batch:${toString index}";
  lastPackageTestBatchTaskName = packageTestBatchTaskName (builtins.length packageTestBatches - 1);

  mkTestTask =
    pkg:
    let
      batchIndex =
        if hasPackageConcurrency then builtins.div pkg.__testIndex validatedPackageConcurrency else 0;
    in
    {
      "test:${pkg.name}" = {
        description = "Run tests for ${pkg.name}";
        exec = trace.exec "test:${pkg.name}" (vitestExec {
          name = "test:${pkg.name}";
          extraArgs = pkg.vitestArgs or "";
        });
        cwd = pkg.path;
        execIfModified = [
          "${pkg.path}/src/**/*.ts"
          "${pkg.path}/src/**/*.tsx"
          "${pkg.path}/src/**/*.test.ts"
          "${pkg.path}/src/**/*.test.tsx"
          "${pkg.path}/test/**/*.ts"
          "${pkg.path}/test/**/*.tsx"
          "${pkg.path}/test/**/*.test.ts"
          "${pkg.path}/test/**/*.test.tsx"
          "${pkg.path}/vitest.config.ts"
        ];
        after = [
          installTask
        ]
        ++ (pkg.after or [ ])
        ++ lib.optional (hasPackageConcurrency && batchIndex > 0) (
          packageTestBatchTaskName (batchIndex - 1)
        );
      };
    };

  mkPackageTestBatchTask = index: taskNames: {
    "${packageTestBatchTaskName index}" = {
      description = "Complete test:run package batch ${toString (index + 1)}";
      after = taskNames;
    };
  };

  guardedTasks = {
    "test:run" = {
      guard = "vitest";
      description = "Run all tests";
      exec =
        if hasPackages then
          null
        else
          trace.exec "test:run" (vitestExec {
            name = "test:run";
          });
      after =
        if hasPackages then
          if hasPackageConcurrency then
            [ lastPackageTestBatchTaskName ] ++ extraTests
          else
            map (pkg: "test:${pkg.name}") packages ++ extraTests
        else
          [ "genie:run" ];
    };
    "test:watch" = {
      guard = "vitest";
      description = "Run tests in watch mode";
      exec = trace.exec "test:watch" vitestWatchExec;
      after = [ "genie:run" ];
    };
  };
in
assert lib.assertMsg (
  legacy || targets != [ ]
) "test.nix Buck mode requires at least one explicit target";
if legacy then
  {
    packages = cliGuard.fromTasks guardedTasks;

    tasks = lib.mkMerge (
      (if hasPackages then map (pkg: cliGuard.stripGuards (mkTestTask pkg)) packagesWithIndexes else [ ])
      ++ (
        if hasPackages && hasPackageConcurrency then
          lib.imap0 mkPackageTestBatchTask packageTestBatches
        else
          [ ]
      )
      ++ [ (cliGuard.stripGuards guardedTasks) ]
    );
  }
else
  {
    tasks = buckTasks;
  }
