#!/usr/bin/env bash
# Publishes the complete Buck native-product matrix as immutable releases.
set -euo pipefail

repo_root="${BUCK2_NATIVE_PRODUCTS_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
targets="$repo_root/nix/buck2-native-products/targets.json"
artifact_root=""
repository="overengineeringstudio/effect-utils"
proposal=""
dry_run=false

fail() {
  printf 'buck2-native-products-publish: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: nix/buck2-native-products/publish.sh --artifact-root PATH [--dry-run] [--proposal PATH]

The artifact root must contain exactly:
  <architecture>-<os>-<abi>/<product>/{artifact.tar,descriptor.json}

--dry-run       Validate all descriptors and payloads; print the proposed manifest.
--proposal PATH Write the proposed manifest outside the Git worktree (live mode only).
EOF
}

while (($#)); do
  case "$1" in
    --artifact-root)
      (($# >= 2)) || fail "--artifact-root requires a path"
      artifact_root="$2"
      shift 2
      ;;
    --dry-run)
      dry_run=true
      shift
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

[[ -n "$artifact_root" ]] || fail "--artifact-root is required"
[[ -d "$artifact_root" && ! -L "$artifact_root" ]] || fail "artifact root must be a regular directory"
[[ -f "$targets" && ! -L "$targets" ]] || fail "target inventory must be a regular file: $targets"
for tool in cmp cp find gh git jq mktemp nix realpath sed sha256sum sort stat wc; do
  command -v "$tool" >/dev/null || fail "$tool is required"
done

if [[ -n "${GITHUB_EVENT_NAME:-}" && "${GITHUB_EVENT_NAME}" != "workflow_dispatch" ]]; then
  fail "refusing untrusted GitHub event: ${GITHUB_EVENT_NAME}"
fi

jq -e '
  (type == "object") and
  ((keys | sort) == ["platforms", "products", "schema"]) and
  (.schema == "effect-utils/buck2-native-release-targets/v1") and
  (.platforms | type == "array" and length > 0 and all(.[ ];
    type == "object" and ((keys | sort) == ["abi", "architecture", "os", "system"]) and
    (.abi | type == "string") and (.architecture | type == "string") and
    (.os | type == "string") and (.system | type == "string")
  )) and
  (.products | type == "array" and length > 0 and all(.[ ];
    type == "object" and ((keys | sort) == ["name", "target"]) and
    (.name | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._+-]*$")) and
    (.target | type == "string" and test("^([A-Za-z0-9_]+)?//[^[:space:]\\[\\]]+:[^[:space:]\\[\\]]+$"))
  )) and
  ([.platforms[] | [.architecture, .os, .abi] | join("-")] | length == (unique | length)) and
  ([.platforms[].system] | length == (unique | length)) and
  ([.products[].name] | length == (unique | length)) and
  ([.products[].target] | length == (unique | length))
' "$targets" >/dev/null || fail "target inventory violates effect-utils/buck2-native-release-targets/v1"

stage="$(mktemp -d)"
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

expected_paths="$stage/expected-paths"
actual_paths="$stage/actual-paths"
: >"$expected_paths"
mapfile -t platform_rows < <(jq -r '.platforms[] | [.architecture, .os, .abi] | @tsv' "$targets")
mapfile -t product_rows < <(jq -r '.products[] | [.name, .target] | @tsv' "$targets")
for platform_row in "${platform_rows[@]}"; do
  IFS=$'\t' read -r architecture os abi <<<"$platform_row"
  platform_key="$architecture-$os-$abi"
  for product_row in "${product_rows[@]}"; do
    IFS=$'\t' read -r product_name _ <<<"$product_row"
    printf '%s\n' "$platform_key/$product_name/artifact.tar" "$platform_key/$product_name/descriptor.json" >>"$expected_paths"
  done
done
(
  cd "$artifact_root"
  find . -type f -print | sed 's#^./##' | sort
) >"$actual_paths"
sort -o "$expected_paths" "$expected_paths"
cmp "$expected_paths" "$actual_paths" >/dev/null || fail "artifact root does not exactly match the declared product matrix"
[[ -z "$(find "$artifact_root" -type l -print -quit)" ]] || fail "artifact root must not contain symlinks"

entries="$stage/entries.jsonl"
: >"$entries"
declare -a release_assets=() release_tags=() asset_names=()
for platform_row in "${platform_rows[@]}"; do
  IFS=$'\t' read -r architecture os abi <<<"$platform_row"
  platform_key="$architecture-$os-$abi"
  for product_row in "${product_rows[@]}"; do
    IFS=$'\t' read -r product_name target <<<"$product_row"
    product_root="$artifact_root/$platform_key/$product_name"
    artifact="$product_root/artifact.tar"
    descriptor_file="$product_root/descriptor.json"
    descriptor="$(jq -cS . "$descriptor_file")" || fail "$platform_key/$product_name descriptor is not JSON"
    descriptor_sha256="$(printf '%s' "$descriptor" | sha256sum)"
    descriptor_sha256="sha256:${descriptor_sha256%% *}"

    jq -e --arg name "$product_name" --arg target "$target" \
      --arg architecture "$architecture" --arg os "$os" --arg abi "$abi" '
      .schema == "buck-build-product/v1" and
      .name == $name and .semanticProvenance.target == $target and
      .platform == {architecture:$architecture, os:$os, abi:$abi} and
      .payload.file == "artifact.tar" and .payload.format == "tar" and
      .entrypoints == ["bin/" + $name]
    ' <<<"$descriptor" >/dev/null || fail "$platform_key/$product_name descriptor does not match its declaration"

    contract="$repo_root/nix/workspace-tools/lib/buck2-build-product-contract.nix"
    DESCRIPTOR_FILE="$descriptor_file" DESCRIPTOR_DIGEST="$descriptor_sha256" CONTRACT_FILE="$contract" \
      nix eval --json --impure --expr '
        let
          contract = import (builtins.getEnv "CONTRACT_FILE");
          descriptor = builtins.fromJSON (builtins.readFile (builtins.getEnv "DESCRIPTOR_FILE"));
        in contract.verifyDescriptor {
          inherit descriptor;
          expectedDescriptorDigest = builtins.getEnv "DESCRIPTOR_DIGEST";
        }
      ' >/dev/null || fail "$platform_key/$product_name descriptor violates buck-build-product/v1"

    expected_size="$(jq -r '.payload.sizeBytes' <<<"$descriptor")"
    actual_size="$(stat -c '%s' "$artifact")"
    [[ "$actual_size" == "$expected_size" ]] || fail "$platform_key/$product_name payload size mismatch"
    payload_sha256="$(sha256sum "$artifact")"
    payload_sha256="${payload_sha256%% *}"
    expected_integrity="$(jq -r '.payload.digest.sri' <<<"$descriptor")"
    actual_integrity="$(nix hash convert --hash-algo sha256 --to sri "$payload_sha256")"
    [[ "$actual_integrity" == "$expected_integrity" ]] || fail "$platform_key/$product_name payload digest mismatch"

    tag="buck2-native-product-v1-$product_name-$os-$architecture-$abi-$payload_sha256"
    asset_name="$payload_sha256-$product_name-$os-$architecture-$abi.tar"
    asset_dir="$stage/release-assets/$platform_key/$product_name"
    mkdir -p "$asset_dir"
    release_asset="$asset_dir/$asset_name"
    cp -- "$artifact" "$release_asset"
    cmp -- "$artifact" "$release_asset" >/dev/null || fail "$platform_key/$product_name staged bytes changed"
    release_url="https://github.com/$repository/releases/download/$tag/$asset_name"
    jq -cnS --argjson descriptor "$descriptor" --arg descriptorSha256 "$descriptor_sha256" \
      --arg tag "$tag" --arg name "$asset_name" --arg url "$release_url" --arg hash "$expected_integrity" \
      '{descriptor:$descriptor,descriptorSha256:$descriptorSha256,release:{tag:$tag,name:$name,url:$url,hash:$hash}}' >>"$entries"
    release_assets+=("$release_asset")
    release_tags+=("$tag")
    asset_names+=("$asset_name")
  done
done

proposal_stage="$stage/manifest.json"
jq -sS '{schema:"effect-utils/buck2-native-release-products/v1",products:(sort_by(.descriptor.name,.descriptor.platform.os,.descriptor.platform.architecture,.descriptor.platform.abi))}' "$entries" >"$proposal_stage"

if $dry_run; then
  [[ -z "$proposal" ]] || fail "--proposal is unavailable in dry-run mode"
  cat "$proposal_stage"
  exit 0
fi

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
[[ "$publication_commit" == "$head_commit" ]] || fail "GITHUB_SHA does not identify the checked-out commit"
[[ -z "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]] || fail "refusing to publish from a dirty Git worktree"

release_listing="$(gh api --paginate "repos/$repository/releases" --jq '.[] | [.tag_name, (.id | tostring), (.draft | tostring)] | @tsv')" ||
  fail "could not list existing releases; refusing to publish"
declare -A listed_release_ids=() listed_release_draft=()
while IFS=$'\t' read -r listed_tag listed_id listed_draft; do
  [[ -n "$listed_tag" ]] || continue
  [[ "$listed_id" =~ ^[0-9]+$ ]] || fail "GitHub listed $listed_tag without a numeric id"
  if [[ -n "${listed_release_ids[$listed_tag]+present}" ]]; then
    listed_release_ids["$listed_tag"]+=" $listed_id"
    [[ "$listed_draft" == false ]] || listed_release_draft["$listed_tag"]=true
  else
    listed_release_ids["$listed_tag"]="$listed_id"
    listed_release_draft["$listed_tag"]="$listed_draft"
  fi
done <<<"$release_listing"

release_holds_asset() {
  local release_json="$1" expected_name="$2" asset_file="$3" expected_digest
  expected_digest="$(sha256sum "$asset_file")"
  expected_digest="sha256:${expected_digest%% *}"
  jq -e --arg name "$expected_name" --arg digest "$expected_digest" '
    .draft == false and .immutable == true and
    (.assets | length == 1) and .assets[0].name == $name and .assets[0].digest == $digest
  ' <<<"$release_json" >/dev/null
}

declare -a verified_reuse=()
for index in "${!release_tags[@]}"; do
  tag="${release_tags[$index]}"
  if [[ -z "${listed_release_ids[$tag]+present}" ]]; then
    verified_reuse+=(false)
    continue
  fi
  listed_ids="${listed_release_ids[$tag]}"
  [[ "$listed_ids" == "${listed_ids% *}" ]] || fail "$tag is held by multiple releases: $listed_ids"
  [[ "${listed_release_draft[$tag]}" == false ]] || fail "$tag exists as draft release id $listed_ids"
  published="$(gh api "repos/$repository/releases/tags/$tag")" || fail "could not read existing $tag"
  release_holds_asset "$published" "${asset_names[$index]}" "${release_assets[$index]}" ||
    fail "$tag does not hold exactly the staged asset"
  gh release verify-asset "$tag" "${release_assets[$index]}" --repo "$repository" >/dev/null
  verified_reuse+=(true)
done

for index in "${!release_tags[@]}"; do
  tag="${release_tags[$index]}"
  asset_name="${asset_names[$index]}"
  release_asset="${release_assets[$index]}"
  if [[ "${verified_reuse[$index]}" == true ]]; then
    printf 'buck2-native-products-publish: reusing verified release: %s\n' "$tag" >&2
    continue
  fi
  created="$(gh api --method POST "repos/$repository/releases" \
    -f tag_name="$tag" -f name="$tag" -f target_commitish="$publication_commit" \
    -F draft=true -F prerelease=false -F generate_release_notes=false)"
  release_id="$(jq -er '.id | select(type == "number")' <<<"$created")" || fail "GitHub did not return a draft release id"
  cleanup_draft_release_id="$release_id"
  jq -e --arg tag "$tag" '.draft == true and .tag_name == $tag and (.assets | length == 0)' <<<"$created" >/dev/null ||
    fail "new release is not the requested empty draft"
  gh release upload "$tag" "$release_asset" --repo "$repository"
  gh api --method PATCH "repos/$repository/releases/$release_id" -F draft=false --silent
  cleanup_draft_release_id=""
  published="$(gh api "repos/$repository/releases/tags/$tag")"
  release_holds_asset "$published" "$asset_name" "$release_asset" || fail "$tag failed immutable asset verification"
  gh release verify-asset "$tag" "$release_asset" --repo "$repository" >/dev/null
done

[[ "$(git -C "$repo_root" rev-parse --verify 'HEAD^{commit}')" == "$publication_commit" ]] || fail "checked-out commit changed during publication"
[[ -z "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]] || fail "Git worktree changed during publication"
if [[ -n "$proposal" ]]; then
  cp -- "$proposal_stage" "$proposal"
  printf 'buck2-native-products-publish: proposed manifest: %s\n' "$proposal" >&2
else
  cat "$proposal_stage"
fi
