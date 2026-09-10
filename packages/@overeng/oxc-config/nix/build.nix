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
    "." = mkSharedHash "sha256-Ynf/1Q0dNquIBgyLXXEOv1itWA8DpJeOMc5wRt/W6rg=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
