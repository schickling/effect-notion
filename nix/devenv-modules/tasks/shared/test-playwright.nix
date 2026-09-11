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
  packages,
  installTask ? "pnpm:install",
  playwrightBin ? "playwright",
  playwrightPkg ? null,
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

  guardedTasks = {
    "test:pw:run" = {
      guard = playwrightBin;
      description = "Run all playwright e2e tests";
      after = map (pkg: "test:pw:${pkg.name}") packages;
    };
  };

in
{
  packages = cliGuard.fromTasks {
    tasks = guardedTasks;
    reals = lib.optionalAttrs (playwrightPkg != null) { playwright = playwrightPkg; };
  };

  tasks = lib.mkMerge (
    map (pkg: cliGuard.stripGuards (mkTestTask pkg)) packages ++ [ (cliGuard.stripGuards guardedTasks) ]
  );
}
