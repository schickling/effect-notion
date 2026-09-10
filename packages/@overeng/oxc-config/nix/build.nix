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
    "." = mkSharedHash "sha256-4M7mb0gpWOWAxcMq1QCU7Scov7IazrcSOblif7YtQzc=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
