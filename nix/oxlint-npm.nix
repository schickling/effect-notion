# Package npm oxlint with NAPI bindings to enable JavaScript plugin support.
#
# The Nix-native oxlint binary (pkgs.oxlint) is compiled from Rust and cannot
# execute JS plugins. The npm version uses NAPI bindings to run Rust code from
# a JS runtime (Bun), enabling jsPlugins support.
#
# The two @overeng/oxc-config plugin entry points are imported from the tracked
# immutable Buck product manifest and exposed as stable passthru paths. Nix
# remains only the oxlint runtime packager; it does not rebuild plugin sources.
#
# Usage:
#   tracked = import ./buck2-products { inherit pkgs; };
#   oxlintNpm = import ./oxlint-npm.nix {
#     inherit pkgs bun;
#     products = tracked.products;
#   };
#   # => oxlintNpm.pluginPath is the overeng plugin module
#   # => oxlintNpm.stylexUpstreamPluginPath is the @stylexjs plugin module
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
  products,
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

  importProduct = import ./workspace-tools/lib/javascript-product-import.nix { inherit pkgs; };
  importPlugin =
    productName:
    let
      product = products.${productName};
    in
    importProduct {
      inherit (product)
        artifact
        descriptor
        descriptorContent
        expectedDescriptorSha256
        expectedModuleSha256
        ;
      expectedProductKind = "module";
      expectedProductName = productName;
      generateCompletions = false;
    };
  overengPlugin = importPlugin "oxc-config";
  stylexUpstreamPlugin = importPlugin "oxc-config-stylex-upstream-plugin";
  overengPluginModule = "${overengPlugin}/libexec/${overengPlugin.checkedDescriptor.modulePath}";
  stylexUpstreamPluginModule =
    "${stylexUpstreamPlugin}/libexec/${stylexUpstreamPlugin.checkedDescriptor.modulePath}";

in
pkgs.stdenv.mkDerivation (finalAttrs: {
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

    # Keep both independently attested modules in the oxlint closure and expose
    # stable package-local paths to wrapper consumers.
    ln -s ${overengPluginModule} "$out/lib/oxc-config-plugin.js"
    ln -s ${stylexUpstreamPluginModule} "$out/lib/stylex-upstream-plugin.js"

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

  passthru = {
    pluginPath = "${finalAttrs.finalPackage}/lib/oxc-config-plugin.js";
    stylexUpstreamPluginPath = "${finalAttrs.finalPackage}/lib/stylex-upstream-plugin.js";
    inherit overengPlugin stylexUpstreamPlugin;
  };

  meta = with pkgs.lib; {
    description = "npm oxlint with NAPI bindings for JavaScript plugin support";
    homepage = "https://oxc.rs/docs/guide/usage/linter.html";
    license = licenses.mit;
    mainProgram = "oxlint";
    platforms = builtins.attrNames platformPackages;
  };
})
