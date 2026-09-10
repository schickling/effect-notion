# Nix derivation that builds the standalone bootstrap-closure checker.
#
# It also OWNS the repository's npm TypeScript 7 pins: the `typescript` package and the matching
# `@typescript/typescript-<platform>` optional package that carries the native compiler. TypeScript 7
# versions the API client's JSON-RPC protocol together with that binary, so the API server must be the
# executable published with the very same `typescript` release — the Effect-TS `tsgo` fork is a
# different revision and answers `updateSnapshot` with zero projects (`no project found for file`).
#
# `passthru.typescriptApiServerBin` publishes that executable so other packages (notably the Genie CLI
# wrapper in ./build.nix) reuse this one platform table and its hashes. Reading the passthru string
# only pulls in the platform package, never a build of the checker itself.
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

  # Managed together with `dependencies.typescript`: bumping the version means refreshing every hash.
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
      or (throw "npm TypeScript ${typescriptVersion} is not pinned for ${pkgs.stdenv.hostPlatform.system}");

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

  # The official native compiler/API server executable for the host platform.
  typescriptApiServerBin = "${typescriptPlatformNodeModule}/lib/tsc";

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

    # The API server is wired explicitly instead of being discovered by the `typescript` client:
    # the client resolves `@typescript/${typescriptPlatformPackage.name}` next to its OWN realpath,
    # which in the Nix store is an immutable directory we cannot place the platform package into.
    makeWrapper ${pkgs.bun}/bin/bun \
      "$out/bin/genie-bootstrap-closure-check" \
      --add-flags "$workspace/packages/@overeng/genie/bin/bootstrap-closure-check.ts" \
      --set GENIE_TYPESCRIPT_API_SERVER ${typescriptApiServerBin}

    # Build smoke: analyze a real bootstrap `.genie.ts` closure rather than only printing `--help`.
    # The negative fixture is the load-bearing half — an API server that cannot open projects reports
    # zero violations, so requiring the transitive `effect` edge to be REPORTED (through a relative
    # `./barrel.ts` hop the compiler must resolve) makes a broken session fail the build.
    smokeRoot="$(mktemp -d)"
    printf "export { Effect } from 'effect'\n" > "$smokeRoot/barrel.ts"
    printf '// @genie-bootstrap\nexport { Effect } from "./barrel.ts"\n' \
      > "$smokeRoot/reaching.genie.ts"
    if (cd "$smokeRoot" && "$out/bin/genie-bootstrap-closure-check" --root "$smokeRoot" >"$smokeRoot/log" 2>&1); then
      echo "bootstrap-closure smoke: expected the runtime-only 'effect' edge to be reported" >&2
      cat "$smokeRoot/log" >&2
      exit 1
    fi
    grep -q "reaching.genie.ts" "$smokeRoot/log"
    grep -q "barrel.ts" "$smokeRoot/log"

    # Positive fixture: the same closure is clean once the runtime-only re-export is gone.
    rm "$smokeRoot/log"
    printf 'export const value = 1\n' > "$smokeRoot/barrel.ts"
    (cd "$smokeRoot" && "$out/bin/genie-bootstrap-closure-check" --root "$smokeRoot" >"$smokeRoot/log" 2>&1)
    grep -q "bootstrap-closure: OK — 1 bootstrap-phase .genie.ts checked" "$smokeRoot/log"
    rm -rf "$smokeRoot"

    runHook postInstall
  '';

  meta.mainProgram = "genie-bootstrap-closure-check";
  passthru = {
    inherit
      firstPartySources
      gitRev
      commitTs
      dirty
      ;
    inherit typescriptVersion typescriptApiServerBin;
    # This package intentionally has no pnpm fixed-output dependency roots.
    # Keep the metadata shape present so generic CI/FOD scanners do not need a
    # special case for the checker.
    depsBuildEntries = [ ];
    depsBuildsByInstallRoot = { };
    fodHashRepairTargets = [ ];
    installRoots = [ ];
  };
}
