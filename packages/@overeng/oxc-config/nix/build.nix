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
    "." = mkSharedHash "sha256-hfC8sNg8ajhiA+QVq4JcjLu+3NzI2z0FfTddXyGT2fU=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
