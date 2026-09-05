# Build pre-bundled @overeng/oxc-config JS plugin for oxlint.
#
# Bundles the custom overeng rules (including the native overeng/storybook/*
# rules) into a single self-contained JS file usable as an oxlint jsPlugin
# without node_modules.
# Imported by oxlint-npm.nix when src is provided.
#
# =============================================================================
# Updating the pnpmDepsHash (after changing oxc-config's dependencies)
# =============================================================================
#
# 1. Run: nix build .#oxlint-npm 2>&1
#    (the FOD will fail with expected vs actual hash)
#
# 2. Update pnpmDepsHash below with the actual hash from the error
#
# =============================================================================
{
  pkgs,
  bun,
  src,
  depsBuilds,
  hashSourcePath,
}:

let
  lib = pkgs.lib;
  pinnedPnpm = import ./pnpm.nix { inherit pkgs; };
  pnpmDepsHelper = import ./workspace-tools/lib/mk-pnpm-deps.nix {
    inherit pkgs;
    pnpm = pinnedPnpm;
  };
  packageDir = "packages/@overeng/oxc-config";
  depsBuild = depsBuilds.".";
  pnpmDepsHash = depsBuild.hash;

  srcPath =
    if builtins.isAttrs src && builtins.hasAttr "outPath" src then
      src.outPath
    else if builtins.isPath src then
      src
    else
      builtins.toPath src;

  # Patches referenced in pnpm-workspace.yaml (shared across all workspaces)
  patchesDirs = [
    "packages/@overeng/utils/patches"
  ];

  rootPnpmWorkspaceYamlPath = srcPath + "/pnpm-workspace.yaml";
  rootPnpmWorkspaceYaml = builtins.readFile rootPnpmWorkspaceYamlPath;

  hasPathPrefix =
    relPath: prefix:
    relPath == prefix
    || lib.hasPrefix "${prefix}/" relPath
    || (
      relPath != ""
      && builtins.elem relPath (
        lib.genList (index: lib.concatStringsSep "/" (lib.take (index + 1) (lib.splitString "/" prefix))) (
          lib.length (lib.splitString "/" prefix) - 1
        )
      )
    );

  workspaceSuffixLines =
    workspaceYaml:
    let
      dropUntilPackagesHeader =
        lines:
        if lines == [ ] then
          throw "oxc-config-plugin: pnpm-workspace.yaml is missing packages:"
        else if lib.hasPrefix "packages:" (lib.trim (builtins.head lines)) then
          lib.tail lines
        else
          dropUntilPackagesHeader (lib.tail lines);

      dropPackageBlock =
        lines:
        if lines == [ ] then
          [ ]
        else
          let
            line = builtins.head lines;
            trimmed = lib.trim line;
          in
          if trimmed == "" || lib.hasPrefix "-" trimmed || lib.hasPrefix " " line then
            dropPackageBlock (lib.tail lines)
          else
            lines;

      stripPrepLocalPnpmSettings =
        lines:
        # The FOD must not inherit caller-local GVS/store paths; its private
        # install root is part of the reproducible derivation boundary.
        builtins.filter (
          l:
          !(lib.hasPrefix "enableGlobalVirtualStore" (lib.trim l)) && !(lib.hasPrefix "storeDir" (lib.trim l))
        ) lines;
    in
    stripPrepLocalPnpmSettings (
      dropPackageBlock (dropUntilPackagesHeader (lib.splitString "\n" workspaceYaml))
    );

  formatWorkspaceYaml =
    packageDirs: suffixLines:
    let
      packagesBlock = builtins.concatStringsSep "\n" (
        [ "packages:" ] ++ map (dir: "  - ${dir}") packageDirs
      );
      suffix = builtins.concatStringsSep "\n" suffixLines;
    in
    if suffix == "" then "${packagesBlock}\n" else "${packagesBlock}\n\n${suffix}\n";

  filteredRootPnpmWorkspaceYamlFile = pkgs.writeText "oxc-config-pnpm-workspace.yaml" (
    formatWorkspaceYaml [ packageDir ] (workspaceSuffixLines rootPnpmWorkspaceYaml)
  );

  sourceExclusions = [
    ".git"
    ".devenv"
    ".cache"
    ".turbo"
    ".next"
    ".bun"
    ".pnpm-store"
    "node_modules"
    "dist"
    "result"
    "coverage"
    "tmp"
    "out"
  ];

  depsSrc = lib.cleanSourceWith {
    src = srcPath;
    filter =
      path: type:
      let
        relPath = lib.removePrefix (toString srcPath + "/") (toString path);
        baseName = baseNameOf path;
      in
      !(lib.elem baseName sourceExclusions)
      && (
        builtins.elem relPath [
          "package.json"
          "pnpm-lock.yaml"
          "pnpm-workspace.yaml"
          ".npmrc"
          "tsconfig.base.json"
        ]
        || hasPathPrefix relPath "${packageDir}/package.json"
        || builtins.any (dir: hasPathPrefix relPath dir) patchesDirs
      );
  };

  # Full source for building (includes .ts files, excludes node_modules etc.)
  buildSrc = lib.cleanSourceWith {
    src = srcPath;
    filter =
      path: type:
      let
        relPath = lib.removePrefix (toString srcPath + "/") (toString path);
        baseName = baseNameOf path;
      in
      !(lib.elem baseName sourceExclusions)
      && (
        builtins.elem relPath [
          "package.json"
          "pnpm-lock.yaml"
          "pnpm-workspace.yaml"
          ".npmrc"
          "tsconfig.base.json"
        ]
        || hasPathPrefix relPath packageDir
        || builtins.any (dir: hasPathPrefix relPath dir) patchesDirs
      );
  };

  pnpmDeps = pnpmDepsHelper.mkDeps {
    name = "oxc-config";
    src = depsSrc;
    sourceRoot = ".";
    inherit pnpmDepsHash;
    preInstall = ''
      chmod +w pnpm-workspace.yaml
      cp ${filteredRootPnpmWorkspaceYamlFile} pnpm-workspace.yaml
    '';
  };

