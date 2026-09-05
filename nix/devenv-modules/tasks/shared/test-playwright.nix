# Playwright e2e test tasks
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.test-playwright {
#       packages = [
#         { path = "apps/misc.schickling.dev"; name = "misc"; installName = "misc-schickling-dev"; }
#       ];
#       # Optional: install task name (default: "pnpm:install")
#       installTask = "pnpm:install";
#       # Optional: custom playwright binary (default: playwright)
#       playwrightBin = "node_modules/.bin/playwright";
#     })
#   ];
#
# Provides:
#   - test:pw:run - Run all playwright tests
#   - test:pw:<name> - Run playwright tests for specific package
{
  targets ? [ ],
  packages ? [ ],
  legacy ? false,
  installTask ? "pnpm:install",
  playwrightBin ? "playwright",
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };

  mkTestTask = pkg: {
    "test:pw:${pkg.name}" = {
      description = "Run playwright tests for ${pkg.name}";
      exec = trace.exec "test:pw:${pkg.name}" "${playwrightBin} test";
      cwd = pkg.path;
      after = [ installTask ];
    };
  };
  mkBuckTestTask = target: {
    "test:pw:${target.name}" = {
      description = "Run Playwright tests for ${target.name} through Buck";
      after = target.after or [ ];
      exec = trace.exec "test:pw:${target.name}" ''
        set -euo pipefail
        root="''${DEVENV_ROOT:-$PWD}"
        workspace_root="$(${pkgs.coreutils}/bin/realpath "$root/../..")"
        exec "$workspace_root/.megarepo/bin/buck2" test ${lib.escapeShellArg target.label}
      '';
    };
  };

  guardedTasks = {
    "test:pw:run" = {
      guard = playwrightBin;
      description = "Run all playwright e2e tests";
      after = map (pkg: "test:pw:${pkg.name}") packages;
    };
  };

in
assert lib.assertMsg (
  legacy || targets != [ ]
) "test-playwright.nix Buck mode requires at least one explicit target";
if legacy then
  {
    packages = cliGuard.fromTasks guardedTasks;
    tasks = lib.mkMerge (
      map (pkg: cliGuard.stripGuards (mkTestTask pkg)) packages ++ [ (cliGuard.stripGuards guardedTasks) ]
    );
  }
else
  {
    tasks = lib.mkMerge (
      (map mkBuckTestTask targets)
      ++ [
        {
          "test:pw:run" = {
            description = "Run all declared Buck-owned Playwright tests";
            after = map (target: "test:pw:${target.name}") targets;
          };
        }
      ]
    );
  }
