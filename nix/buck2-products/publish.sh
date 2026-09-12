#!/usr/bin/env bash
# Publishes the complete Buck JavaScript product inventory as immutable releases.
set -euo pipefail

repo_root="${BUCK2_RELEASE_PRODUCTS_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
targets="$repo_root/nix/buck2-products/targets.json"
repository="overengineeringstudio/effect-utils"
dry_run=false
proposal=""

fail() {
  printf 'buck2-products-publish: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: nix/buck2-products/publish.sh [--dry-run] [--targets PATH] [--proposal PATH]

--dry-run       Validate the target inventory and print the complete build/publication plan.
--targets PATH  Read the generated desired target inventory from PATH.
--proposal PATH Write the proposed manifest outside the Git worktree (live mode only).
                   Without this option the proposed manifest is emitted on stdout.
EOF
}

while (($#)); do
  case "$1" in
    --dry-run)
      dry_run=true
      shift
      ;;
    --targets)
      (($# >= 2)) || fail "--targets requires a path"
      targets="$2"
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

[[ -f "$targets" && ! -L "$targets" ]] || fail "target inventory must be a regular, non-symlink file: $targets"
for tool in jq sha256sum tr; do
  command -v "$tool" >/dev/null || fail "$tool is required"
done

# This mutation surface is deliberately unavailable to pull-request jobs, even
# in planning mode. A PR may run the separate contract test, never this tool.
if [[ -n "${GITHUB_EVENT_NAME:-}" && "${GITHUB_EVENT_NAME}" != "workflow_dispatch" ]]; then
  fail "refusing untrusted GitHub event: ${GITHUB_EVENT_NAME}"
fi

target_check='
  (type == "object") and
  ((keys | sort) == ["products", "provenance", "schemaVersion"]) and
  (.schemaVersion == 1) and
  (.products | type == "array" and length > 0) and
  (all(.products[];
    type == "object" and
    ((keys | sort) == ["name", "target"]) and
    (.name | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._+-]*$")) and
    (.target | type == "string" and test("^([A-Za-z0-9_]+)?//[^[:space:]\\[\\]]+:[^[:space:]\\[\\]]+$"))
  )) and
  ([.products[].name] | length == (unique | length)) and
  ([.products[].target] | length == (unique | length)) and
  (.provenance | type == "object") and
  ((.provenance | keys | sort) == ["fingerprint", "generator", "regenerationCommand", "semanticInputs", "source"]) and
  (.provenance.fingerprint | type == "string" and test("^sha256:[0-9a-f]{64}$")) and
  (.provenance.generator == "effect-utils/genie/buck2-javascript-release-targets") and
  (.provenance.regenerationCommand == "devenv tasks run genie:run") and
  (.provenance.semanticInputs == [
    "genie/buck2/javascript-product-registry.ts",
    "nix/buck2-products/targets.json.genie.ts"
  ]) and
  (.provenance.source == "nix/buck2-products/targets.json.genie.ts")'
if ! jq -e "$target_check" "$targets" >/dev/null; then
  fail "target inventory violates effect-utils/buck2-release-targets/v1"
fi
declared_fingerprint="$(jq -r '.provenance.fingerprint' "$targets")"
computed_fingerprint="$(jq -cS '{
  generator: .provenance.generator,
  schemaVersion: .schemaVersion,
  semanticData: .products
}' "$targets" | tr -d '\n' | sha256sum)"
computed_fingerprint="sha256:${computed_fingerprint%% *}"
[[ "$declared_fingerprint" == "$computed_fingerprint" ]] ||
  fail "target inventory fingerprint does not match its declared products"

plan="$({
  jq -cS '{
    schema: "effect-utils/buck2-product-publication-plan/v1",
    repository: "overengineeringstudio/effect-utils",
    products: [.products[] | {
      productName: .name,
      candidateTarget: .target,
      descriptorTarget: (.target + "[descriptor]")
    }] | sort_by(.productName)
  }' "$targets"
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

# The successful paginated listing is the authority on which desired tags
# already exist, and on what they are. A transient GET failure aborts here
# rather than being read as absence, so a resumed run can never mistake an
# existing release for a gap. Every row keeps its release id and draft state:
# "the tag exists, published" and "the tag exists as a leaked draft" demand
# opposite handling, and the id is what a human needs to resolve the latter.
release_listing="$(gh api --paginate "repos/$repository/releases" \
  --jq '.[] | [.tag_name, (.id | tostring), (.draft | tostring)] | @tsv')" ||
  fail "could not list existing releases; refusing to publish"
