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
    "." = mkSharedHash "sha256-ViK5HAuPjeoQdMTVno49vCg/4b0y/NpkEfsVuxUxq4Y=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
