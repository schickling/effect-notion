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
    "." = mkSharedHash "sha256-wIcUXEuI8MErnd+0jEK6Xu9E+UsAsZ58BBFSkVkN3HY=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
