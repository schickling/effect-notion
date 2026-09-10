#!/usr/bin/env bash
# Contract test for the Buck JavaScript product import boundary.
#
# The boundary is a pure evaluation contract: every expectation it states about
# a descriptor is decided before a single byte is fetched. The test therefore
# evaluates it against a stubbed `pkgs` (no nixpkgs, no build), asserts the
# accepted case, and asserts that each violated expectation fails with its own
# diagnostic. The byte-level gates run inside the installer script, so they are
# proven here by the script text the boundary emits.
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

module="$tmp/tool.js"
printf '%s\n' 'process.stdout.write("candidate-ok\n")' >"$module"
module_digest="$(sha256sum "$module" | cut -d ' ' -f 1)"
integrity="sha256-$(openssl dgst -sha256 -binary "$module" | openssl base64 -A)"
size="$(stat --format=%s "$module")"

# Stubbed `pkgs`: every referenced package is a sentinel string and
# `runCommand` records the installer script instead of building it, so the
# whole contract is observable with `nix eval` alone.
cat >"$tmp/stub.nix" <<'NIX'
{
  lib = {
    assertMsg = condition: message: if condition then true else throw message;
    concatStringsSep = builtins.concatStringsSep;
    concatMapStringsSep = separator: f: list: builtins.concatStringsSep separator (map f list);
    mapAttrsToList = f: attrs: map (name: f name attrs.${name}) (builtins.attrNames attrs);
    escapeShellArg = arg: "'" + builtins.replaceStrings [ "'" ] [ "'\\''" ] (toString arg) + "'";
    escapeShellArgs =
      args:
      builtins.concatStringsSep " " (
        map (arg: "'" + builtins.replaceStrings [ "'" ] [ "'\\''" ] (toString arg) + "'") args
      );
    optionalString = condition: text: if condition then text else "";
    optionalAttrs = condition: attrs: if condition then attrs else { };
    makeBinPath = paths: builtins.concatStringsSep ":" (map (path: "${toString path}/bin") paths);
    splitString =
      separator: text: builtins.filter builtins.isString (builtins.split separator text);
    init = list: builtins.genList (index: builtins.elemAt list index) (builtins.length list - 1);
    last = list: builtins.elemAt list (builtins.length list - 1);
  };
  bun = "/stub/bun";
  coreutils = "/stub/coreutils";
  makeWrapper = "/stub/make-wrapper";
  nodejs = "/stub/nodejs";
  openssl = "/stub/openssl";
  runCommand = name: attrs: script: {
    type = "derivation";
    outPath = "/nix/store/test-${name}";
    inherit name attrs script;
  };
}
NIX

portable='{"abi":"any","architecture":"any","os":"any"}'
native='{"abi":"glibc","architecture":"x86_64","os":"linux"}'

# One v2 descriptor generator so every case differs only in the field under
# test.
write_descriptor() {
  local target="$1"
  local product_name="${2:-fixture}"
  local product_kind="${3:-cli}"
  local runtime_contract="${4:-javascript-esm}"
  local platform="${5:-$portable}"
  local capabilities="${6:-[]}"
  local modules="${7:-[]}"
  local module_path="${8:-tool.js}"
  cat >"$target" <<JSON
{"externalCapabilities":$capabilities,"externalModules":$modules,"integrity":"$integrity","modulePath":"$module_path","platform":$platform,"productKind":"$product_kind","productName":"$product_name","provenance":{"configuredTarget":"fixture//x:y (fixture//p:javascript_portable#deadbeef)","dependencyClosureIdentity":"runtime=node;package_tree=fixture//x:package_tree","module":"fixture//x:y-module"},"runtimeContract":"$runtime_contract","runtimeContractVersion":"v1","runtimeKind":"node","schema":"effect-utils/javascript-product/v2","sizeBytes":$size,"target":"fixture//x:y"}
JSON
}

