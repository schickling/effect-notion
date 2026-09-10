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
    "." = mkSharedHash "sha256-jj55yYV80ajkhA3jnqY4ueIXM0HyDg5rhtFom9bmzUE=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
