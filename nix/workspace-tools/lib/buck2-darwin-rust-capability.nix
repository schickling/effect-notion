# Nix-owned, executor-local Darwin Rust capability. The Apple SDK remains a
# host capability and is deliberately not exposed as a Buck artifact/provider.
{
  pkgs,
  nixpkgsRevision,
  sdk ? pkgs.apple-sdk_15,
  deploymentTarget ? "15.0",
}:

let
  lib = pkgs.lib;
  inherit (pkgs.darwin) cctools signingUtils sigtool;
  inspectionTools = import ./buck2-darwin-inspection-tools.nix { inherit pkgs; };
  identity = lib.concatStringsSep ":" [
    "buck2-rust-darwin/v1"
    "nixpkgs-${nixpkgsRevision}"
    "rustc-${builtins.baseNameOf (toString pkgs.rustc)}"
    "clang-${builtins.baseNameOf (toString pkgs.clang)}"
    "llvm-${builtins.baseNameOf (toString pkgs.llvm)}"
    "cctools-${builtins.baseNameOf (toString cctools)}"
    "sigtool-${builtins.baseNameOf (toString sigtool)}"
    "signing-utils-${builtins.baseNameOf (toString signingUtils)}"
    "sdk-${builtins.baseNameOf (toString sdk)}"
    "deployment-${deploymentTarget}"
  ];
  compiler = pkgs.writeShellScriptBin "rustc" ''
    set -euo pipefail
    export DEVELOPER_DIR=/forbidden-no-xcode
    export SDKROOT=${lib.escapeShellArg sdk.sdkroot}
    export MACOSX_DEPLOYMENT_TARGET=${lib.escapeShellArg deploymentTarget}
    export PATH=${
      lib.makeBinPath [
        # Buck's Rust prelude emits linker wrappers with `#!/usr/bin/env bash`.
        # Keep bash visible after this wrapper replaces the action's PATH.
        pkgs.bash
        pkgs.coreutils
        sigtool
        cctools
      ]
    }

    output=
    previous=
    for argument in "$@"; do
      if [ "$previous" = -o ]; then output="$argument"; fi
      previous="$argument"
    done
    ${pkgs.rustc}/bin/rustc \
      -C linker=${pkgs.clang}/bin/clang \
      -C link-arg=-isysroot \
      -C link-arg=${lib.escapeShellArg sdk.sdkroot} \
      "$@"
    if [ -n "$output" ]; then
      source ${signingUtils}
      signIfRequired "$output"
    fi
  '';
  preflight = pkgs.writeShellScript "buck2-rust-darwin-preflight" ''
    set -euo pipefail
    export PATH=${lib.makeBinPath [ pkgs.coreutils ]}
    for executable in \
      ${pkgs.rustc}/bin/rustc \
      ${pkgs.clang}/bin/clang \
      ${cctools}/bin/otool \
      ${cctools}/bin/lipo \
      ${cctools}/bin/codesign_allocate \
      ${sigtool}/bin/sigtool; do
      [ -x "$executable" ] || {
        echo "buck2-rust-darwin-preflight: missing Nix tool: $executable" >&2
        exit 1
      }
    done
    [ -d ${lib.escapeShellArg sdk.sdkroot} ] || {
      echo "buck2-rust-darwin-preflight: missing Nix Apple SDK root" >&2
      exit 1
    }
    printf '%s\n' ${lib.escapeShellArg identity}
  '';
in
assert lib.assertMsg pkgs.stdenv.hostPlatform.isDarwin
  "buck2-darwin-rust-capability requires a Darwin Nix realization";
assert lib.assertMsg (
  builtins.isString nixpkgsRevision && builtins.match "[0-9a-f]{40}" nixpkgsRevision != null
) "buck2-darwin-rust-capability requires the exact 40-character nixpkgs revision";
{
  inherit compiler identity preflight;
  closureIdentities = {
    inherit (inspectionTools) lipo otool;
    clang = toString pkgs.clang;
    compiler = toString compiler;
    cctools = toString cctools;
    llvm = toString pkgs.llvm;
    rustc = toString pkgs.rustc;
    sdk = toString sdk;
    inherit signingUtils;
    sigtool = toString sigtool;
  };
  targetTriple = "aarch64-apple-darwin";
  targetPlatform = {
    os = "darwin";
    architecture = "aarch64";
    abi = "darwin";
  };
  compileEnv = {
    DEVELOPER_DIR = "/forbidden-no-xcode";
    SDKROOT = sdk.sdkroot;
    MACOSX_DEPLOYMENT_TARGET = deploymentTarget;
  };
  inherit inspectionTools;
}
