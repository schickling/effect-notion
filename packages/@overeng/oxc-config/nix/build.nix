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
    "." = mkSharedHash "sha256-ijW7sb1riXn/gNoCKRB4RN45OwjkWrUx3ZHUi289rGg=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
