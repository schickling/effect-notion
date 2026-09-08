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

publisher="$repo_root/nix/buck2-products/publish.sh"
test -x "$publisher"
cp "$repo_root/nix/buck2-products/manifest.json" "$tmp/manifest.before.json"

# Planning is a pure use of the same inventory contract. Put sentinels for all
# network/mutation tools first on PATH so an accidental call is observable.
mkdir -p "$tmp/bin"
for tool in buck2 gh; do
  cat >"$tmp/bin/$tool" <<EOF
#!/usr/bin/env bash
printf '%s invoked\\n' '$tool' >>'$tmp/unexpected-tools'
exit 97
EOF
  chmod +x "$tmp/bin/$tool"
done
plan="$(PATH="$tmp/bin:$PATH" "$publisher" --dry-run)"
test ! -e "$tmp/unexpected-tools"
cmp "$repo_root/nix/buck2-products/manifest.json" "$tmp/manifest.before.json"
jq -e --argjson expected "$expected_names" '
  .schema == "effect-utils/buck2-product-publication-plan/v1" and
  .repository == "overengineeringstudio/effect-utils" and
  [.products[].productName] == $expected and
  (.products | length == 10) and
  all(
    .products[];
    (.candidateTarget | test("^([A-Za-z0-9_]+)?//")) and
    (.descriptorTarget == (.candidateTarget + "[descriptor]"))
  )
' <<<"$plan" >/dev/null

publish_failure="$tmp/publish-failure.log"
if GITHUB_EVENT_NAME=pull_request PATH="$tmp/bin:$PATH" "$publisher" --dry-run >"$publish_failure" 2>&1; then
  echo "buck2-release-products-test: publisher accepted a pull-request event" >&2
  exit 1
fi
grep -F "refusing untrusted GitHub event: pull_request" "$publish_failure" >/dev/null
test ! -e "$tmp/unexpected-tools"

legacy_tool="$(printf '%s%s' 'ca' 'chix')"
legacy_token="$(printf '%s%s%s' 'CA' 'CHIX_AUTH_' 'TOKEN')"
mkdir -p "$tmp/refusal-bin"
for tool in buck2 gh "$legacy_tool"; do
  cat >"$tmp/refusal-bin/$tool" <<EOF
#!/usr/bin/env bash
printf '%s invoked\\n' '$tool' >>'$tmp/unexpected-tools'
exit 97
EOF
  chmod +x "$tmp/refusal-bin/$tool"
done
cat >"$tmp/refusal-bin/git" <<EOF
#!/usr/bin/env bash
printf 'git invoked\\n' >>'$tmp/refusal-tools'
case "\$*" in
  *rev-parse*) printf '%040d\\n' 0 ;;
  *status*) printf 'dirty sentinel\\n' ;;
  *) exit 97 ;;
esac
EOF
chmod +x "$tmp/refusal-bin/git"
if env -u "$legacy_token" PATH="$tmp/refusal-bin:$PATH" "$publisher" >"$publish_failure" 2>&1; then
  echo "buck2-release-products-test: publisher accepted a dirty worktree" >&2
  exit 1
fi
grep -F "refusing to publish from a dirty Git worktree" "$publish_failure" >/dev/null
grep -F "git invoked" "$tmp/refusal-tools" >/dev/null
test ! -e "$tmp/unexpected-tools"
legacy_cache_path="$(printf '%s%s' 'dev3-' 'cache')"
for forbidden in "$legacy_tool" "$legacy_token" "$legacy_cache_path"; do
  if grep -Fi "$forbidden" "$publisher" >/dev/null; then
    echo "buck2-release-products-test: publisher still references removed product-store backend" >&2
    exit 1
  fi
done

jq '.products[1].descriptor.target = .products[0].descriptor.target' \
  "$repo_root/nix/buck2-products/manifest.json" >"$tmp/duplicate-target.json"
if PATH="$tmp/bin:$PATH" "$publisher" --dry-run --inventory "$tmp/duplicate-target.json" >"$publish_failure" 2>&1; then
  echo "buck2-release-products-test: publisher accepted a duplicate candidate target" >&2
  exit 1
fi
grep -F "inventory violates effect-utils/buck2-release-products/v1" "$publish_failure" >/dev/null
test ! -e "$tmp/unexpected-tools"

if grep -F -- '--clobber' "$publisher" >/dev/null; then
  echo "buck2-release-products-test: publisher permits release asset clobbering" >&2
  exit 1
fi
if grep -E '(^|[[:space:]])set[[:space:]]+-[^[:space:]]*x' "$publisher" >/dev/null; then
  echo "buck2-release-products-test: publisher enables shell tracing around secrets" >&2
  exit 1
fi
cmp "$repo_root/nix/buck2-products/manifest.json" "$tmp/manifest.before.json"
echo "buck2-release-products-test: publisher dry-run/refusal OK"
echo "buck2-release-products-test: OK"
