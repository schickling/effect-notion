# Nix derivation that builds the gh-ci-utils CLI binary.
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
    name = "gh-ci-utils-unwrapped";
    entry = "packages/@overeng/gh-ci-utils/bin/gh-ci-utils.ts";
    binaryName = "gh-ci-utils";
    packageDir = "packages/@overeng/gh-ci-utils";
    workspaceRoot = src;
    # Managed by the repo FOD refresh workflow — do not edit manually.
    depsBuilds = {
      "." = mkSharedHash "sha256-thdTBRg355193fh0Bmr1R7WvKIGhVcCWZbzHl6wddiU=";
    };
    nativeNodePackages = opentuiCoreNative.packages;
    smokeTestArgs = [ "--version" ];
    inherit gitRev commitTs dirty;
  };
in
pkgs.runCommand "gh-ci-utils"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    meta.mainProgram = "gh-ci-utils";
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
    makeWrapper ${unwrapped}/bin/gh-ci-utils $out/bin/gh-ci-utils
  ''
