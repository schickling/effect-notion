# Nix derivation that builds megarepo CLI binary.
# Uses bun build --compile for native platform.
#
# TODO: Move shell completion generation into mkPnpmCli helper
# so all CLIs get completions automatically.
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
  buck2 = import ../../../../nix/buck2.nix { inherit pkgs; };
  compositionPlatform = if pkgs.stdenv.hostPlatform.isDarwin then "darwin" else "linux";
  base = mkPnpmCli {
    name = "megarepo";
    entry = "packages/@overeng/megarepo/bin/mr.ts";
    binaryName = "mr";
    packageDir = "packages/@overeng/megarepo";
    workspaceRoot = src;
    # Managed by the repo FOD refresh workflow — do not edit manually.
    depsBuilds = {
      "." = mkSharedHash "sha256-5mB8LomPP4+v3UjzecPOxnUED/q+tW83C+zLgmoRCs4=";
    };
    nativeNodePackages = opentuiCoreNative.packages;
    smokeTestArgs = [ "--help" ];
    inherit gitRev commitTs dirty;
  };
in
pkgs.stdenv.mkDerivation {
  pname = "megarepo-with-completions";
  version = base.version or "0.0.0";
  meta.mainProgram = "mr";
  passthru = {
    inherit (base.passthru)
      depsBuildEntries
      depsBuildsByInstallRoot
      fodHashRepairTargets
      installRoots
      ;
  };

  nativeBuildInputs = [ pkgs.makeWrapper ];
  phases = [ "installPhase" ];

  installPhase = ''
    mkdir -p $out/bin
    makeWrapper ${base}/bin/mr $out/bin/mr \
      --set MR_COMPOSITION_CP_BIN ${pkgs.coreutils}/bin/cp \
      --set MR_COMPOSITION_BUCK2_BIN ${buck2}/bin/buck2 \
      --set MR_COMPOSITION_BUCK2_PROTOCOL facebook/buck2-cli/2026-09-01 \
      --set MR_COMPOSITION_SYSTEM ${pkgs.stdenv.hostPlatform.system} \
      --set MR_COMPOSITION_PLATFORM ${compositionPlatform} \
      --set MR_COMPOSITION_GIT_BIN ${pkgs.git}/bin/git \
      --set MR_CAPABILITY_NIX_BIN ${pkgs.nix}/bin/nix \
      --set MR_CAPABILITY_MV_BIN ${pkgs.coreutils}/bin/mv \
      --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.watchman ]}

    # Generate shell completions
    # TODO: Move this into mkBunCli helper
    mkdir -p $out/share/fish/vendor_completions.d
    mkdir -p $out/share/bash-completion/completions
    mkdir -p $out/share/zsh/site-functions

    $out/bin/mr --completions fish > $out/share/fish/vendor_completions.d/mr.fish
    $out/bin/mr --completions bash > $out/share/bash-completion/completions/mr
    $out/bin/mr --completions zsh > $out/share/zsh/site-functions/_mr
  '';
}
