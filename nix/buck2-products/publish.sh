#!/usr/bin/env bash
# Publishes the complete Buck JavaScript product inventory as immutable releases.
set -euo pipefail

repo_root="${BUCK2_RELEASE_PRODUCTS_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
inventory="$repo_root/nix/buck2-products/manifest.json"
repository="overengineeringstudio/effect-utils"
dry_run=false
proposal=""

fail() {
  printf 'buck2-products-publish: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: nix/buck2-products/publish.sh [--dry-run] [--inventory PATH] [--proposal PATH]

--dry-run         Validate the inventory and print the complete build/publication plan.
--inventory PATH  Read the single release inventory contract from PATH.
--proposal PATH   Write the proposed manifest outside the Git worktree (live mode only).
                   Without this option the proposed manifest is emitted on stdout.
EOF
}

while (($#)); do
  case "$1" in
    --dry-run)
      dry_run=true
      shift
      ;;
    --inventory)
      (($# >= 2)) || fail "--inventory requires a path"
      inventory="$2"
      shift 2
      ;;
    --proposal)
      (($# >= 2)) || fail "--proposal requires a path"
      proposal="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ -f "$inventory" && ! -L "$inventory" ]] || fail "inventory must be a regular, non-symlink file: $inventory"
command -v jq >/dev/null || fail "jq is required"

# This mutation surface is deliberately unavailable to pull-request jobs, even
# in planning mode. A PR may run the separate contract test, never this tool.
if [[ -n "${GITHUB_EVENT_NAME:-}" && "${GITHUB_EVENT_NAME}" != "workflow_dispatch" ]]; then
  fail "refusing untrusted GitHub event: ${GITHUB_EVENT_NAME}"
fi

inventory_check='
  (type == "object") and
  ((keys | sort) == ["products", "schema"]) and
  (.schema == "effect-utils/buck2-release-products/v1") and
  (.products | type == "array" and length > 0) and
  (all(.products[];
    type == "object" and
    ((keys | sort) == ["descriptor", "descriptorSha256", "release"]) and
    (.descriptor | type == "object") and
    (.descriptor.productName | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._+-]*$")) and
    (.descriptor.target | type == "string" and test("^([A-Za-z0-9_]+)?//[^[:space:]\\[\\]]+:[^[:space:]\\[\\]]+$"))
  )) and
  ([.products[].descriptor.productName] | length == (unique | length)) and
  ([.products[].descriptor.target] | length == (unique | length))'
if ! jq -e "$inventory_check" "$inventory" >/dev/null; then
  fail "inventory violates effect-utils/buck2-release-products/v1"
fi

plan="$({
  jq -cS '{
    schema: "effect-utils/buck2-product-publication-plan/v1",
    repository: "overengineeringstudio/effect-utils",
    products: [.products[] | {
      productName: .descriptor.productName,
      candidateTarget: .descriptor.target,
      descriptorTarget: (.descriptor.target + "[descriptor]")
    }] | sort_by(.productName)
  }' "$inventory"
})"

if $dry_run; then
  [[ -z "$proposal" ]] || fail "--proposal is unavailable in dry-run mode"
  printf '%s\n' "$plan"
  exit 0
fi

for tool in buck2 gh nix sha256sum stat cmp cp mktemp realpath git; do
  command -v "$tool" >/dev/null || fail "$tool is required"
done