declare -A listed_release_ids=() listed_release_draft=()
while IFS=$'\t' read -r listed_tag listed_id listed_draft; do
  # A release without a tag name cannot collide with a desired tag.
  [[ -n "$listed_tag" ]] || continue
  [[ "$listed_id" =~ ^[0-9]+$ ]] || fail "GitHub listed release $listed_tag without a numeric id"
  [[ "$listed_draft" == true || "$listed_draft" == false ]] ||
    fail "GitHub listed release $listed_tag without a draft state"
  if [[ -n "${listed_release_ids[$listed_tag]+present}" ]]; then
    # Drafts may share a tag name with each other and with a published
    # release; keep every id so the preflight can name them all.
    listed_release_ids["$listed_tag"]+=" $listed_id"
    [[ "$listed_draft" == false ]] || listed_release_draft["$listed_tag"]=true
  else
    listed_release_ids["$listed_tag"]="$listed_id"
    listed_release_draft["$listed_tag"]="$listed_draft"
  fi
done <<<"$release_listing"
stage="$(mktemp -d)"
# Cleanup authority is scoped to a release GitHub still reports as a draft.
# Deleting a published immutable release permanently burns its tag name, so an
# unverifiable or already-published release is left alone: leaking a draft is
# recoverable, destroying a tag is not.
cleanup_draft_release_id=""
cleanup() {
  status=$?
  if [[ -n "$cleanup_draft_release_id" ]]; then
    if release_state="$(gh api "repos/$repository/releases/$cleanup_draft_release_id" 2>/dev/null)" &&
      jq -e '.draft == true' <<<"$release_state" >/dev/null 2>&1; then
      gh api --method DELETE "repos/$repository/releases/$cleanup_draft_release_id" --silent >/dev/null 2>&1 || true
    fi
  fi
  rm -rf "$stage"
  exit "$status"
}
trap cleanup EXIT

