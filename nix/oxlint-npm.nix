# Package npm oxlint with NAPI bindings to enable JavaScript plugin support.
#
# The Nix-native oxlint binary (pkgs.oxlint) is compiled from Rust and cannot
# execute JS plugins. The npm version uses NAPI bindings to run Rust code from
# a JS runtime (Bun), enabling jsPlugins support.
#
# When `src` is provided (the effect-utils source), the @overeng/oxc-config
# plugin is bundled alongside (via nix/oxc-config-plugin.nix) and exposed as
# passthru.pluginPath for consumer repos to inject into oxlint configs.
#
# Usage:
#   oxlintNpm = import ./oxlint-npm.nix { inherit pkgs bun; src = self; };
#   # => oxlintNpm provides the `oxlint` command on PATH
#   # => oxlintNpm.pluginPath is the absolute path to the bundled plugin JS file (or null)
#
# =============================================================================
# Updating to a new version
# =============================================================================
#
# 1. Check latest version:
#    npm view oxlint version
#
# 2. Update `version` below to the new version number
#
# 3. Calculate new hashes (run in /tmp to avoid devenv cache issues):
#    cd /tmp
#    VERSION=1.82.0  # <-- set to new version
#
#    # Main package
#    nix hash convert --to sri --hash-algo sha256 \
#      $(nix-prefetch-url https://registry.npmjs.org/oxlint/-/oxlint-$VERSION.tgz)
#
#    # Platform binaries: 1.45 and newer publish `@oxlint/binding-<target>`;
#    # 1.43 and older published `@oxlint/<target>`.
#    for pkg in binding-darwin-arm64 binding-darwin-x64 binding-linux-x64-gnu binding-linux-arm64-gnu; do
#      echo "$pkg:"
#      nix hash convert --to sri --hash-algo sha256 \
#        $(nix-prefetch-url https://registry.npmjs.org/@oxlint/$pkg/-/$pkg-$VERSION.tgz)
#    done
#
# 4. Update hashes in this file (mainPackage.hash and platformPackages.*.hash)
#
# 5. Reload devenv and verify:
#    rm -rf .devenv
#    oxlint --version
#    mono lint  # should show "WARNING: JS plugins are experimental..."
#
# =============================================================================
{
  pkgs,
  bun,
  src ? null,
}:
let
  lib = pkgs.lib;

  # https://github.com/oxc-project/oxc/releases for latest version
  #
  # Keep in lockstep with the `oxlint` pin in genie/external.ts: the JS-plugin
  # rule API and the config schema are versioned with the binary, so a split
  # between this package and the workspace pin means two different linters.
  version = "1.82.0";

  # Platform-specific package mapping (NAPI binding packages, `@oxlint/binding-*`)
  platformPackages = {
    "aarch64-darwin" = {
      name = "@oxlint/binding-darwin-arm64";
      hash = "sha256-em2Q1r1nI3TFATUugqGlCHeZ5de7CJ9bUXskbtsumSo=";
    };
    "x86_64-darwin" = {
      name = "@oxlint/binding-darwin-x64";
      hash = "sha256-wkA2gv7N9AP9Wsq+lN/LeujGou9XI1smt0lcfnM1Ub4=";
    };
    "x86_64-linux" = {
      name = "@oxlint/binding-linux-x64-gnu";
      hash = "sha256-r9ILzW5kjzQEc93U3Q5Fo2KBVtou0e6L7qLeQiUQEvM=";
    };
    "aarch64-linux" = {
      name = "@oxlint/binding-linux-arm64-gnu";
      hash = "sha256-GL3gDjGReOg4l7V3j0fuy8EmcZ3CoM2k5jdVkrY0fpU=";
    };
  };

  system = pkgs.stdenv.hostPlatform.system;
  platformPkg = platformPackages.${system} or (throw "Unsupported platform: ${system}");

  # Fetch the main oxlint npm package
  mainPackage = pkgs.fetchurl {
    url = "https://registry.npmjs.org/oxlint/-/oxlint-${version}.tgz";
    hash = "sha256-IGZIRCAAKmzRYqQbXRCTB8vnzpG7+wSXV4RtSnveLA0=";
  };

  # Fetch the platform-specific binary package
  # npm scoped packages use a different URL pattern
  binaryPackage = pkgs.fetchurl {
    url = "https://registry.npmjs.org/${platformPkg.name}/-/${
      builtins.replaceStrings [ "@oxlint/" ] [ "" ] platformPkg.name
    }-${version}.tgz";
    hash = platformPkg.hash;
  };

  # Optional: build the @overeng/oxc-config plugin bundle when src is provided
  hasPlugin = src != null;
  pluginBundle =
    if hasPlugin then
      import (../. + "/packages/@overeng/oxc-config/nix/build.nix") { inherit pkgs bun src; }
    else
      null;

in
pkgs.stdenv.mkDerivation {
  pname = "oxlint-npm";
  inherit version;

  dontUnpack = true;

  nativeBuildInputs = [ pkgs.makeWrapper ];

  buildPhase = ''
    runHook preBuild

    # Create node_modules structure
    mkdir -p $out/lib/node_modules/oxlint
    mkdir -p $out/lib/node_modules/${platformPkg.name}
    mkdir -p $out/bin

    # Extract main oxlint package
    tar -xzf ${mainPackage} -C $out/lib/node_modules/oxlint --strip-components=1

    # Extract platform-specific binary package
    tar -xzf ${binaryPackage} -C $out/lib/node_modules/${platformPkg.name} --strip-components=1

    ${lib.optionalString hasPlugin ''
      # Symlink pre-bundled oxc-config plugin for discoverability
      ln -s ${pluginBundle}/plugin.js $out/lib/oxc-config-plugin.js
    ''}

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    # Create wrapper script that sets up NODE_PATH (Bun uses NODE_PATH for module resolution)
    makeWrapper ${bun}/bin/bun $out/bin/oxlint \
      --add-flags "$out/lib/node_modules/oxlint/bin/oxlint" \
      --set NODE_PATH "$out/lib/node_modules"

    runHook postInstall
  '';

  # Expose plugin path for consumers (e.g., lint-oxc.nix jsPlugins parameter).
  passthru = {
    pluginBundle = if hasPlugin then pluginBundle else null;
    pluginPath = if hasPlugin then "${pluginBundle}/plugin.js" else null;
  };

  meta = with pkgs.lib; {
    description = "npm oxlint with NAPI bindings for JavaScript plugin support";
    homepage = "https://oxc.rs/docs/guide/usage/linter.html";
    license = licenses.mit;
    mainProgram = "oxlint";
    platforms = builtins.attrNames platformPackages;
  };
}