if [[ -n "$proposal" ]]; then
  proposal="$(realpath -m "$proposal")"
  canonical_repo="$(realpath "$repo_root")"
  case "$proposal" in
    "$canonical_repo"|"$canonical_repo"/*) fail "proposal output must be outside the Git worktree" ;;
  esac
  [[ ! -e "$proposal" ]] || fail "refusing to overwrite proposal output: $proposal"
fi
head_commit="$(git -C "$repo_root" rev-parse --verify 'HEAD^{commit}')"
publication_commit="${GITHUB_SHA:-$head_commit}"
[[ "$publication_commit" =~ ^[0-9a-f]{40}$ ]] || fail "publication commit is not a full Git SHA"
[[ "$publication_commit" == "$head_commit" ]] ||
  fail "GITHUB_SHA does not identify the checked-out commit"
[[ -z "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]] ||
  fail "refusing to publish from a dirty Git worktree"



existing_tags="$(gh api --paginate "repos/$repository/releases" --jq '.[].tag_name')"
stage="$(mktemp -d)"
cleanup_release_id=""
cleanup() {
  status=$?
  if [[ -n "$cleanup_release_id" ]]; then
    gh api --method DELETE "repos/$repository/releases/$cleanup_release_id" --silent >/dev/null 2>&1 || true
  fi
  rm -rf "$stage"
  exit "$status"
}
trap cleanup EXIT

mapfile -t product_rows < <(jq -r '.products | sort_by(.descriptor.productName)[] | [.descriptor.productName, .descriptor.target] | @tsv' "$inventory")
((${#product_rows[@]} > 0)) || fail "inventory contains no products"

declare -a build_targets=()
for row in "${product_rows[@]}"; do
  IFS=$'\t' read -r product_name target <<<"$row"
  [[ -n "$product_name" && -n "$target" ]] || fail "inventory contains an incomplete product declaration"
  build_targets+=("$target" "$target[descriptor]")
done

build_outputs="$stage/build-outputs"
buck2 build --show-full-output "${build_targets[@]}" >"$build_outputs"
declare -A outputs=()
while IFS=' ' read -r label path extra; do
  [[ -n "$label" && -n "$path" && -z "${extra:-}" ]] || fail "Buck returned a malformed output record"
  [[ -z "${outputs[$label]+present}" ]] || fail "Buck returned duplicate output for $label"
  outputs["$label"]="$path"
done <"$build_outputs"
((${#outputs[@]} == ${#build_targets[@]})) || fail "Buck output set does not exactly match the inventory build plan"
for target in "${build_targets[@]}"; do
  [[ -n "${outputs[$target]+present}" ]] || fail "Buck returned no output for $target"
done

entries="$stage/entries.jsonl"
: >"$entries"
declare -a staged_modules=()
declare -a release_tags=()
declare -a asset_names=()
for row in "${product_rows[@]}"; do
  IFS=$'\t' read -r product_name target <<<"$row"
  source_module="${outputs[$target]}"
  source_descriptor="${outputs[$target[descriptor]]}"
  [[ -f "$source_module" && ! -L "$source_module" ]] || fail "$product_name module output is not a regular file"
  [[ -f "$source_descriptor" && ! -L "$source_descriptor" ]] || fail "$product_name descriptor output is not a regular file"

  descriptor="$(jq -cS . "$source_descriptor")" || fail "$product_name descriptor is not JSON"
  if ! jq -e --arg name "$product_name" --arg target "$target" '
    (keys | sort) == ["externalCapabilities","externalModules","integrity","modulePath","platform","productKind","productName","provenance","runtimeContract","runtimeContractVersion","runtimeKind","schema","sizeBytes","target"] and
    .schema == "effect-utils/javascript-product/v2" and
    .productName == $name and .target == $target and
    (.productKind == "cli" or .productKind == "module") and
    (.runtimeKind == "bun" or .runtimeKind == "node") and
    .runtimeContract == "javascript-esm" and .runtimeContractVersion == "v1" and
    .platform == {"abi":"any","architecture":"any","os":"any"} and
    (.modulePath | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._+-]*(/[A-Za-z0-9][A-Za-z0-9._+-]*)*$")) and
    (.integrity | type == "string" and test("^sha256-[A-Za-z0-9+/]{43}=$")) and
    (.sizeBytes | type == "number" and . > 0 and floor == .) and
    (.externalCapabilities | type == "array" and all(.[]; type == "string")) and
    (.externalModules | type == "array" and all(.[]; type == "string")) and
    (.provenance | type == "object" and
      (keys | sort) == ["configuredTarget","dependencyClosureIdentity","module"] and
      all(.[]; type == "string" and contains("/nix/store/") == false)
    )' <<<"$descriptor" >/dev/null; then
    fail "$product_name descriptor violates effect-utils/javascript-product/v2"
  fi

  module_path="$(jq -r '.modulePath' <<<"$descriptor")"
  product_stage="$stage/products/$product_name"
  mkdir -p "$product_stage/$(dirname "$module_path")"
  staged_module="$product_stage/$module_path"
  cp -- "$source_module" "$staged_module"
  cmp -- "$source_module" "$staged_module" || fail "$product_name staged module bytes changed"
  actual_size="$(stat -c '%s' "$staged_module")"
  expected_size="$(jq -r '.sizeBytes' <<<"$descriptor")"
  [[ "$actual_size" == "$expected_size" ]] || fail "$product_name module size does not match its descriptor"
  module_sha256="$(sha256sum "$staged_module")"
  module_sha256="${module_sha256%% *}"
  descriptor_sha256="$(printf '%s' "$descriptor" | sha256sum)"
  descriptor_sha256="${descriptor_sha256%% *}"
  integrity="$(jq -r '.integrity' <<<"$descriptor")"
  integrity_hex="$(nix hash convert --hash-algo sha256 --to base16 "$integrity")"
  [[ "$module_sha256" == "$integrity_hex" ]] || fail "$product_name module digest does not match its descriptor"

  tag="buck2-product-$product_name-$module_sha256"
  asset_name="$module_sha256-$module_path"
  if grep -Fqx -- "$tag" <<<"$existing_tags"; then
    fail "release tag already exists; refusing to clobber: $tag"
  fi
  release_url="https://github.com/$repository/releases/download/$tag/$asset_name"
  jq -cnS \
    --argjson descriptor "$descriptor" \
    --arg descriptorSha256 "$descriptor_sha256" \
    --arg tag "$tag" --arg name "$asset_name" --arg url "$release_url" --arg hash "$integrity" \
    '{descriptor:$descriptor, descriptorSha256:$descriptorSha256, release:{tag:$tag,name:$name,url:$url,hash:$hash}}' >>"$entries"
  staged_modules+=("$staged_module")
  release_tags+=("$tag")
  asset_names+=("$asset_name")
done

proposal_stage="$stage/manifest.json"
jq -sS '{schema:"effect-utils/buck2-release-products/v1",products:.}' "$entries" >"$proposal_stage"
[[ "$(git -C "$repo_root" rev-parse --verify 'HEAD^{commit}')" == "$publication_commit" ]] ||
  fail "checked-out commit changed while staging products"
[[ -z "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]] ||
  fail "Git worktree changed while staging products"


for index in "${!release_tags[@]}"; do
  tag="${release_tags[$index]}"
  asset_name="${asset_names[$index]}"
  staged_module="${staged_modules[$index]}"
  created="$(gh api --method POST "repos/$repository/releases" \
    -f tag_name="$tag" -f name="$tag" -f target_commitish="$publication_commit" \
    -F draft=true -F prerelease=false -F generate_release_notes=false)"
  cleanup_release_id="$(jq -er '.id | select(type == "number")' <<<"$created")" || fail "GitHub did not return a draft release id"
  jq -e --arg tag "$tag" '.draft == true and .tag_name == $tag and (.assets | length == 0)' <<<"$created" >/dev/null ||
    fail "new release is not the requested empty draft"

  gh release upload "$tag" "$staged_module#$asset_name" --repo "$repository"
  gh api --method PATCH "repos/$repository/releases/$cleanup_release_id" -F draft=false --silent

  verified="$(gh api graphql \
    -f query='query($owner:String!,$name:String!,$tag:String!){repository(owner:$owner,name:$name){release(tagName:$tag){isImmutable}}}' \
    -f owner="${repository%%/*}" -f name="${repository#*/}" -f tag="$tag")"
  jq -e '.data.repository.release.isImmutable == true' <<<"$verified" >/dev/null || fail "$tag did not become immutable"
  release="$(gh api "repos/$repository/releases/tags/$tag")"
  expected_digest="sha256:$(sha256sum "$staged_module")"
  expected_digest="${expected_digest%% *}"
  jq -e --arg name "$asset_name" --arg digest "$expected_digest" \
    '.draft == false and .immutable == true and (.assets | length == 1) and .assets[0].name == $name and .assets[0].digest == $digest' \
    <<<"$release" >/dev/null || fail "$tag asset set or digest does not match the staged module"
  gh attestation verify "$staged_module" --repo "$repository" >/dev/null
  cleanup_release_id=""
done

import_root="$stage/import"
mkdir -p "$import_root"
cp -- "$repo_root/nix/buck2-products/default.nix" "$import_root/default.nix"
cp -- "$proposal_stage" "$import_root/manifest.json"
mapfile -t realized_paths < <(nix build --no-link --print-out-paths --impure --expr "let
  pkgs = import <nixpkgs> { };
  tracked = import ${import_root} { inherit pkgs; };
  paths = builtins.concatLists (map (product: [ product.artifact product.descriptor ]) (builtins.attrValues tracked.products));
in paths")
((${#realized_paths[@]} == ${#product_rows[@]} * 2)) || fail "Nix did not realize every product artifact and descriptor"

if [[ -n "$proposal" ]]; then
  cp -- "$proposal_stage" "$proposal"
  printf 'buck2-products-publish: proposed manifest: %s\n' "$proposal" >&2
else
  cat "$proposal_stage"
fi
