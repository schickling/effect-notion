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
    "." = mkSharedHash "sha256-Up0OPsV6DAlgYWs0ACQ720qY2y8uy0uqar57NN5Jo4g=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