write_case() {
  local target="$1"
  local descriptor="$2"
  local extra="${3:-}"
  local descriptor_digest="${4:-$(sha256sum "$descriptor" | cut -d ' ' -f 1)}"
  cat >"$target" <<NIX
let
  pkgs = import $tmp/stub.nix;
  importProduct = import $repo_root/nix/workspace-tools/lib/javascript-product-import.nix {
    inherit pkgs;
  };
  candidate = importProduct {
    artifact = "$module";
    descriptor = "$descriptor";
    descriptorContent = builtins.readFile "$descriptor";
    expectedDescriptorSha256 = "$descriptor_digest";
    expectedModuleSha256 = "$module_digest";
    expectedProductKind = "cli";
    expectedProductName = "fixture";
    $extra
    binaryName = "fixture";
    generateCompletions = false;
    smokeTestArgs = [ ];
  };
in
{
  inherit (candidate) name script;
  inherit (candidate.attrs.passthru) checkedDescriptor;
  mainProgram = candidate.attrs.meta.mainProgram;
}
NIX
}

eval_case() {
  nix eval --impure --json --file "$1"
}

expect_failure() {
  local label="$1"
  local expected="$2"
  local case_file="$3"
  local log="$tmp/failure.log"
  if eval_case "$case_file" >"$log" 2>&1; then
    echo "javascript-product-import-test: expected $label to fail" >&2
    exit 1
  fi
  if ! grep -F "$expected" "$log" >/dev/null; then
    echo "javascript-product-import-test: $label failed without expected diagnostic: $expected" >&2
    sed -n '1,160p' "$log" >&2
    exit 1
  fi
  echo "javascript-product-import-test: RED $label"
}

# GREEN: a tracked descriptor whose declarations the consumer restates exactly.
write_descriptor "$tmp/product.json"
write_case "$tmp/valid.nix" "$tmp/product.json"
valid="$(eval_case "$tmp/valid.nix")"
jq -e --arg digest "$module_digest" --arg integrity "$integrity" --arg size "$size" '
  .name == "fixture-buck2-candidate" and
  .mainProgram == "fixture" and
  .checkedDescriptor.productName == "fixture" and
  .checkedDescriptor.modulePath == "tool.js" and
  (.script | contains("\($digest)")) and
  (.script | contains("\($integrity)")) and
  (.script | contains("--format=%s")) and
  (.script | contains($size)) and
  (.script | contains("module digest mismatch")) and
  (.script | contains("descriptor integrity does not match the module bytes")) and
  (.script | contains("descriptor size does not match the module bytes")) and
  (.script | contains("chmod 0444"))
' <<<"$valid" >/dev/null
echo "javascript-product-import-test: GREEN tracked descriptor imports"

# GREEN: the wrapper contract the consumer declares reaches the installer —
# environment, PATH packages, and the linked native module family.
write_descriptor "$tmp/native-modules.json" fixture cli javascript-esm \
  "$portable" '["watchman"]' '["@scope/native-linux-x64"]'
write_case "$tmp/wrapper.nix" "$tmp/native-modules.json" '
    expectedExternalCapabilities = [ "watchman" ];
    expectedExternalModules = [ "@scope/native-linux-x64" ];
    environment.FIXTURE_STAMP = "{\"type\":\"nix\"}";
    pathPackages = [ "/stub/watchman" ];
    nativeNodePackages = [
      {
        name = "@scope/native-linux-x64";
        package = "/stub/native-linux-x64";
      }
    ];'
wrapper="$(eval_case "$tmp/wrapper.nix")"
jq -e --arg q "'" '
  (.script | contains("--set " + $q + "FIXTURE_STAMP" + $q)) and
  (.script | contains("--prefix PATH : " + $q + "/stub/watchman/bin" + $q)) and
  (.script | contains("$out/libexec/node_modules/@scope")) and
  (.script | contains("ln -s /stub/native-linux-x64"))
' <<<"$wrapper" >/dev/null
echo "javascript-product-import-test: GREEN wrapper contract reaches the installer"

