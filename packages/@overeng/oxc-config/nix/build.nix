{
  pkgs,
  bun,
  src,
}:
import ../../../../nix/oxc-config-plugin.nix {
  inherit
    pkgs
    bun
    src
    ;
  # CI-diagnosed snapshot. This standalone plugin does not expose Evergreen's `hashPath`
  # repair metadata, so refresh this exact hash from the failing Nix annotation until the
  # retained source FOD is deleted.
  depsBuilds.".".hash = "sha256-uJfH47FdD9KBh9mvRylt7E7ATDJvuT7VrUBVqk0Bx8U=";
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
