{
  pkgs,
  products,
  typeProofCompilerBin,
  gitRev ? "unknown",
  commitTs ? 0,
  dirty ? false,
}:

let
  importProduct = import ./javascript-product-import.nix { inherit pkgs; };
  opentuiCoreNative = import ../../opentui-core-native.nix { inherit pkgs; };
  buck2 = import ../../buck2.nix { inherit pkgs; };
  buildStamp = builtins.toJSON {
    type = "nix";
    version = "0.1.0";
    rev = gitRev;
    inherit commitTs dirty;
  };
  mk =
    name: options:
    importProduct (
      {
        inherit (products.${name})
          artifact
          descriptor
          expectedDescriptorSha256
          expectedModuleSha256
          ;
        expectedProductName = name;
      }
      // options
    );

  genie = mk "genie" {
    binaryName = "genie";
    environment = {
      CLI_BUILD_STAMP = buildStamp;
      GENIE_ACTIONLINT_BIN = "${pkgs.actionlint}/bin/actionlint";
      GENIE_EXPORT_TYPE_PROOF_COMPILER = typeProofCompilerBin;
    };
    expectedExternalCapabilities = [
      "actionlint"
      "effect-tsgo"
      "oxfmt"
    ];
    expectedProductKind = "cli";
    pathPackages = [ pkgs.oxfmt ];
    smokeTestArgs = [ "--dry-run" ];
  };
  genie-bootstrap-closure-check = mk "genie-bootstrap-closure-check" {
    binaryName = "genie-bootstrap-closure-check";
    expectedProductKind = "cli";
    smokeTestArgs = [ "--help" ];
  };
  ci-tools = mk "ci-tools" {
    binaryName = "ci-tools";
    environment.CLI_BUILD_STAMP = buildStamp;
    expectedProductKind = "cli";
    smokeTestArgs = [ "--help" ];
  };
  megarepo = mk "megarepo" {
    binaryName = "mr";
    environment = {
      CLI_BUILD_STAMP = buildStamp;
      MR_CAPABILITY_MV_BIN = "${pkgs.coreutils}/bin/mv";
      MR_CAPABILITY_NIX_BIN = "${pkgs.nix}/bin/nix";
      MR_COMPOSITION_BUCK2_BIN = "${buck2}/bin/buck2";
      MR_COMPOSITION_BUCK2_PROTOCOL = "facebook/buck2-cli/2026-08-22";
      MR_COMPOSITION_CP_BIN = "${pkgs.coreutils}/bin/cp";
      MR_COMPOSITION_GIT_BIN = "${pkgs.git}/bin/git";
      MR_COMPOSITION_PLATFORM = if pkgs.stdenv.hostPlatform.isDarwin then "darwin" else "linux";
      MR_COMPOSITION_SYSTEM = pkgs.stdenv.hostPlatform.system;
    };
    expectedExternalCapabilities = [
      "buck2"
      "coreutils"
      "git"
      "nix"
      "watchman"
    ];
    expectedProductKind = "cli";
    pathPackages = [ pkgs.watchman ];
    smokeTestArgs = [ "--help" ];
  };
  tui-stories = mk "tui-stories" {
    binaryName = "tui-stories";
    environment.CLI_BUILD_STAMP = buildStamp;
    expectedProductKind = "cli";
    smokeTestArgs = [ "--help" ];
  };
  notionMain = mk "notion-cli" {
    binaryName = "notion-main";
    environment.CLI_BUILD_STAMP = buildStamp;
    expectedProductKind = "cli";
    generateCompletions = false;
  };
  notionDb = mk "notion-db-runtime" {
    binaryName = "notion-db-runtime";
    environment.CLI_BUILD_STAMP = buildStamp;
    expectedExternalCapabilities = [ "opentui-core-native" ];
    # The exact bare imports this product's bytes leave for the host:
    # `@opentui/core` dispatches to one of its platform packages at run time,
    # and the whole family is listed because the bytes are the same on every
    # host. Sourced from the tracked descriptor, so a change in what the
    # product asks for fails the import instead of the program.
    expectedExternalModules = [
      "@opentui/core-darwin-arm64"
      "@opentui/core-darwin-x64"
      "@opentui/core-linux-arm64"
      "@opentui/core-linux-arm64-musl"
      "@opentui/core-linux-x64"
      "@opentui/core-linux-x64-musl"
      "@opentui/core-win32-arm64"
      "@opentui/core-win32-x64"
    ];
    expectedProductKind = "cli";
    generateCompletions = false;
    nativeNodePackages = opentuiCoreNative.packages;
  };
  notion-cli =
    pkgs.runCommand "notion-cli-buck2-candidate"
      {
        nativeBuildInputs = [ pkgs.makeWrapper ];
        meta.mainProgram = "notion";
      }
      ''
        mkdir -p "$out/bin"
        makeWrapper ${notionMain}/bin/notion-main "$out/bin/notion" \
          --run 'if [ "$#" -gt 1 ] && [ "$1" = db ]; then case "$2" in init|pull|push|sync|export|status|conflicts|forget|restore|doctor) shift; exec ${notionDb}/bin/notion-db-runtime "$@";; esac; fi'
        "$out/bin/notion" md --help >/dev/null
        db_output="$($out/bin/notion db sync --help 2>&1 || true)"
        printf '%s\n' "$db_output" | ${pkgs.gnugrep}/bin/grep -q 'Reconcile an established workspace'
        mkdir -p "$out/share/fish/vendor_completions.d" "$out/share/bash-completion/completions" "$out/share/zsh/site-functions"
        for shell in fish bash zsh; do
          case "$shell" in
            fish) target="$out/share/fish/vendor_completions.d/notion.fish" ;;
            bash) target="$out/share/bash-completion/completions/notion" ;;
            zsh) target="$out/share/zsh/site-functions/_notion" ;;
          esac
          "$out/bin/notion" --completions "$shell" > "$target" 2>/dev/null || rm -f "$target"
        done
      '';
  notion-md = mk "notion-md" {
    binaryName = "notion-md";
    environment.CLI_BUILD_STAMP = buildStamp;
    expectedProductKind = "cli";
    smokeTestArgs = [ "--help" ];
  };
  npm-release = mk "npm-release" {
    binaryName = "npm-release";
    environment.CLI_BUILD_STAMP = buildStamp;
    expectedExternalCapabilities = [ "npm" ];
    expectedProductKind = "cli";
    pathPackages = [ pkgs.nodejs ];
    smokeTestArgs = [ "--help" ];
  };
  oxcConfigModule = mk "oxc-config" {
    expectedProductKind = "module";
    generateCompletions = false;
  };
  oxc-config = pkgs.runCommand "oxc-config-buck2-candidate" { } ''
    mkdir -p "$out/lib"
    ln -s ${oxcConfigModule}/libexec/${oxcConfigModule.checkedDescriptor.modulePath} "$out/lib/oxc-config.js"
    ${pkgs.nodejs_24 or pkgs.nodejs}/bin/node -e 'import(process.argv[1])' "$out/lib/oxc-config.js"
  '';
  # A candidate exists only when every product it composes is published, so an
  # unpublished product surfaces as a missing attribute instead of a candidate
  # wired to absent bytes.
  requiredProducts = {
    ci-tools = [ "ci-tools" ];
    genie = [ "genie" ];
    genie-bootstrap-closure-check = [ "genie-bootstrap-closure-check" ];
    megarepo = [ "megarepo" ];
    notion-cli = [
      "notion-cli"
      "notion-db-runtime"
    ];
    notion-md = [ "notion-md" ];
    npm-release = [ "npm-release" ];
    oxc-config = [ "oxc-config" ];
    tui-stories = [ "tui-stories" ];
  };
  candidates = {
    inherit
      ci-tools
      genie
      genie-bootstrap-closure-check
      megarepo
      notion-cli
      notion-md
      npm-release
      oxc-config
      tui-stories
      ;
  };
in
pkgs.lib.filterAttrs (
  name: _: pkgs.lib.all (product: products ? ${product}) requiredProducts.${name}
) candidates
