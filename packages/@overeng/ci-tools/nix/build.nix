# Nix derivation that builds the ci-tools CLI binary.
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
  unwrapped = mkPnpmCli {
    name = "ci-tools-unwrapped";
    entry = "packages/@overeng/ci-tools/bin/ci-tools.ts";
    binaryName = "ci-tools";
    packageDir = "packages/@overeng/ci-tools";
    workspaceRoot = src;
    # Managed by the repo FOD refresh workflow — do not edit manually.
    depsBuilds = {
      "." = mkSharedHash "sha256-NjgiVIzri3n5MFeW02QwWjY91zk0jX0ewC0BqFbDCUw=";
    };
    smokeTestArgs = [ "--help" ];
    inherit gitRev commitTs dirty;
  };
in
pkgs.runCommand "ci-tools"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    meta.mainProgram = "ci-tools";
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
    makeWrapper ${unwrapped}/bin/ci-tools $out/bin/ci-tools
  ''
