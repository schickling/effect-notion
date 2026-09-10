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
    "." = mkSharedHash "sha256-8ss6IlcrDsrDypmbQC5/0mQmNLMzKf026ZJWF1KRX8o=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
