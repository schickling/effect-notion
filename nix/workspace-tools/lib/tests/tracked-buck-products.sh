#!/usr/bin/env bash
# Contract test for the tracked Buck product loader.
set -euo pipefail

repo_root="${1:-$PWD}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

eval_expr() {
  nix eval --impure --raw --expr "$1"
}

expect_failure() {
  local label="$1"
  local expr="$2"
  if nix eval --impure --expr "$expr" >/dev/null 2>&1; then
    echo "tracked-buck-products: expected failure for $label" >&2
    exit 1
  fi
}

# The committed spec and manifest must always evaluate, published or not.
declared="$(eval_expr "
  let
    pkgs = import <nixpkgs> {};
    tracked = import ${repo_root}/nix/buck2-products { inherit (pkgs) lib; };
  in builtins.concatStringsSep \",\" tracked.declaredProductNames
")"
for expected in ci-tools genie genie-bootstrap-closure-check megarepo notion-cli notion-db-runtime notion-md npm-release oxc-config tui-stories; do
  case ",$declared," in
  *",$expected,"*) ;;
  *)
    echo "tracked-buck-products: spec is missing declared product $expected" >&2
    exit 1
    ;;
  esac
done

# A published fixture resolves to its tracked bytes.
fixture="$tmp/products"
mkdir -p "$fixture/fixture"
printf 'export default {}\n' >"$fixture/fixture/module.js"
digest="$(sha256sum "$fixture/fixture/module.js" | cut -d ' ' -f 1)"
mv "$fixture/fixture/module.js" "$fixture/fixture/$digest-module.js"
printf '{}\n' >"$fixture/fixture/product.json"
descriptor_digest="$(sha256sum "$fixture/fixture/product.json" | cut -d ' ' -f 1)"

write_spec() {
  cat >"$fixture/products.json" <<JSON
{
  "schema": "effect-utils/tracked-buck-products-spec/v1",
  "products": [
    {
      "descriptorPath": "fixture/product.json",
      "label": "//fixture:fixture-candidate",
      "module": "module.js",
      "productKind": "cli",
      "productName": "fixture",
      "runtimeKind": "node"
    }
  ]
}
JSON
}

write_manifest() {
  cat >"$fixture/manifest.json" <<JSON
{
  "schema": "effect-utils/tracked-buck-products/v1",
  "products": {
    "fixture": {
      "artifact": "$1",
      "descriptorSha256": "$descriptor_digest",
      "label": "//fixture:fixture-candidate",
      "moduleSha256": "$2"
    }
  }
}
JSON
}

cp "$repo_root/nix/buck2-products/default.nix" "$fixture/default.nix"
write_spec
write_manifest "fixture/$digest-module.js" "$digest"

resolved="$(eval_expr "
  let
    pkgs = import <nixpkgs> {};
    tracked = import ${fixture} { inherit (pkgs) lib; };
  in \"\${tracked.products.fixture.expectedDescriptorSha256},\${tracked.products.fixture.expectedModuleSha256}\"
")"
[ "$resolved" = "$descriptor_digest,$digest" ]

# A path that is not content-addressed by its recorded digest is rejected.
write_manifest "fixture/module.js" "$digest"
expect_failure "non-content-addressed artifact" "
  let
    pkgs = import <nixpkgs> {};
    tracked = import ${fixture} { inherit (pkgs) lib; };
  in tracked.products.fixture
"

# An undeclared publication is rejected outright.
write_manifest "fixture/$digest-module.js" "$digest"
"${JQ_BIN:-jq}" '.products.rogue = .products.fixture' "$fixture/manifest.json" >"$fixture/manifest.next"
mv "$fixture/manifest.next" "$fixture/manifest.json"
expect_failure "undeclared publication" "
  let
    pkgs = import <nixpkgs> {};
  in (import ${fixture} { inherit (pkgs) lib; }).declaredProductNames
"

echo "tracked-buck-products: OK"
