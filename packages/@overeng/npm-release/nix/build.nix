# Nix derivation that builds the npm-release CLI binary.
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
  unwrapped = mkPnpmCli {
    name = "npm-release-unwrapped";
    entry = "packages/@overeng/npm-release/src/cli.ts";
    binaryName = "npm-release";
    packageDir = "packages/@overeng/npm-release";
    workspaceRoot = src;
    # Managed by the repo FOD refresh workflow — do not edit manually.
    depsBuilds = {
      "." = mkSharedHash "sha256-z4vo3uTnkUt20ampAe1ZbbgJSq+4GXNajPs3pymABV4=";
    };
    smokeTestArgs = [ "--help" ];
    inherit gitRev commitTs dirty;
  };
in
pkgs.runCommand "npm-release"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    meta.mainProgram = "npm-release";
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
    # The CLI shells out to `npm`, so the wrapper guarantees node/npm on PATH rather
    # than inheriting whatever the calling repo happens to expose.
    makeWrapper ${unwrapped}/bin/npm-release $out/bin/npm-release \
      --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.nodejs ]}
  ''
