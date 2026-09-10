# Aggregate check tasks
#
# Usage in devenv.nix:
#   # With unit tests (default):
#   imports = [ (inputs.effect-utils.devenvModules.tasks.check {}) ];
#
#   # With unit tests and playwright e2e tests:
#   imports = [ (inputs.effect-utils.devenvModules.tasks.check { hasPlaywright = true; }) ];
#
#   # Without any tests:
#   imports = [ (inputs.effect-utils.devenvModules.tasks.check { hasTests = false; }) ];
#
#   # Without lint (for repos not using lint-oxc module yet):
#   imports = [ (inputs.effect-utils.devenvModules.tasks.check { hasTests = false; hasLint = false; }) ];
#
#   # Without nix checks (for repos without Nix CLI builds):
#   imports = [ (inputs.effect-utils.devenvModules.tasks.check { hasNixCheck = false; }) ];
#
#   # Without megarepo checks (for repos that skip members in CI):
#   imports = [ (inputs.effect-utils.devenvModules.tasks.check { hasMegarepoCheck = false; }) ];
#
#   # With strict type checking in aggregate gates:
#   imports = [ (inputs.effect-utils.devenvModules.tasks.check { checkAllTypecheckTask = "ts:check:strict"; }) ];
#
#   # With a Buck-owned typecheck gate instead of the root tsc solution:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.check {
#       checkQuickTypecheckTask = "buck2:check";
#       # Residual root-tsc projects still need a gate, but only in check:quick;
#       # extraChecks would drag them into check:all as well.
#       extraQuickChecks = [ "ts:check" ];
#     })
#   ];
#
#   # With additional custom checks (both gates):
#   imports = [ (inputs.effect-utils.devenvModules.tasks.check { extraChecks = [ "workspace:check" ]; }) ];
#
# Provides: check:quick, check:all
#
# check:quick - Fast local development (typecheck gate, mr:check*, lint, nix-fingerprint)
# check:all   - Comprehensive validation (defaults to the check:quick typecheck
#               task, can opt into ts:check:strict)
#               * mr:check included unless hasMegarepoCheck = false
#
# Note: Requires the configured typecheck task to exist (default ts:check).
# Requires lint:check task (unless hasLint = false).
# Requires nix-cli module tasks (unless hasNixCheck = false):
#   - check:quick uses nix:check:quick
#   - check:all uses nix:flake:check
# check:all requires test:run (unless hasTests = false).
# check:all requires test:pw:run (if hasPlaywright = true).
{
  hasTests ? true,
  hasPlaywright ? false,
  hasLint ? true,
  hasNixCheck ? true,
  hasMegarepoCheck ? true,
  checkQuickTypecheckTask ? "ts:check",
  checkAllTypecheckTask ? checkQuickTypecheckTask,
  extraChecks ? [ ], # Additional check tasks for BOTH gates (e.g., [ "workspace:check" ])
  extraQuickChecks ? [ ], # Additional check tasks for check:quick ONLY (e.g., [ "ts:check" ])
}:
{ lib, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  lintTask = lib.optional hasLint "lint:check";
  nixQuickTask = lib.optionals hasNixCheck [ "nix:check:quick" ];
  nixFullTask = lib.optionals hasNixCheck [ "nix:flake:check" ];
  testTasks = lib.optionals hasTests ([ "test:run" ] ++ lib.optional hasPlaywright "test:pw:run");
  megarepoTasks = lib.optionals hasMegarepoCheck [
    "mr:check"
    "mr:lock-sync-check"
    "mr:source-policy-check"
  ];

  # Build description parts
  descParts =
    lib.optionals hasLint [ "lint" ]
    ++ lib.optionals hasNixCheck [ "nix" ]
    ++ lib.optionals hasTests [ "test" ]
    ++ lib.optionals hasPlaywright [ "e2e" ];
  extraDesc = if descParts != [ ] then ", ${lib.concatStringsSep ", " descParts}" else "";
in
{
  tasks = {
    "check:quick" = {
      description = "Fast checks for development (${
        lib.concatStringsSep ", " ([ checkQuickTypecheckTask ] ++ extraQuickChecks)
      }${lib.optionalString hasLint ", lint"}${
        lib.optionalString hasNixCheck ", nix-fingerprint"
      }) without tests";
      exec = trace.exec "check:quick" "true";
      after =
        [ checkQuickTypecheckTask ]
        ++ extraQuickChecks
        ++ megarepoTasks
        ++ lintTask
        ++ nixQuickTask
        ++ extraChecks;
    };

    "check:all" = {
      description = "All checks (${checkAllTypecheckTask}${extraDesc})";
      exec = trace.exec "check:all" "true";
      after = [
        checkAllTypecheckTask
      ]
      ++ megarepoTasks
      ++ extraChecks
      ++ lintTask
      ++ nixFullTask
      ++ testTasks;
    };

    # Traced convenience wrappers: run the aggregate check under a FRESH root
    # trace and print its Grafana link. otel-run (otel devenv module) mints the
    # root, so these execs stay BARE — wrapping them in trace.exec would emit an
    # outer span in the ambient trace and defeat the fresh root. Requires the
    # otel devenv module (provides otel-run on PATH).
    "check:quick:trace" = {
      description = "Run check:quick under a fresh root trace and print its Grafana link";
      # trace-audit-allow: raw exec - otel-run intentionally owns the fresh root trace.
      exec = "otel-run devenv tasks run check:quick";
    };

    "check:all:trace" = {
      description = "Run check:all under a fresh root trace and print its Grafana link";
      # trace-audit-allow: raw exec - otel-run intentionally owns the fresh root trace.
      exec = "otel-run devenv tasks run check:all";
    };
  };
}
