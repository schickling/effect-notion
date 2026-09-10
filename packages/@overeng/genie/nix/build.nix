# Nix derivation that builds genie CLI binary.
# Uses bun build --compile for native platform.
#
# The CLI calls the executable oxfmt interface; the wrapper appends the Nix
# package to PATH so generated-file formatting stays outside the bundled
# JavaScript dependency closure.
{
  pkgs,
  src,
  gitRev ? "unknown",
  commitTs ? 0,
  dirty ? false,
  typeProofCompilerBin,
}:

let
  mkSharedHash = hash: { inherit hash; };
  pnpm = import ../../../../nix/pnpm.nix { inherit pkgs; };
  mkPnpmCli = import ../../../../nix/workspace-tools/lib/mk-pnpm-cli.nix { inherit pkgs pnpm; };
  opentuiCoreNative = import ../../../../nix/opentui-core-native.nix { inherit pkgs; };
  # The TypeScript API server MUST be the official binary whose protocol matches the npm client; the
  # Effect-TS `tsgo` fork stays the export type-proof compiler only. The checker package owns that pin
  # (one platform table, one hash set); taking its passthru string pulls in the platform package alone,
  # so the checker itself is never built for the CLI.
  bootstrapClosureCheck = import ./bootstrap-closure-check.nix { inherit pkgs src; };
  unwrapped = mkPnpmCli {
    name = "genie-unwrapped";
    entry = "packages/@overeng/genie/bin/genie.tsx";
    binaryName = "genie";
    packageDir = "packages/@overeng/genie";
    workspaceRoot = src;
    # Managed by the repo FOD refresh workflow — do not edit manually.
    depsBuilds = {
      "." = mkSharedHash "sha256-3voYGTTxs1c0ENSEOKa5tYvOyn9SyLmYUnGcq4ILUy8=";
    };
    nativeNodePackages = opentuiCoreNative.packages;
    inherit gitRev commitTs dirty;
  };
in
pkgs.runCommand "genie"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    meta.mainProgram = "genie";
    passthru = {
      inherit (unwrapped.passthru)
        depsBuildEntries
        depsBuildsByInstallRoot
        fodHashRepairTargets
        inheritRootPatchedDependenciesScript
        installRoots
        ;
    };
  }
  ''
    mkdir -p $out/bin
    makeWrapper ${unwrapped}/bin/genie $out/bin/genie \
      --suffix PATH : ${pkgs.oxfmt}/bin \
      --set GENIE_ACTIONLINT_BIN ${pkgs.actionlint}/bin/actionlint \
      --set GENIE_EXPORT_TYPE_PROOF_COMPILER ${typeProofCompilerBin} \
      --set GENIE_TYPESCRIPT_API_SERVER ${bootstrapClosureCheck.passthru.typescriptApiServerBin}

    # Propagate shell completions from the unwrapped derivation
    for dir in share/fish/vendor_completions.d share/bash-completion/completions share/zsh/site-functions; do
      if [ -d "${unwrapped}/$dir" ]; then
        mkdir -p "$out/$dir"
        ln -s "${unwrapped}/$dir"/* "$out/$dir/"
      fi
    done
  ''
