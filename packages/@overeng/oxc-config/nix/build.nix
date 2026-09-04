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
    "." = mkSharedHash "sha256-Dmdb2G1Lh6hKLaFZrQFYgMzLgfbvejNAS3Jpj/RRw4Q=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
