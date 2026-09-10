# Nix derivation that builds tui-stories CLI binary.
# Uses bun build --compile for native platform.
{
  pkgs,
  src,
  gitRev ? "unknown",
  commitTs ? 0,
  dirty ? false,
}:

let
  mkSharedHash = hash: { inherit hash; };
  pnpm = import ../../../../nix/pnpm.nix { inherit pkgs; };
  mkPnpmCli = import ../../../../nix/workspace-tools/lib/mk-pnpm-cli.nix { inherit pkgs pnpm; };
  opentuiCoreNative = import ../../../../nix/opentui-core-native.nix { inherit pkgs; };
  unwrapped = mkPnpmCli {
    name = "tui-stories-unwrapped";
    entry = "packages/@overeng/tui-stories/bin/tui-stories.tsx";
    binaryName = "tui-stories";
    packageDir = "packages/@overeng/tui-stories";
    workspaceRoot = src;
    # Managed by the repo FOD refresh workflow — do not edit manually.
    depsBuilds = {
      "." = mkSharedHash "sha256-cBPNTtxrH82yCH0WvWF2tSArDqOxqoPzhTYxvEuw8xg=";
    };
    nativeNodePackages = opentuiCoreNative.packages;
    inherit gitRev commitTs dirty;
  };
in
pkgs.runCommand "tui-stories"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    meta.mainProgram = "tui-stories";
    passthru = {
      inherit (unwrapped.passthru)
        depsBuildEntries
        depsBuildsByInstallRoot
        fodHashRepairTargets
        installRoots
        ;
    };
  }
  ''
    mkdir -p $out/bin
    makeWrapper ${unwrapped}/bin/tui-stories $out/bin/tui-stories
  ''
