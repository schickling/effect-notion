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
    "." = mkSharedHash "sha256-3MnLbvxZ6n4VbBpnUEY+n7n28JIHb0MnIjMwbVwbQO8=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
