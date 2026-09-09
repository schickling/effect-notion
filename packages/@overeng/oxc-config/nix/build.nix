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
    "." = mkSharedHash "sha256-sy2q+BqL/fq0Cd8286T8SJGMF7r0de4W7jkyyZZMx20=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
