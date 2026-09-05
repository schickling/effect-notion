# Live Notion integration tasks. The referenced Buck targets own their package
# trees and explicitly declare secret, network, and writable-state capabilities.
{
  targets,
  after ? [ ],
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  taskName = target: "test:notion-integration:${target.name}";
  mkTask = target: {
    "${taskName target}" = {
      description = "Run ${target.name} live Notion integration tests through Buck";
      after = after ++ (target.after or [ ]);
      exec = trace.exec (taskName target) ''
        set -euo pipefail
        root="''${DEVENV_ROOT:-$PWD}"
        workspace_root="$(${pkgs.coreutils}/bin/realpath "$root/../..")"
        exec "$workspace_root/.megarepo/bin/buck2" test ${lib.escapeShellArg target.label}
      '';
    };
  };
in
{
  tasks = lib.mkMerge (
    (map mkTask targets)
    ++ [
      {
        "test:notion-integration" = {
          description = "Run all explicitly capability-bearing Notion integration targets";
          after = map taskName targets;
        };
      }
    ]
  );
}
