#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

printf '%s\n' 'process.stdout.write("candidate-ok\n")' > "$tmp/tool.js"
digest="$(sha256sum "$tmp/tool.js" | cut -d ' ' -f 1)"
integrity="sha256-$(openssl dgst -sha256 -binary "$tmp/tool.js" | openssl base64 -A)"
size="$(stat --format=%s "$tmp/tool.js")"

# One v2 descriptor generator so every case differs only in the field under test.
write_descriptor() {
  local target="$1"
  local module_path="$2"
  local descriptor_integrity="$3"
  local descriptor_size="$4"
  local platform="$5"
  local external_modules="${6:-[]}"
  cat > "$target" <<JSON
{"externalCapabilities":[],"externalModules":$external_modules,"integrity":"$descriptor_integrity","modulePath":"$module_path","platform":$platform,"productKind":"cli","productName":"fixture","provenance":{"dependencyClosureIdentity":"/nix/store/irrelevant-producer/bin/bun;fixture","configuredTarget":"fixture//x:y (fixture//p:linux_x86_64#deadbeef)","module":"fixture//x:y-module"},"runtimeContract":"javascript-esm","runtimeContractVersion":"v1","runtimeKind":"node","schema":"effect-utils/javascript-product/v2","sizeBytes":$descriptor_size,"target":"fixture//x:y"}
JSON
}

portable='{"abi":"any","architecture":"any","os":"any"}'
native='{"abi":"glibc","architecture":"x86_64","os":"linux"}'

write_import() {
  local descriptor_digest="${4:-$(sha256sum "$2" | cut -d ' ' -f 1)}"
  cat > "$1" <<NIX
let
  pkgs = import <nixpkgs> {};
  importProduct = import ${repo_root}/nix/workspace-tools/lib/javascript-product-import.nix { inherit pkgs; };
in importProduct {
  artifact = ${tmp}/tool.js;
  descriptor = $2;
  expectedDescriptorSha256 = "${descriptor_digest}";
  expectedModuleSha256 = "${digest}";
  expectedProductKind = "cli";
  expectedProductName = "fixture";
  ${3:-}
  binaryName = "fixture";
  generateCompletions = false;
  smokeTestArgs = [];
}
NIX
}

write_descriptor "$tmp/product.json" tool.js "$integrity" "$size" "$portable"
write_import "$tmp/import.nix" "${tmp}/product.json"
result="$(nix-build --no-out-link "$tmp/import.nix")"
[ "$($result/bin/fixture)" = candidate-ok ]

# Descriptor bytes have an independently supplied content address.
write_import "$tmp/wrong-descriptor-digest-import.nix" "${tmp}/product.json" "" \
  "0000000000000000000000000000000000000000000000000000000000000000"
if nix-build --no-out-link "$tmp/wrong-descriptor-digest-import.nix" >/dev/null 2>&1; then
  echo "javascript-product-import accepted a mismatched descriptor digest" >&2
  exit 1
fi

# A hostile module path must never reach the shell.
write_descriptor "$tmp/hostile-product.json" "x/evil\\\"; touch $tmp/injected; #" "$integrity" "$size" "$portable"
write_import "$tmp/hostile-import.nix" "${tmp}/hostile-product.json"
if nix-build --no-out-link "$tmp/hostile-import.nix" >/dev/null 2>&1; then
  echo "javascript-product-import accepted a hostile modulePath" >&2
  exit 1
fi
[ ! -e "$tmp/injected" ]

# Integrity is gated against the bytes, not merely well-formed.
write_descriptor "$tmp/wrong-integrity.json" tool.js \
  "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" "$size" "$portable"
write_import "$tmp/wrong-integrity-import.nix" "${tmp}/wrong-integrity.json"
if nix-build --no-out-link "$tmp/wrong-integrity-import.nix" >/dev/null 2>&1; then
  echo "javascript-product-import accepted a descriptor whose integrity is not the module bytes" >&2
  exit 1
fi

# A declared size that does not match the bytes is rejected.
write_descriptor "$tmp/wrong-size.json" tool.js "$integrity" "$((size + 1))" "$portable"
write_import "$tmp/wrong-size-import.nix" "${tmp}/wrong-size.json"
if nix-build --no-out-link "$tmp/wrong-size-import.nix" >/dev/null 2>&1; then
  echo "javascript-product-import accepted a descriptor whose size is not the module size" >&2
  exit 1
fi

# A product claiming a host platform is not a portable JavaScript product.
write_descriptor "$tmp/native.json" tool.js "$integrity" "$size" "$native"
write_import "$tmp/native-import.nix" "${tmp}/native.json"
if nix-build --no-out-link "$tmp/native-import.nix" >/dev/null 2>&1; then
  echo "javascript-product-import accepted a non-portable platform" >&2
  exit 1
fi

# An external module set the consumer did not declare is rejected: the default
# is the empty set, so a product cannot grow a host dependency unnoticed.
write_descriptor "$tmp/undeclared-modules.json" tool.js "$integrity" "$size" "$portable" \
  '["@scope/native-linux-x64"]'
write_import "$tmp/undeclared-modules-import.nix" "${tmp}/undeclared-modules.json"
if nix-build --no-out-link "$tmp/undeclared-modules-import.nix" >/dev/null 2>&1; then
  echo "javascript-product-import accepted an undeclared external module" >&2
  exit 1
fi

# The same descriptor is accepted once the consumer declares that exact set,
# in any order.
write_import "$tmp/declared-modules-import.nix" "${tmp}/undeclared-modules.json" \
  'expectedExternalModules = [ "@scope/native-linux-x64" ];'
nix-build --no-out-link "$tmp/declared-modules-import.nix" >/dev/null

# A declared set the product does not ask for is rejected too: the comparison
# is exact, not a subset check.
write_import "$tmp/surplus-modules-import.nix" "${tmp}/product.json" \
  'expectedExternalModules = [ "@scope/native-linux-x64" ];'
if nix-build --no-out-link "$tmp/surplus-modules-import.nix" >/dev/null 2>&1; then
  echo "javascript-product-import accepted a surplus declared external module" >&2
  exit 1
fi

echo "javascript-product-import: OK"
