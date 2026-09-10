# Minimal lint tasks using only genie (no oxlint/oxfmt)
#
# Usage in devenv.nix:
#   imports = [
#     inputs.effect-utils.devenvModules.tasks.lint-genie
#   ];
#
# Provides: lint:check, lint:check:genie, lint:fix
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
  megarepoStoreEnv = builtins.getEnv "MEGAREPO_STORE";
  genieTaskEnv = lib.optionalAttrs (megarepoStoreEnv != "") {
    MEGAREPO_STORE = megarepoStoreEnv;
  };
in
{
  tasks = cliGuard.stripGuards {
    "lint:check:genie" = {
      description = "Check generated files are up to date";
      after = [ "genie:prepare" ];
      env = genieTaskEnv;
      exec = trace.exec "lint:check:genie" "genie --check";
    };
    "lint:check:lockfile" = {
      description = "Verify pnpm-lock.yaml matches package.json specifiers";
      after = [ "pnpm:install" ];
      exec = trace.exec "lint:check:lockfile" ''
        set -euo pipefail
        store_dir="''${npm_config_store_dir:-''${PNPM_CONFIG_STORE_DIR:-''${PNPM_STORE_DIR:-$PWD/.devenv/pnpm-store}}}"
        export PNPM_STORE_DIR="$store_dir"
        export PNPM_CONFIG_STORE_DIR="$store_dir"
        export npm_config_store_dir="$store_dir"
        pnpm install \
          --frozen-lockfile \
          --ignore-scripts \
          --config.side-effects-cache=false \
          --config.verify-store-integrity=true \
          --config.strict-store-pkg-content-check=true \
          --config.package-import-method=clone-or-copy \
          --pm-on-fail=ignore \
          --config.store-dir="$store_dir"
      '';
    };
    "lint:check" = {
      description = "Run all lint checks";
      after = [
        "lint:check:genie"
        "lint:check:lockfile"
      ];
    };
    "lint:fix" = {
      description = "Fix all lint issues (no formatter configured)";
      exec = trace.exec "lint:fix" "echo 'No lint fixer configured'";
    };
  };
}
