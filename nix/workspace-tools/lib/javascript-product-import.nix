# Import one Buck-produced JavaScript product into the Nix store.
#
# What is checked is what makes the product usable here: the descriptor schema,
# the semantic product/runtime contract, the portable platform it claims, the
# capabilities this consumer must supply, and the exact bytes. What is NOT
# checked is who produced it — the producer's Nix store paths and configured
# Buck target are recorded as provenance in the descriptor and are host facts,
# so gating on them would reject a byte-identical product built anywhere else.
{ pkgs }:

{
  artifact,
  descriptor,
  expectedDescriptorSha256,
  expectedExternalCapabilities ? [ ],
  expectedExternalModules ? [ ],
  expectedModuleSha256,
  expectedProductKind,
  expectedProductName,
  expectedRuntimeContract ? "javascript-esm",
  expectedRuntimeContractVersion ? "v1",
  binaryName ? null,
  environment ? { },
  generateCompletions ? binaryName != null,
  nativeNodePackages ? [ ],
  pathPackages ? [ ],
  smokeTestArgs ? null,
}:

let
  lib = pkgs.lib;
  value = builtins.fromJSON (builtins.readFile descriptor);
  expectedKeys = [
    "externalCapabilities"
    "externalModules"
    "integrity"
    "modulePath"
    "platform"
    "productKind"
    "productName"
    "provenance"
    "runtimeContract"
    "runtimeContractVersion"
    "runtimeKind"
    "schema"
    "sizeBytes"
    "target"
  ];
  actualKeys = builtins.attrNames value;
  normalizedExpectedCapabilities = builtins.sort builtins.lessThan expectedExternalCapabilities;
  normalizedActualCapabilities = builtins.sort builtins.lessThan value.externalCapabilities;
  # The bare imports the product asks THIS consumer to resolve. Left implicit
  # (`[ ]`) a product would be free to grow a runtime dependency nobody here
  # provides, so the set is compared exactly, order-independently.
  normalizedExpectedModules = builtins.sort builtins.lessThan expectedExternalModules;
  normalizedActualModules = builtins.sort builtins.lessThan value.externalModules;
  validRelativePath =
    path: builtins.match "[A-Za-z0-9][A-Za-z0-9._+-]*(/[A-Za-z0-9][A-Za-z0-9._+-]*)*" path != null;
  runtime = if value.runtimeKind == "bun" then pkgs.bun else pkgs.nodejs_24 or pkgs.nodejs;
  wrapperEnvironment = lib.concatStringsSep " \\\n      " (
    lib.mapAttrsToList (
      name: value: "--set ${lib.escapeShellArg name} ${lib.escapeShellArg value}"
    ) environment
  );
  wrapperPath = lib.optionalString (
    pathPackages != [ ]
  ) "--prefix PATH : ${lib.escapeShellArg (lib.makeBinPath pathPackages)}";
  nativePackageLinks = lib.concatMapStringsSep "\n" (
    package:
    let
      components = lib.splitString "/" package.name;
      leaf = lib.last components;
      parent = lib.concatStringsSep "/" (lib.init components);
    in
    ''
      mkdir -p "$out/libexec/node_modules/${parent}"
      ln -s ${package.package} "$out/libexec/node_modules/${parent}/${leaf}"
    ''
  ) nativeNodePackages;
  smoke = lib.optionalString (smokeTestArgs != null && binaryName != null) ''
    "$out/bin/${binaryName}" ${lib.escapeShellArgs smokeTestArgs} >/dev/null
  '';
in
assert lib.assertMsg (
  actualKeys == expectedKeys
) "javascript-product-import: descriptor fields are not exact";
assert lib.assertMsg (
  value.schema == "effect-utils/javascript-product/v2"
) "javascript-product-import: unsupported descriptor schema";
assert lib.assertMsg (
  builtins.match "[0-9a-f]{64}" expectedDescriptorSha256 != null
) "javascript-product-import: expectedDescriptorSha256 must be lowercase SHA-256 hex";
assert lib.assertMsg (
  builtins.hashFile "sha256" descriptor == expectedDescriptorSha256
) "javascript-product-import: descriptor digest mismatch";
assert lib.assertMsg (
  value.productName == expectedProductName
) "javascript-product-import: product name mismatch";
assert lib.assertMsg (
  value.productKind == expectedProductKind
) "javascript-product-import: product kind mismatch";
assert lib.assertMsg (builtins.elem value.runtimeKind [
  "bun"
  "node"
]) "javascript-product-import: unsupported JavaScript runtime";
assert lib.assertMsg (
  value.runtimeContract == expectedRuntimeContract
) "javascript-product-import: runtime contract mismatch";
assert lib.assertMsg (
  value.runtimeContractVersion == expectedRuntimeContractVersion
) "javascript-product-import: runtime contract version mismatch";
assert lib.assertMsg (
  value.platform == {
    abi = "any";
    architecture = "any";
    os = "any";
  }
) "javascript-product-import: product is not platform-invariant";
assert lib.assertMsg (validRelativePath value.modulePath)
  "javascript-product-import: unsafe module path";
