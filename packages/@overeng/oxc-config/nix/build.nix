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
    "." = mkSharedHash "sha256-Axu1Fjr0lMqlYbNYk2dUyBAdfMBQXe0OQh9/E5+LibA=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
