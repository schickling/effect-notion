#!/usr/bin/env bash
# Contract test for the immutable Buck JavaScript product release manifest.
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export BUCK2_RELEASE_PRODUCTS_REPO="$repo_root"

loader_expr='pkgs = {
    fetchurl = release: release;
    lib = {
      assertMsg = condition: message: if condition then true else throw message;
      unique = builtins.foldl'\'' (
        seen: value: if builtins.elem value seen then seen else seen ++ [ value ]
      ) [ ];
    };
  };'

eval_loader() {
  local root="$1"
  nix eval --impure --json --expr "let
    $loader_expr
    tracked = import ${root} { inherit pkgs; };
  in {
    inherit (tracked) declaredProductNames publishedProductNames fullyPublished;
    releases = builtins.mapAttrs (_: product: product.release) tracked.products;
  }"
}

expect_failure() {
  local label="$1"
  local expected="$2"
  local log="$tmp/failure.log"
  if eval_loader "$tmp/products" >"$log" 2>&1; then
    echo "buck2-release-products-test: expected $label to fail" >&2
    exit 1
  fi
  if ! grep -F "$expected" "$log" >/dev/null; then
    echo "buck2-release-products-test: $label failed without expected diagnostic: $expected" >&2
    sed -n '1,160p' "$log" >&2
    exit 1
  fi
  echo "buck2-release-products-test: RED $label"
}

summary="$(eval_loader "$repo_root/nix/buck2-products")"
expected_names='["ci-tools","genie","genie-bootstrap-closure-check","megarepo","notion-cli","notion-db-runtime","notion-md","npm-release","oxc-config","tui-stories"]'

jq -e --argjson expected "$expected_names" '
  .fullyPublished == true and
  .declaredProductNames == $expected and
  .publishedProductNames == $expected and
  (.releases | keys) == $expected and
  all(
    .releases | to_entries[];
    .key as $product |
    (.value.tag | sub("^buck2-product-\($product)-"; "")) as $digest |
    ($digest | test("^[0-9a-f]{64}$")) and
    (.value.name | startswith("\($digest)-")) and
    .value.url == "https://github.com/overengineeringstudio/effect-utils/releases/download/\(.value.tag)/\(.value.name)"
  )
' <<<"$summary" >/dev/null

mkdir -p "$tmp/products"
cp "$repo_root/nix/buck2-products/default.nix" "$tmp/products/default.nix"

write_mutation() {
  jq "$1" "$repo_root/nix/buck2-products/manifest.json" >"$tmp/products/manifest.json"
}

write_mutation '.schema = "effect-utils/buck2-release-products/v0"'
expect_failure "unsupported manifest schema" "unsupported manifest schema"

write_mutation '.products += [.products[0]]'
expect_failure "duplicate product" "product names must be unique"

write_mutation '.products[0].descriptor.platform.os = "linux"'
expect_failure "platform-specific descriptor" "is not platform-invariant"

write_mutation '.products[0].descriptor.sizeBytes += 1'
expect_failure "descriptor mutation" "canonical descriptor digest mismatch"

write_mutation '.products[0].release.tag += "-mutable"'
expect_failure "release tag drift" "release tag does not match its product and payload digest"

write_mutation '.products[0].release.name += ".renamed"'
expect_failure "release asset name drift" "release asset name does not match its payload digest and module path"

write_mutation '.products[0].release.url = "https://example.invalid/payload"'
expect_failure "release URL drift" "release URL does not match its tag and asset name"

write_mutation '.products[0].release.hash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="'
expect_failure "release hash drift" "release hash does not match descriptor integrity"

jq -r '.releases | to_entries[] | "buck2-release-products-test: \(.key) \(.value.tag)"' <<<"$summary"
echo "buck2-release-products-test: OK"
