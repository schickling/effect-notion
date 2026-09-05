# Live Restate integration task. The Buck target owns its package tree and
# explicitly declares the native server, loopback, and writable-state boundaries.
{
  target,
  restateServerBin,
  after ? [ ],
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
in
{
  tasks."test:restate-integration" = {
    description = "Run the explicitly capability-bearing Restate integration target";
    inherit after;
    exec = trace.exec "test:restate-integration" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      workspace_root="$(${pkgs.coreutils}/bin/realpath "$root/../..")"
      exec "$workspace_root/.megarepo/bin/buck2" test \
        --config ${lib.escapeShellArg "test_capabilities.restate-server=${toString restateServerBin}"} \
        ${lib.escapeShellArg target}
    '';
  };
}
