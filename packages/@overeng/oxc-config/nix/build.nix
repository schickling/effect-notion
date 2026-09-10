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
    "." = mkSharedHash "sha256-d6Av0LdBO2SDPAoJmBUa4q16skbEhWxh6yNgjM6B28g=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
