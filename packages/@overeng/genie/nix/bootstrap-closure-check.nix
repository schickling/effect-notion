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
  typescriptPlatformPackage =
    {
      "aarch64-darwin" = {
        name = "typescript-darwin-arm64";
        hash = "sha512-gowzar9MwS/aRWp6f3a4KUqzRjAZjOsmGNCM6LcTgXum+dBfgsBVMN+AgvOCCbguXyick6LJhpBszxMebJ8syA==";
      };
      "x86_64-darwin" = {
        name = "typescript-darwin-x64";
        hash = "sha512-SZ9xZInqApNlNGc9s0W1VSsktYSOe9cFqNOIqmN1Gs8SmkjKZYFt017G4VwPxASInODuAdbTW7sXiFUf893RgA==";
      };
      "aarch64-linux" = {
        name = "typescript-linux-arm64";
        hash = "sha512-Qh4eU4/y3yDjnfjjyPYihMj5/ODIlmt+Bzu17OI+fiSRDW57QmU5SiN63exPRNJPKUzcc1INa1NXdrJ+MqHjUQ==";
      };
      "x86_64-linux" = {
        name = "typescript-linux-x64";
        hash = "sha512-EYdf2cNg7rgCWJnxCdJ+F3V39O8ihb37eHAu1LK8oAFizgTQbPOK7zHHXbPt8rX24COqODXeI3sIf0fCXG7H/A==";
      };
    }
    .${pkgs.stdenv.hostPlatform.system}
      or (throw "genie-bootstrap-closure-check does not support ${pkgs.stdenv.hostPlatform.system}");
  unpackNpmPackage =
    {
      name,
      tarball,
    }:
    pkgs.runCommand name
      {
        nativeBuildInputs = [
          pkgs.gnutar
          pkgs.gzip
        ];
      }
      ''
        mkdir -p "$out"
        tar -xzf ${tarball} -C "$out" --strip-components=1
      '';
  typescriptNodeModule = unpackNpmPackage {
    name = "typescript-${typescriptVersion}-node-module";
    tarball = pkgs.fetchurl {
      url = "https://registry.npmjs.org/typescript/-/typescript-${typescriptVersion}.tgz";
      hash = "sha256-2iUT9LlRdtbd6LUaq3r+ipJ2VsnSdzaXk/d/flk3HAg=";
    };
  };
  typescriptPlatformNodeModule = unpackNpmPackage {
    name = "${typescriptPlatformPackage.name}-${typescriptVersion}-node-module";
    tarball = pkgs.fetchurl {
      url = "https://registry.npmjs.org/@typescript/${typescriptPlatformPackage.name}/-/${typescriptPlatformPackage.name}-${typescriptVersion}.tgz";
      inherit (typescriptPlatformPackage) hash;
    };
  };

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
    mkdir -p "$workspace/node_modules/@typescript"
    ln -s ${typescriptNodeModule} "$workspace/node_modules/typescript"
    ln -s ${typescriptPlatformNodeModule} \
      "$workspace/node_modules/@typescript/${typescriptPlatformPackage.name}"

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