mapfile -t product_rows < <(jq -r '.products | sort_by(.name)[] | [.name, .target] | @tsv' "$targets")
((${#product_rows[@]} > 0)) || fail "target inventory contains no products"

declare -a build_targets=()
for row in "${product_rows[@]}"; do
  IFS=$'\t' read -r product_name target <<<"$row"
  [[ -n "$product_name" && -n "$target" ]] || fail "target inventory contains an incomplete product declaration"
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
((${#outputs[@]} == ${#build_targets[@]})) || fail "Buck output set does not exactly match the target inventory build plan"
for target in "${build_targets[@]}"; do
  [[ -n "${outputs[$target]+present}" ]] || fail "Buck returned no output for $target"
done

entries="$stage/entries.jsonl"
: >"$entries"
declare -a release_assets=()
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
  # The release asset name embeds the module path verbatim and a GitHub asset
  # name cannot contain "/", so a module path with directories could never be
  # published under its contracted name. Refuse it here instead of uploading
  # something the loader would reject.
  [[ "$module_path" != */* ]] ||
    fail "$product_name module path is not one release-asset-safe path segment: $module_path"
  product_stage="$stage/products/$product_name"
  mkdir -p "$product_stage"
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

  tag="buck2-product-v3-$product_name-$module_sha256"
  asset_name="$module_sha256-$module_path"
  release_url="https://github.com/$repository/releases/download/$tag/$asset_name"
  # GitHub derives the asset name from the uploaded file's basename; a "#name"
  # suffix only sets the asset's display label. The contracted asset name is
  # therefore produced as a real filename here, in its own per-product
  # directory so identical basenames across products cannot collide.
  asset_stage="$stage/release-assets/$product_name"
  mkdir -p "$asset_stage"
  release_asset="$asset_stage/$asset_name"
  cp -- "$staged_module" "$release_asset"
  cmp -- "$source_module" "$release_asset" || fail "$product_name release asset bytes differ from the module output"
  [[ "${release_asset##*/}" == "$asset_name" ]] ||
    fail "$product_name release asset filename is not the contracted asset name"
  jq -cnS \
    --argjson descriptor "$descriptor" \
    --arg descriptorSha256 "$descriptor_sha256" \
    --arg tag "$tag" --arg name "$asset_name" --arg url "$release_url" --arg hash "$integrity" \
    '{descriptor:$descriptor, descriptorSha256:$descriptorSha256, release:{tag:$tag,name:$name,url:$url,hash:$hash}}' >>"$entries"
  release_assets+=("$release_asset")
  release_tags+=("$tag")
  asset_names+=("$asset_name")
done

proposal_stage="$stage/manifest.json"
jq -sS '{schema:"effect-utils/buck2-release-products/v1",products:.}' "$entries" >"$proposal_stage"
[[ "$(git -C "$repo_root" rev-parse --verify 'HEAD^{commit}')" == "$publication_commit" ]] ||
  fail "checked-out commit changed while staging products"
[[ -z "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]] ||
  fail "Git worktree changed while staging products"


# Single authority for "this tag already holds exactly the uploaded release
# asset, as an immutable published release". Idempotent reuse and
# post-publication verification share it so the two can never drift apart.
release_holds_staged_module() {
  local release_json="$1" expected_name="$2" asset_file="$3" expected_digest
  expected_digest="$(sha256sum "$asset_file")"
  expected_digest="sha256:${expected_digest%% *}"
  jq -e --arg name "$expected_name" --arg digest "$expected_digest" \
    '.draft == false and .immutable == true and (.assets | length == 1) and .assets[0].name == $name and .assets[0].digest == $digest' \
    <<<"$release_json" >/dev/null
}

# Complete reuse preflight: every desired tag the listing already reported is
# verified here, before this run performs a single mutation. Verification must
# not be interleaved with publication, or a mismatch on a later product would
# only be discovered after earlier products were already published immutably.
declare -a verified_reuse=()
for index in "${!release_tags[@]}"; do
  tag="${release_tags[$index]}"
  if [[ -z "${listed_release_ids[$tag]+present}" ]]; then
    verified_reuse+=(false)
    continue
  fi
  listed_ids="${listed_release_ids[$tag]}"
  [[ "$listed_ids" == "${listed_ids% *}" ]] ||
    fail "$tag is held by more than one release (ids: $listed_ids); refusing to publish over it"
  # A desired tag already held by a draft is a leaked release from an earlier
  # run: neither a gap nor a reusable publication. Publishing beside it would
  # attach two releases to one immutable tag, and deleting a release this run
  # did not create is not this tool's call, so a human resolves it by id.
  [[ "${listed_release_draft[$tag]}" == false ]] ||
    fail "$tag already exists as an unpublished draft release (id $listed_ids); publish or delete it manually, then rerun"
  published="$(gh api "repos/$repository/releases/tags/$tag")" ||
    fail "$tag already exists but could not be read; refusing to publish over it"
  release_holds_staged_module "$published" "${asset_names[$index]}" "${release_assets[$index]}" ||
    fail "$tag already exists and does not hold exactly the staged module; refusing to touch it"
  # GitHub attests every immutable release automatically; `gh release
  # verify-asset` is the documented check for that release attestation, and it
  # is bound to this exact tag and local asset file.
  gh release verify-asset "$tag" "${release_assets[$index]}" --repo "$repository" >/dev/null
  verified_reuse+=(true)
done

for index in "${!release_tags[@]}"; do
  tag="${release_tags[$index]}"
  asset_name="${asset_names[$index]}"
  release_asset="${release_assets[$index]}"

  # Already verified in the preflight: never created, uploaded to or patched.
  if [[ "${verified_reuse[$index]}" == true ]]; then
    printf 'buck2-products-publish: reusing verified release: %s\n' "$tag" >&2
    continue
  fi

  created="$(gh api --method POST "repos/$repository/releases" \
    -f tag_name="$tag" -f name="$tag" -f target_commitish="$publication_commit" \
    -F draft=true -F prerelease=false -F generate_release_notes=false)"
  release_id="$(jq -er '.id | select(type == "number")' <<<"$created")" || fail "GitHub did not return a draft release id"
  cleanup_draft_release_id="$release_id"
  jq -e --arg tag "$tag" '.draft == true and .tag_name == $tag and (.assets | length == 0)' <<<"$created" >/dev/null ||
    fail "new release is not the requested empty draft"

  # The uploaded path's basename is the asset name GitHub records; a "#label"
  # suffix would only set a display label, so none is passed.
  gh release upload "$tag" "$release_asset" --repo "$repository"
  gh api --method PATCH "repos/$repository/releases/$release_id" -F draft=false --silent
  # The release is published from here on. Drop cleanup authority before any
  # post-publication check so a failing verification can never delete it.
  cleanup_draft_release_id=""

  published="$(gh api "repos/$repository/releases/tags/$tag")"
  release_holds_staged_module "$published" "$asset_name" "$release_asset" ||
    fail "$tag asset set or digest does not match the staged module"
  gh release verify-asset "$tag" "$release_asset" --repo "$repository" >/dev/null
done

import_root="$stage/import"
mkdir -p "$import_root"
cp -- "$repo_root/nix/buck2-products/default.nix" "$import_root/default.nix"
cp -- "$targets" "$import_root/targets.json"
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
