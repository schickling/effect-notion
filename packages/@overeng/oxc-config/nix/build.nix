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
    "." = mkSharedHash "sha256-Mi5gK1ZRBeCS8mbsPVIwXXmBGuDUyuar1T5WZbUMS+Y=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
