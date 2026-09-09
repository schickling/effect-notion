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
    "." = mkSharedHash "sha256-OQiVaKug+jdCzmi9SO2m0Ax00XJS/+orS5apjjRcXH0=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
