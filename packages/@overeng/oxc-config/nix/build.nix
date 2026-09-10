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
    "." = mkSharedHash "sha256-gJGXT5rrqBVS63J8CZFOoAlXOJHnDiQK/TOH0dsF7c4=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
