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
    "." = mkSharedHash "sha256-+DAahk1Zva/5BbTXP+7VM/wEl5QJw9b5RKUKbD0F2dw=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
