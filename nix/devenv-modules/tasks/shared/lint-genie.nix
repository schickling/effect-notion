# Minimal lint tasks using only genie (no oxlint/oxfmt)
#
# Requires an explicit packaged Genie product; it never resolves Genie or pnpm
# from PATH and delegates lock freshness to the install-free pnpm lock task.
{
  geniePkg,
  lockfileCheckTask ? "pnpm:check-lockfile",
}:
{ lib, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  genieBin = "${geniePkg}/bin/genie";
  megarepoStoreEnv = builtins.getEnv "MEGAREPO_STORE";
  genieTaskEnv = lib.optionalAttrs (megarepoStoreEnv != "") {
    MEGAREPO_STORE = megarepoStoreEnv;
  };
in
{
  tasks = {
    "lint:check:genie" = {
      description = "Check generated files are up to date";
      after = [ "genie:prepare" ];
      env = genieTaskEnv;
      exec = trace.exec "lint:check:genie" "${genieBin} --check";
    };
    "lint:check:lockfile" = {
      description = "Verify pnpm-lock.yaml matches package.json specifiers without realizing node_modules";
      after = [ lockfileCheckTask ];
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