# The descriptor bytes have an independently supplied content address.
write_case "$tmp/wrong-descriptor-digest.nix" "$tmp/product.json" "" \
  0000000000000000000000000000000000000000000000000000000000000000
expect_failure "mismatched descriptor digest" "descriptor digest mismatch" \
  "$tmp/wrong-descriptor-digest.nix"

# The product this consumer wired must be the product it got.
write_descriptor "$tmp/other-name.json" other-fixture
write_case "$tmp/other-name.nix" "$tmp/other-name.json"
expect_failure "product name mismatch" "product name mismatch" "$tmp/other-name.nix"

# A module is not a CLI: the wrapper contract differs, so the kind is gated.
write_descriptor "$tmp/module-kind.json" fixture module
write_case "$tmp/module-kind.nix" "$tmp/module-kind.json"
expect_failure "product kind mismatch" "product kind mismatch" "$tmp/module-kind.nix"

# The runtime contract names how the bytes are entered; a different contract is
# a different calling convention, not a newer product.
write_descriptor "$tmp/other-contract.json" fixture cli javascript-cjs
write_case "$tmp/other-contract.nix" "$tmp/other-contract.json"
expect_failure "runtime contract mismatch" "runtime contract mismatch" "$tmp/other-contract.nix"

# A product claiming a host platform is not a portable JavaScript product.
write_descriptor "$tmp/native-platform.json" fixture cli javascript-esm "$native"
write_case "$tmp/native-platform.nix" "$tmp/native-platform.json"
expect_failure "platform-specific descriptor" "is not platform-invariant" \
  "$tmp/native-platform.nix"

# A capability the consumer did not declare is rejected: the default is the
# empty set, so a product cannot grow a host tool unnoticed.
write_descriptor "$tmp/undeclared-capability.json" fixture cli javascript-esm \
  "$portable" '["watchman"]'
write_case "$tmp/undeclared-capability.nix" "$tmp/undeclared-capability.json"
expect_failure "undeclared external capability" "external capability mismatch" \
  "$tmp/undeclared-capability.nix"

# The comparison is exact, not a subset check: a declared capability the
# product does not ask for is rejected too.
write_case "$tmp/surplus-capability.nix" "$tmp/product.json" \
  'expectedExternalCapabilities = [ "watchman" ];'
expect_failure "surplus declared capability" "external capability mismatch" \
  "$tmp/surplus-capability.nix"

# Same contract for the bare imports the product leaves to the host.
write_descriptor "$tmp/undeclared-module.json" fixture cli javascript-esm \
  "$portable" '[]' '["@scope/native-linux-x64"]'
write_case "$tmp/undeclared-module.nix" "$tmp/undeclared-module.json"
expect_failure "undeclared external module" "external module mismatch" \
  "$tmp/undeclared-module.nix"

write_case "$tmp/surplus-module.nix" "$tmp/product.json" \
  'expectedExternalModules = [ "@scope/native-linux-x64" ];'
expect_failure "surplus declared external module" "external module mismatch" \
  "$tmp/surplus-module.nix"

# The declared set is accepted in any order: the comparison is order-independent.
write_descriptor "$tmp/two-modules.json" fixture cli javascript-esm \
  "$portable" '[]' '["@scope/native-darwin-arm64","@scope/native-linux-x64"]'
write_case "$tmp/two-modules.nix" "$tmp/two-modules.json" '
    expectedExternalModules = [
      "@scope/native-linux-x64"
      "@scope/native-darwin-arm64"
    ];'
eval_case "$tmp/two-modules.nix" >/dev/null
echo "javascript-product-import-test: GREEN external module set compares order-independently"

# A hostile module path must never reach the installer script.
write_descriptor "$tmp/hostile.json" fixture cli javascript-esm \
  "$portable" '[]' '[]' 'x/../../etc/passwd'
write_case "$tmp/hostile.nix" "$tmp/hostile.json"
expect_failure "unsafe module path" "unsafe module path" "$tmp/hostile.nix"

echo "javascript-product-import: OK"
