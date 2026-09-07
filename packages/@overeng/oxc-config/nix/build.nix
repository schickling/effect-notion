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
    "." = mkSharedHash "sha256-E2lWxIEZOLCpQTV+bDW/yf5ZcS0o0qmato4iYQP5QQ0=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
