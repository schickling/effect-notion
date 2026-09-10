{
  pkgs,
  bun,
  src,
}:
let
  mkSharedHash = hash: { inherit hash; };
in
import ../../../../nix/oxc-config-plugin.nix {
  inherit
    pkgs
    bun
    src
    ;
  # Managed by Evergreen FOD refresh — do not edit manually.
  depsBuilds = {
    "." = mkSharedHash "sha256-2H7WPDV0LVdMb1Buc7ogXFh3eMLfX/atgyT/zQ/ciNU=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