in
pkgs.stdenv.mkDerivation {
  pname = "oxc-config-plugin";
  version = "0.1.0";
  passthru = {
    # Export the prepared dependency boundary and its source-owned hash identity
    # in the same shape as mkPnpmCli consumers.
    inherit pnpmDeps;
    depsBuildsByInstallRoot.root = pnpmDeps;
    depsBuildEntries = [
      {
        attrName = "root";
        dir = ".";
        hash = pnpmDepsHash;
        lockfilePath = "pnpm-lock.yaml";
        memberDirs = [ packageDir ];
        profileKey = "oxc-config-root";
      }
    ];
    fodHashRepairTargets = [
      {
        schemaVersion = 1;
        kind = "dependency-fod-hash-repair-target";
        producer = "effect-utils.oxc-config-plugin";
        subject = {
          packageName = "@overeng/oxc-config";
          inherit packageDir;
        };
        attrName = "root";
        installDir = ".";
        lockfilePath = "pnpm-lock.yaml";
        memberDirs = [ packageDir ];
        profileKey = "oxc-config-root";
        declaredHash = pnpmDepsHash;
        depsDrvPath = pnpmDeps.drvPath;
        hashPath = [
          "depsBuilds"
          "."
          "hash"
        ];
      }
    ];
    evergreen.fodGraph.v1 =
      let
        packageAttr = ".#packages.${pkgs.stdenv.hostPlatform.system}.oxlint-npm";
        boundaryAttr = "${packageAttr}.passthru.depsBuildsByInstallRoot.root";
      in
      {
        schema = "evergreen.fodGraph.v1";
        version = 1;
        consumer = {
          attr = packageAttr;
          consumerAttr = packageAttr;
          system = pkgs.stdenv.hostPlatform.system;
          package = "oxc-config";
          surfacedName = "oxc-config";
        };
        capabilityGaps = [ ];
        boundaries = [
          {
            attr = boundaryAttr;
            variant = "depsBuilds";
            consumerAttr = packageAttr;
            system = pkgs.stdenv.hostPlatform.system;
            package = "oxc-config";
            surfacedName = "oxc-config";
            inherit boundaryAttr packageDir hashSourcePath;
            builderFile = hashSourcePath;
            hashSet = "depsBuilds";
            installRoot = ".";
            installRootAttr = "root";
            lockfilePath = "pnpm-lock.yaml";
            memberDirs = [ packageDir ];
            profileKey = "oxc-config-root";
            hashKey = ".";
            equivalenceKey = "oxc-config-root";
            hash = pnpmDepsHash;
            hashPath = [
              "depsBuilds"
              "."
              "hash"
            ];
            depsBuildDrvPath = pnpmDeps.drvPath;
            depsBuildDrvPaths = [ pnpmDeps.drvPath ];
            supportedSystems = [ pkgs.stdenv.hostPlatform.system ];
          }
        ];
      };
  };

  nativeBuildInputs = [
    bun
    pkgs.nodejs
    pkgs.perl
  ];

  dontUnpack = true;
  dontFixup = true;

  buildPhase = ''
    set -euo pipefail
    runHook preBuild

    cp -r ${buildSrc} workspace
    chmod -R +w workspace
    ${pnpmDepsHelper.mkRestoreScript {
      deps = pnpmDeps;
      target = "workspace";
    }}
    cd workspace

    cd ${packageDir}
    chmod +w .

    # Bundle into single JS file.
    # --external jiti: eslint's config loader uses jiti for dynamic imports, but
    # oxlint's JS plugin runtime never invokes the config loader, so jiti is safe
    # to exclude. This avoids bundling issues with jiti's native module resolution.
    bun build src/mod.ts --bundle --target=bun --external jiti --outfile=plugin.js

    runHook postBuild
  '';

  checkPhase = ''
    # Verify the bundle is self-contained (no missing modules like jiti).
    # buildPhase leaves CWD in workspace/${packageDir} where plugin.js was produced.
    test -f plugin.js || { echo "error: plugin.js not found in $(pwd)"; exit 1; }
    bun -e "const p = require('./plugin.js'); if (!p || typeof p !== 'object') throw new Error('plugin did not export an object')"
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp plugin.js $out/
    runHook postInstall
  '';

  meta = with pkgs.lib; {
    description = "Pre-bundled @overeng/oxc-config oxlint JS plugin";
    license = licenses.mit;
  };
}