assert lib.assertMsg (
  normalizedActualCapabilities == normalizedExpectedCapabilities
) "javascript-product-import: external capability mismatch";
assert lib.assertMsg (
  normalizedActualModules == normalizedExpectedModules
) "javascript-product-import: external module mismatch";
assert lib.assertMsg (
  builtins.match "[0-9a-f]{64}" expectedModuleSha256 != null
) "javascript-product-import: expectedModuleSha256 must be lowercase SHA-256 hex";
assert lib.assertMsg (
  builtins.isInt value.sizeBytes && value.sizeBytes > 0
) "javascript-product-import: descriptor declares no payload size";
assert lib.assertMsg (
  builtins.match "sha256-[A-Za-z0-9+/]{43}=" value.integrity != null
) "javascript-product-import: integrity must be an SRI SHA-256 digest";
pkgs.runCommand "${expectedProductName}-buck2-candidate"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    passthru = {
      checkedDescriptor = value;
      inherit expectedDescriptorSha256 expectedModuleSha256;
    };
    meta = lib.optionalAttrs (binaryName != null) { mainProgram = binaryName; };
  }
  ''
    set -euo pipefail
    module_path=${lib.escapeShellArg value.modulePath}
    module_dir="$(${pkgs.coreutils}/bin/dirname "$module_path")"
    # The bytes are gated three ways against facts the descriptor itself
    # states: the tracked content address, the descriptor's SRI integrity, and
    # its declared size. Nothing here compares a producer path.
    actual="$(${pkgs.coreutils}/bin/sha256sum ${lib.escapeShellArg "${artifact}"} | ${pkgs.coreutils}/bin/cut -d ' ' -f 1)"
    if [ "$actual" != ${lib.escapeShellArg expectedModuleSha256} ]; then
      echo "javascript-product-import: module digest mismatch" >&2
      exit 1
    fi
    actual_integrity="sha256-$(${pkgs.openssl}/bin/openssl dgst -sha256 -binary ${lib.escapeShellArg "${artifact}"} \
      | ${pkgs.openssl}/bin/openssl base64 -A)"
    if [ "$actual_integrity" != ${lib.escapeShellArg value.integrity} ]; then
      echo "javascript-product-import: descriptor integrity does not match the module bytes" >&2
      exit 1
    fi
    actual_size="$(${pkgs.coreutils}/bin/stat --format=%s ${lib.escapeShellArg "${artifact}"})"
    if [ "$actual_size" != ${lib.escapeShellArg (toString value.sizeBytes)} ]; then
      echo "javascript-product-import: descriptor size does not match the module bytes" >&2
      exit 1
    fi
    mkdir -p "$out/libexec"
    mkdir -p "$out/libexec/$module_dir"
    cp ${lib.escapeShellArg "${artifact}"} "$out/libexec/$module_path"
    chmod 0444 "$out/libexec/$module_path"
    ${nativePackageLinks}
    ${lib.optionalString (binaryName != null) ''
      mkdir -p "$out/bin"
      makeWrapper ${runtime}/bin/${
        if value.runtimeKind == "bun" then "bun" else "node"
      } "$out/bin/${binaryName}" \
        --add-flags "$out/libexec/$module_path" \
        ${wrapperEnvironment} \
        ${wrapperPath}
    ''}
    ${lib.optionalString (generateCompletions && binaryName != null) ''
      mkdir -p "$out/share/fish/vendor_completions.d" "$out/share/bash-completion/completions" "$out/share/zsh/site-functions"
      generate_completion() {
        shell_name="$1"
        target="$2"
        if "$out/bin/${binaryName}" --log-level none --completions "$shell_name" > "$target" 2>/dev/null; then return; fi
        if "$out/bin/${binaryName}" --completions "$shell_name" > "$target" 2>/dev/null; then return; fi
        rm -f "$target"
      }
      generate_completion fish "$out/share/fish/vendor_completions.d/${binaryName}.fish"
      generate_completion bash "$out/share/bash-completion/completions/${binaryName}"
      generate_completion zsh "$out/share/zsh/site-functions/_${binaryName}"
    ''}
    ${smoke}
  ''
