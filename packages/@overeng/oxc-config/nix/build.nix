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
    "." = mkSharedHash "sha256-Ff7jlXqzUjCyFWBOO7Xb2BFaRkHzTn7LEUteyIgumns=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
