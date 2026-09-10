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
    "." = mkSharedHash "sha256-wdmBPM/Ya9liutIY8Cs7W8UrwdUkl2atnB0WCZ4RxAg=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
