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
    "." = mkSharedHash "sha256-QLSp+u0wPMj8Ff94G2fLlZ1jhAFqykufLHocmMiuJUo=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
