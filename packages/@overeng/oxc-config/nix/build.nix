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
    "." = mkSharedHash "sha256-359VOQgSq3hg36ruK/7lOWqln56LPxbpaiJWndO9bRg=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
