{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };

  devenvModuleTestsScript = pkgs.writeShellScript "devenv-module-tests" ''
    set -euo pipefail

    testDir="$PWD/nix/devenv-modules/tasks/shared/tests"
    if [ ! -d "$testDir" ]; then
      echo "No devenv module tests found (missing $testDir)"
      exit 1
    fi

    found=false
    for testFile in "$testDir"/*.test.sh; do
      [ -f "$testFile" ] || continue
      found=true
      echo "Running $testFile"
      NIX_FLAKE_REF="git+file://$PWD" BASH_BIN=${pkgs.bashNonInteractive}/bin/bash ${pkgs.bashNonInteractive}/bin/bash "$testFile"
    done

    if [ "$found" != true ]; then
      echo "No devenv module tests found in $testDir"
      exit 1
    fi
  '';
in
{
  tasks."devenv-modules:test" = {
    description = "Run shell tests for shared devenv task modules";
    exec = trace.exec "devenv-modules:test" "${devenvModuleTestsScript}";
  };
}
