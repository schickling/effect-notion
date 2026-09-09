# Nix derivation that builds the standalone bootstrap-closure checker.
{
  pkgs,
  src,
  gitRev ? "unknown",
  commitTs ? 0,
  dirty ? false,
}:

let
  lib = pkgs.lib;
  srcPath = if builtins.isAttrs src && builtins.hasAttr "outPath" src then src.outPath else src;

  geniePackageJson = builtins.fromJSON (
    builtins.readFile (srcPath + "/packages/@overeng/genie/package.json")
  );
  typescriptVersion =
    geniePackageJson.dependencies.typescript
      or (throw "packages/@overeng/genie/package.json must declare dependencies.typescript");
  typescriptTarball = pkgs.fetchurl {
    url = "https://registry.npmjs.org/typescript/-/typescript-${typescriptVersion}.tgz";
    hash = "sha256-2iUT9LlRdtbd6LUaq3r+ipJ2VsnSdzaXk/d/flk3HAg=";
  };
  typescriptNodeModule =
    pkgs.runCommand "typescript-${typescriptVersion}-node-module"
      {
        nativeBuildInputs = [
          pkgs.gnutar
          pkgs.gzip
        ];
      }
      ''
        mkdir -p "$out"
        tar -xzf ${typescriptTarball} -C "$out" --strip-components=1
      '';

  firstPartySources = [
    "packages/@overeng/genie/bin/bootstrap-closure-check.ts"
    "packages/@overeng/genie/src/core/import-map/sync-resolver.ts"
    "packages/@overeng/genie/src/core/phase.ts"
    "packages/@overeng/genie/src/runtime/node/bootstrap-closure.ts"
    "packages/@overeng/genie/src/runtime/node/bootstrap-closure-check-cli.ts"
    "packages/@overeng/genie/src/runtime/node/ts-api.ts"
  ];
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "genie-bootstrap-closure-check";
  version = "0.1.0";

  dontUnpack = true;
  dontBuild = true;
  nativeBuildInputs = [
    pkgs.makeWrapper
  ];

  installPhase = ''
    runHook preInstall

    workspace="$out/lib/genie-bootstrap-closure-check"
    mkdir -p "$out/bin" "$workspace/node_modules"
    ${lib.concatMapStringsSep "\n" (sourcePath: ''
      install -Dm0644 ${srcPath + "/${sourcePath}"} "$workspace/${sourcePath}"
    '') firstPartySources}
    ln -s ${typescriptNodeModule} "$workspace/node_modules/typescript"

    makeWrapper ${pkgs.bun}/bin/bun \
      "$out/bin/genie-bootstrap-closure-check" \
      --add-flags "$workspace/packages/@overeng/genie/bin/bootstrap-closure-check.ts"
    "$out/bin/genie-bootstrap-closure-check" --help >/dev/null

    runHook postInstall
  '';

  meta.mainProgram = "genie-bootstrap-closure-check";
  passthru = {
    inherit
      firstPartySources
      gitRev
      commitTs
      dirty
      typescriptVersion
      ;
    # This package intentionally has no pnpm fixed-output dependency roots.
    # Keep the metadata shape present so generic CI/FOD scanners do not need a
    # special case for the checker.
    depsBuildEntries = [ ];
    depsBuildsByInstallRoot = { };
    fodHashRepairTargets = [ ];
    installRoots = [ ];
  };
}
