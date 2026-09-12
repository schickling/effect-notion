#!/usr/bin/env bash
# Contract test for the immutable Buck JavaScript product release manifest.
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export BUCK2_RELEASE_PRODUCTS_REPO="$repo_root"

loader_expr='pkgs = {
    fetchurl = release: release;
    writeText = name: text: {
      type = "derivation";
      outPath = "/nix/store/test-\${name}";
      inherit name text;
    };
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
    descriptorsAreDerivations = builtins.all (
      product: (product.descriptor.type or null) == \"derivation\"
    ) (builtins.attrValues tracked.products);
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
expected_names='["ci-tools","genie","genie-bootstrap-closure-check","megarepo","notion-cli","notion-db-runtime","notion-md","npm-release","oxc-config","oxc-config-stylex-upstream-plugin","tui-stories"]'

jq -e --argjson expected "$expected_names" '
  .fullyPublished == true and
  .declaredProductNames == $expected and
  .publishedProductNames == $expected and
  .descriptorsAreDerivations == true and
  (.releases | keys) == $expected and
  all(
    .releases | to_entries[];
    .key as $product |
    (.value.tag | sub("^buck2-product-v3-\($product)-"; "")) as $digest |
    ($digest | test("^[0-9a-f]{64}$")) and
    (.value.name | startswith("\($digest)-")) and
    .value.url == "https://github.com/overengineeringstudio/effect-utils/releases/download/\(.value.tag)/\(.value.name)"
  )
' <<<"$summary" >/dev/null

mkdir -p "$tmp/products"
cp "$repo_root/nix/buck2-products/default.nix" "$tmp/products/default.nix"
cp "$repo_root/nix/buck2-products/targets.json" "$tmp/products/targets.json"

write_mutation() {
  jq "$1" "$repo_root/nix/buck2-products/manifest.json" >"$tmp/products/manifest.json"
}

write_target_mutation() {
  local fingerprint
  jq "$1" "$repo_root/nix/buck2-products/targets.json" >"$tmp/products/targets.next.json"
  fingerprint="$(jq -cS '{
    generator: .provenance.generator,
    schemaVersion: .schemaVersion,
    semanticData: .products
  }' "$tmp/products/targets.next.json" | tr -d '\n' | sha256sum)"
  fingerprint="sha256:${fingerprint%% *}"
  jq --arg fingerprint "$fingerprint" '.provenance.fingerprint = $fingerprint' \
    "$tmp/products/targets.next.json" >"$tmp/products/targets.json"
  cp "$repo_root/nix/buck2-products/manifest.json" "$tmp/products/manifest.json"
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

write_target_mutation '.products |= .[1:]'
expect_failure "unpublished declaration" "declared target inventory does not match the published manifest"

write_target_mutation '.products[0].target = .products[1].target'
expect_failure "duplicate declared target" "target inventory product targets must be unique"

write_target_mutation '.products[0].target += "[descriptor]"'
expect_failure "configured declared target" "target inventory products are malformed"

jq -r '.releases | to_entries[] | "buck2-release-products-test: \(.key) \(.value.tag)"' <<<"$summary"

publisher="$repo_root/nix/buck2-products/publish.sh"
test -f "$publisher"
cp "$repo_root/nix/buck2-products/manifest.json" "$tmp/manifest.before.json"
cp "$repo_root/nix/buck2-products/targets.json" "$tmp/targets.before.json"

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
plan_stderr="$tmp/plan-stderr.log"
if ! plan="$(PATH="$tmp/bin:$PATH" bash "$publisher" --dry-run 2>"$plan_stderr")"; then
  echo "buck2-release-products-test: publisher dry-run failed" >&2
  sed -n '1,160p' "$plan_stderr" >&2
  exit 1
fi
if [[ -e "$tmp/unexpected-tools" ]]; then
  echo "buck2-release-products-test: publisher dry-run invoked a mutation tool" >&2
  sed -n '1,160p' "$tmp/unexpected-tools" >&2
  exit 1
fi
if ! cmp "$repo_root/nix/buck2-products/targets.json" "$tmp/targets.before.json"; then
  echo "buck2-release-products-test: publisher dry-run mutated the target inventory" >&2
  exit 1
fi
cmp "$repo_root/nix/buck2-products/manifest.json" "$tmp/manifest.before.json"
if ! jq -e --argjson expected "$expected_names" '
  .schema == "effect-utils/buck2-product-publication-plan/v1" and
  .repository == "overengineeringstudio/effect-utils" and
  [.products[].productName] == $expected and
  (.products | length == 11) and
  all(
    .products[];
    (.candidateTarget | test("^([A-Za-z0-9_]+)?//")) and
    (.descriptorTarget == (.candidateTarget + "[descriptor]"))
  )
' <<<"$plan" >/dev/null; then
  echo "buck2-release-products-test: publisher dry-run emitted an invalid plan" >&2
  printf '%s\n' "$plan" >&2
  exit 1
fi

publish_failure="$tmp/publish-failure.log"
if GITHUB_EVENT_NAME=pull_request PATH="$tmp/bin:$PATH" bash "$publisher" --dry-run >"$publish_failure" 2>&1; then
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
# The stub owns commit identity for this refusal case. CI's ambient GITHUB_SHA
# must not preempt the dirty-worktree check under test.
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
if env -u "$legacy_token" -u GITHUB_SHA PATH="$tmp/refusal-bin:$PATH" bash "$publisher" >"$publish_failure" 2>&1; then
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

jq '.products[1].target = .products[0].target' \
  "$repo_root/nix/buck2-products/targets.json" >"$tmp/duplicate-target.json"
if PATH="$tmp/bin:$PATH" bash "$publisher" --dry-run --targets "$tmp/duplicate-target.json" >"$publish_failure" 2>&1; then
  echo "buck2-release-products-test: publisher accepted a duplicate candidate target" >&2
  exit 1
fi
grep -F "target inventory violates effect-utils/buck2-release-targets/v1" "$publish_failure" >/dev/null
test ! -e "$tmp/unexpected-tools"

jq '.provenance.fingerprint = "sha256:" + ("0" * 64)' \
  "$repo_root/nix/buck2-products/targets.json" >"$tmp/stale-fingerprint.json"
if PATH="$tmp/bin:$PATH" bash "$publisher" --dry-run --targets "$tmp/stale-fingerprint.json" >"$publish_failure" 2>&1; then
  echo "buck2-release-products-test: publisher accepted a stale target fingerprint" >&2
  exit 1
fi
grep -F "target inventory fingerprint does not match its declared products" "$publish_failure" >/dev/null
test ! -e "$tmp/unexpected-tools"

if grep -F -- '--clobber' "$publisher" >/dev/null; then
  echo "buck2-release-products-test: publisher permits release asset clobbering" >&2
  exit 1
fi
if grep -F 'immutable-releases' "$publisher" >/dev/null; then
  echo "buck2-release-products-test: publisher requires the admin-only immutability endpoint" >&2
  exit 1
fi
grep -F '.immutable == true' "$publisher" >/dev/null
# GitHub names an asset after the uploaded file, and reads "path#label" as a
# display label only. A publisher that passed the required asset name as a
# label would publish an asset under the wrong, unfetchable name.
if grep -F 'gh release upload' "$publisher" | grep -F '#' >/dev/null; then
  echo "buck2-release-products-test: publisher passes a #label to gh release upload" >&2
  exit 1
fi
if grep -E '(^|[[:space:]])set[[:space:]]+-[^[:space:]]*x' "$publisher" >/dev/null; then
  echo "buck2-release-products-test: publisher enables shell tracing around secrets" >&2
  exit 1
fi
cmp "$repo_root/nix/buck2-products/manifest.json" "$tmp/manifest.before.json"
echo "buck2-release-products-test: publisher dry-run/refusal OK"

# Mocked live publication. Real hashing tools, fake Buck/Git/Nix and a stateful
# fake GitHub that records every API call. These cases pin the publication
# boundary: a pre-publication failure must delete the draft GitHub still
# reports as a draft, any post-publication failure must never issue a DELETE
# (deleting a published immutable release burns its tag forever), and a rerun
# must verify and reuse an already published release instead of touching it.
live="$tmp/live"
mkdir -p "$live/bin" "$live/build"
real_nix="$(command -v nix)"
printf '{}\n' >"$live/outputs.json"

# Each product is materialized once: real bytes, a real digest, a real v2
# descriptor, a target inventory entry and a Buck output mapping. Scenarios then
# compose generated-inventory-shaped target sets, so partially published
# multi-product runs are testable.
declare -A live_tag=() live_asset=() live_module=()
live_add_product() {
  local name="$1" module_path="$2" body="$3"
  local target="root//live:$name"
  local module="$live/build/$module_path"
  printf '%s\n' "$body" >"$module"
  local size sha sri descriptor tag asset
  size="$(stat -c '%s' "$module")"
  sha="$(sha256sum "$module")"
  sha="${sha%% *}"
  sri="$(nix hash convert --hash-algo sha256 --to sri "$sha")"
  descriptor="$live/build/$name.product.json"
  jq -nS \
    --arg name "$name" \
    --arg target "$target" \
    --arg modulePath "$module_path" \
    --arg integrity "$sri" \
    --argjson sizeBytes "$size" \
    '{
       externalCapabilities: [],
       externalModules: [],
       integrity: $integrity,
       modulePath: $modulePath,
       platform: { abi: "any", architecture: "any", os: "any" },
       productKind: "cli",
       productName: $name,
       provenance: {
         configuredTarget: ($target + " (live-test-cfg)"),
         dependencyClosureIdentity: "live-test-closure",
         module: "live-test-module"
       },
       runtimeContract: "javascript-esm",
       runtimeContractVersion: "v1",
       runtimeKind: "bun",
       schema: "effect-utils/javascript-product/v2",
       sizeBytes: $sizeBytes,
       target: $target
     }' >"$descriptor"
  tag="buck2-product-v3-$name-$sha"
  asset="$sha-$module_path"
  jq -nS --arg name "$name" --arg target "$target" \
    '{name:$name,target:$target}' >"$live/target-$name.json"
  jq --arg target "$target" --arg module "$module" --arg descriptor "$descriptor" \
    '.[$target] = $module | .[$target + "[descriptor]"] = $descriptor' \
    "$live/outputs.json" >"$live/outputs.next.json"
  mv "$live/outputs.next.json" "$live/outputs.json"
  live_tag["$name"]="$tag"
  live_asset["$name"]="$asset"
  live_module["$name"]="$module"
}

live_inventory() {
  local path="$1"
  shift
  local name fingerprint
  local -a entries=()
  for name in "$@"; do
    entries+=("$live/target-$name.json")
  done
  jq -sS '{
    products: .,
    provenance: {
      fingerprint: "",
      generator: "effect-utils/genie/buck2-javascript-release-targets",
      regenerationCommand: "devenv tasks run genie:run",
      semanticInputs: [
        "genie/buck2/javascript-product-registry.ts",
        "nix/buck2-products/targets.json.genie.ts"
      ],
      source: "nix/buck2-products/targets.json.genie.ts"
    },
    schemaVersion: 1
  }' "${entries[@]}" >"$path"
  fingerprint="$(jq -cS '{
    generator: .provenance.generator,
    schemaVersion: .schemaVersion,
    semanticData: .products
  }' "$path" | tr -d '\n' | sha256sum)"
  fingerprint="sha256:${fingerprint%% *}"
  jq --arg fingerprint "$fingerprint" '.provenance.fingerprint = $fingerprint' \
    "$path" >"$path.next"
  mv "$path.next" "$path"
}

live_add_product live-product live-product.mjs 'export const liveProduct = "live";'
live_add_product live-second live-second.mjs 'export const liveSecond = "second";'
live_expected_tag="${live_tag[live-product]}"
live_expected_asset="${live_asset[live-product]}"
live_inventory "$live/inventory.json" live-product
live_inventory "$live/inventory-both.json" live-product live-second

cat >"$live/bin/buck2" <<EOF
#!/usr/bin/env bash
set -uo pipefail
for arg in "\$@"; do
  case "\$arg" in
    build|--show-full-output) continue ;;
  esac
  path="\$(jq -r --arg target "\$arg" '.[\$target] // empty' '$live/outputs.json')"
  [[ -n "\$path" ]] || exit 96
  printf '%s %s\n' "\$arg" "\$path"
done
EOF
chmod +x "$live/bin/buck2"

# Clean, stable worktree identity: the publication-boundary cases under test
# must not be preempted by this checkout's real Git state.
cat >"$live/bin/git" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *rev-parse*) printf '%040d\n' 1 ;;
  *status*) : ;;
  *) exit 97 ;;
esac
EOF
chmod +x "$live/bin/git"

# Real hashing, mocked realization: these cases exercise the publication
# boundary, not Nix evaluation, and no scenario may reach the network.
cat >"$live/bin/nix" <<EOF
#!/usr/bin/env bash
set -uo pipefail
case "\${1:-}" in
  hash) exec '$real_nix' "\$@" ;;
  build)
    paths="\${GH_FAKE_STATE:-}/realized-paths"
    [[ -f "\$paths" ]] || exit 96
    cat "\$paths"
    ;;
  *)
    printf 'nix stub: unexpected invocation: %s\n' "\$*" >&2
    exit 96
    ;;
esac
EOF
chmod +x "$live/bin/nix"

# The fake models releases individually: one JSON document per tag plus an
# id -> tag index. A by-tag read is therefore never synthesized from "whatever
# the publisher uploaded last", so a scenario with two products cannot
# accidentally verify one product against the other's asset.
cat >"$live/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
state="${GH_FAKE_STATE:?gh stub requires GH_FAKE_STATE}"
log="$state/calls.log"

release_file() { printf '%s/by-tag/%s.json' "$state" "$1"; }

tag_for_id() {
  [[ -f "$state/by-id/$1" ]] || return 1
  cat "$state/by-id/$1"
}

release_update() {
  local tag="$1"
  shift
  local file
  file="$(release_file "$tag")"
  [[ -f "$file" ]] || return 1
  jq -c "$@" "$file" >"$file.next" || return 1
  mv "$file.next" "$file"
}

sub="${1:-}"
shift || true
case "$sub" in
  api)
    method=GET
    path=""
    declare -A field=()
    args=("$@")
    i=0
    while ((i < ${#args[@]})); do
      case "${args[i]}" in
        --method)
          method="${args[i + 1]}"
          ((i += 2))
          continue
          ;;
        -f|-F)
          kv="${args[i + 1]}"
          field["${kv%%=*}"]="${kv#*=}"
          ((i += 2))
          continue
          ;;
        --jq)
          ((i += 2))
          continue
          ;;
        -*) ;;
        *) path="${args[i]}" ;;
      esac
      ((i += 1))
    done
    case "$method:$path" in
      GET:*/releases)
        printf 'LIST-RELEASES\n' >>"$log"
        if [[ -e "$state/fail-list" ]]; then
          printf 'gh stub: release listing failed\n' >&2
          exit 1
        fi
        # Rows as the publisher's --jq renders them: tag, id, draft.
        if [[ -s "$state/listing" ]]; then
          cat "$state/listing"
        fi
        ;;
      POST:*/releases)
        tag="${field[tag_name]:-}"
        printf 'CREATE-DRAFT %s\n' "$tag" >>"$log"
        id="$(cat "$state/next-id")"
        printf '%s\n' "$((id + 1))" >"$state/next-id"
        printf '%s\n' "$tag" >"$state/by-id/$id"
        jq -cn --arg tag "$tag" --argjson id "$id" \
          '{id: $id, draft: true, immutable: false, tag_name: $tag, assets: []}' \
          >"$(release_file "$tag")"
        cat "$(release_file "$tag")"
        ;;
      PATCH:*/releases/*)
        id="${path##*/}"
        printf 'PATCH-RELEASE %s draft=%s\n' "$id" "${field[draft]:-}" >>"$log"
        tag="$(tag_for_id "$id")" || {
          printf 'gh stub: unknown release id: %s\n' "$id" >&2
          exit 1
        }
        release_update "$tag" --argjson draft "${field[draft]:-null}" \
          '.draft = $draft | .immutable = ($draft == false)' || exit 1
        # Publish applied server-side but the call reports failure.
        if [[ -e "$state/fail-patch-after-apply" ]]; then
          printf 'gh stub: patch reported failure after applying\n' >&2
          exit 1
        fi
        ;;
      GET:*/releases/tags/*)
        tag="${path##*/}"
        printf 'GET-BY-TAG %s\n' "$tag" >>"$log"
        if [[ -e "$state/fail-get-by-tag" ]]; then
          printf 'gh stub: release read failed\n' >&2
          exit 1
        fi
        if [[ ! -f "$(release_file "$tag")" ]]; then
          printf 'gh stub: no release for tag: %s\n' "$tag" >&2
          exit 1
        fi
        cat "$(release_file "$tag")"
        ;;
      GET:*/releases/*)
        id="${path##*/}"
        printf 'GET-RELEASE %s\n' "$id" >>"$log"
        tag="$(tag_for_id "$id")" || {
          printf 'gh stub: unknown release id: %s\n' "$id" >&2
          exit 1
        }
        jq -c '{id: .id, draft: .draft, tag_name: .tag_name}' "$(release_file "$tag")"
        ;;
      DELETE:*/releases/*)
        id="${path##*/}"
        printf 'DELETE-RELEASE %s\n' "$id" >>"$log"
        tag="$(tag_for_id "$id")" || {
          printf 'gh stub: unknown release id: %s\n' "$id" >&2
          exit 1
        }
        rm -f "$(release_file "$tag")" "$state/by-id/$id"
        ;;
      *)
        printf 'UNEXPECTED-API %s %s\n' "$method" "$path" >>"$log"
        exit 97
        ;;
    esac
    ;;
  release)
    case "${1:-}" in
      upload)
        tag="${2:-}"
        spec="${3:-}"
        # Real gh semantics: the asset name is the basename of the uploaded
        # file. Anything after "#" is only the asset's display label, so a
        # "#name" suffix can never rename the asset.
        path="${spec%%#*}"
        name="${path##*/}"
        printf 'UPLOAD %s\n' "$name" >>"$log"
        if [[ "$spec" == *#* ]]; then
          printf 'UPLOAD-LABEL %s\n' "${spec#*#}" >>"$log"
        fi
        if [[ -e "$state/fail-upload" ]]; then
          printf 'gh stub: upload failed\n' >&2
          exit 1
        fi
        digest="$(sha256sum "$path")" || exit 1
        release_update "$tag" --arg name "$name" --arg digest "sha256:${digest%% *}" \
          '.assets += [{name: $name, digest: $digest}]' || {
          printf 'gh stub: no release for tag: %s\n' "$tag" >&2
          exit 1
        }
        ;;
      verify-asset)
        # Real gh semantics: the release attestation is looked up by tag, and
        # the local file is matched against that release's asset by name and
        # digest.
        tag="${2:-}"
        path="${3:-}"
        name="${path##*/}"
        printf 'VERIFY-ASSET %s %s\n' "$tag" "$name" >>"$log"
        if [[ -e "$state/fail-verify-asset" ]]; then
          printf 'gh stub: release asset verification failed\n' >&2
          exit 1
        fi
        file="$(release_file "$tag")"
        if [[ ! -f "$file" ]]; then
          printf 'gh stub: no release for tag: %s\n' "$tag" >&2
          exit 1
        fi
        if [[ ! -f "$path" ]]; then
          printf 'gh stub: no such release asset file: %s\n' "$path" >&2
          exit 1
        fi
        digest="$(sha256sum "$path")" || exit 1
        if ! jq -e --arg name "$name" --arg digest "sha256:${digest%% *}" \
          '(.assets | length == 1) and .assets[0].name == $name and .assets[0].digest == $digest' \
          "$file" >/dev/null; then
          printf 'gh stub: %s does not hold %s\n' "$tag" "$name" >&2
          exit 1
        fi
        ;;
      *)
        printf 'UNEXPECTED-RELEASE %s\n' "$*" >>"$log"
        exit 97
        ;;
    esac
    ;;
  *)
    printf 'UNEXPECTED-SUBCOMMAND %s\n' "$sub" >>"$log"
    exit 97
    ;;
esac
EOF
chmod +x "$live/bin/gh"

live_calls=""
live_state=""
live_prepare() {
  local label="$1"
  shift
  local state="$live/state-$label"
  rm -rf "$state"
  mkdir -p "$state/by-tag" "$state/by-id"
  # Draft ids this run allocates start here and increment per create.
  printf '4242\n' >"$state/next-id"
  : >"$state/calls.log"
  : >"$state/listing"
  local flag
  for flag in "$@"; do
    : >"$state/$flag"
  done
  live_state="$state"
  live_calls="$state/calls.log"
}

live_run() {
  local label="$1"
  local targets="$2"
  local expect="$3"
  local log="$live/$label.log"
  local status=0
  env -u GITHUB_SHA -u GITHUB_EVENT_NAME GH_FAKE_STATE="$live_state" PATH="$live/bin:$PATH" \
    bash "$publisher" --targets "$targets" >"$log" 2>&1 || status=$?
  if [[ "$expect" == ok && "$status" -ne 0 ]]; then
    echo "buck2-release-products-test: expected live $label to succeed" >&2
    sed -n '1,160p' "$log" >&2
    exit 1
  fi
  if [[ "$expect" == fail && "$status" -eq 0 ]]; then
    echo "buck2-release-products-test: expected live $label to fail" >&2
    sed -n '1,160p' "$log" >&2
    exit 1
  fi
}

live_scenario() {
  local label="$1"
  shift
  live_prepare "$label" "$@"
  live_run "$label" "$live/inventory.json" fail
}

# Ids of releases that already exist before a scenario runs. Kept clear of the
# 4242.. range the fake allocates for drafts this run creates.
live_next_existing_id=9001

# What the paginated listing reports for one release: tag, id, draft.
live_listed() {
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$live_state/listing"
}

# Declares an already published release: listed as published, and readable by
# tag. The jq override turns the exact match into each way a stale release can
# be wrong; the listing row stays published, so an override models a by-tag
# read that disagrees with the listing rather than a listed draft.
live_published_release() {
  local tag="$1" name="$2" file="$3" override="${4:-.}" digest id
  digest="$(sha256sum "$file")"
  id="$live_next_existing_id"
  live_next_existing_id=$((id + 1))
  jq -cn --arg tag "$tag" --argjson id "$id" --arg name "$name" \
    --arg digest "sha256:${digest%% *}" \
    "{id: \$id, draft: false, immutable: true, tag_name: \$tag, assets: [{name: \$name, digest: \$digest}]} | ($override)" \
    >"$live_state/by-tag/$tag.json"
  printf '%s\n' "$tag" >"$live_state/by-id/$id"
  live_listed "$tag" "$id" false
}

live_realized() {
  local products="$1" index
  : >"$live_state/realized-paths"
  for ((index = 0; index < products * 2; index++)); do
    printf '/nix/store/live-realized-%s\n' "$index" >>"$live_state/realized-paths"
  done
}

live_expect_reuse_only() {
  local label="$1"
  live_reject "$label" 'CREATE-DRAFT'
  live_reject "$label" 'UPLOAD'
  live_reject "$label" 'PATCH-RELEASE'
  live_reject "$label" 'DELETE-RELEASE'
}

live_expect() {
  local label="$1"
  local line="$2"
  if ! grep -Fqx -- "$line" "$live_calls"; then
    echo "buck2-release-products-test: live $label did not perform: $line" >&2
    sed -n '1,80p' "$live_calls" >&2
    exit 1
  fi
}

live_reject() {
  local label="$1"
  local pattern="$2"
  if grep -Fq -- "$pattern" "$live_calls"; then
    echo "buck2-release-products-test: live $label must not perform: $pattern" >&2
    sed -n '1,80p' "$live_calls" >&2
    exit 1
  fi
}

# What GitHub ended up holding for a tag: exactly one asset, named after the
# uploaded file, with the digest of the module bytes.
live_uploaded_asset() {
  local label="$1" tag="$2" expected_name="$3" module="$4" digest
  digest="$(sha256sum "$module")"
  if ! jq -e --arg name "$expected_name" --arg digest "sha256:${digest%% *}" \
    '(.assets | length == 1) and .assets[0].name == $name and .assets[0].digest == $digest' \
    "$live/state-$label/by-tag/$tag.json" >/dev/null; then
    echo "buck2-release-products-test: live $label did not publish $expected_name for $tag" >&2
    cat "$live/state-$label/by-tag/$tag.json" >&2
    exit 1
  fi
}

# Pre-publication failure: the draft is still a draft, so cleanup must confirm
# that with GitHub and then delete it.
live_scenario upload-failure fail-upload
live_expect upload-failure "CREATE-DRAFT $live_expected_tag"
live_expect upload-failure "UPLOAD $live_expected_asset"
# The stub names the asset after the uploaded file, so this line also proves
# the uploaded path's basename is exactly the contracted asset name, and that
# no "#label" was used to fake it.
live_reject upload-failure 'UPLOAD-LABEL'
live_reject upload-failure 'PATCH-RELEASE'
live_expect upload-failure 'GET-RELEASE 4242'
live_expect upload-failure 'DELETE-RELEASE 4242'
echo "buck2-release-products-test: live upload failure deleted the confirmed draft"

# Post-publication failure: the release is published, so no DELETE may be
# issued and cleanup must not even hold delete authority any more.
live_scenario verify-asset-failure fail-verify-asset
live_expect verify-asset-failure "CREATE-DRAFT $live_expected_tag"
live_expect verify-asset-failure 'PATCH-RELEASE 4242 draft=false'
live_expect verify-asset-failure "GET-BY-TAG $live_expected_tag"
live_expect verify-asset-failure "VERIFY-ASSET $live_expected_tag $live_expected_asset"
live_reject verify-asset-failure 'UPLOAD-LABEL'
live_expect verify-asset-failure "UPLOAD $live_expected_asset"
live_uploaded_asset verify-asset-failure "$live_expected_tag" "$live_expected_asset" \
  "${live_module[live-product]}"
live_reject verify-asset-failure 'GET-RELEASE'
live_reject verify-asset-failure 'DELETE-RELEASE'
echo "buck2-release-products-test: live post-publication failure issued no DELETE"

# Publish reported failure but applied server-side: cleanup asks GitHub, learns
# the release is no longer a draft, and refuses to delete it.
live_scenario patch-failure fail-patch-after-apply
live_expect patch-failure 'PATCH-RELEASE 4242 draft=false'
live_expect patch-failure 'GET-RELEASE 4242'
live_reject patch-failure 'DELETE-RELEASE'
echo "buck2-release-products-test: live ambiguous publish left the release intact"

# Resumption: the tag the listing already reports holds exactly the staged
# module, so the run verifies it, reuses it and mutates nothing.
live_prepare reuse-exact
live_published_release "$live_expected_tag" "$live_expected_asset" "${live_module[live-product]}"
live_realized 1
live_run reuse-exact "$live/inventory.json" ok
live_expect reuse-exact 'LIST-RELEASES'
live_expect reuse-exact "GET-BY-TAG $live_expected_tag"
live_expect reuse-exact "VERIFY-ASSET $live_expected_tag $live_expected_asset"
live_expect_reuse_only reuse-exact
grep -F "reusing verified release: $live_expected_tag" "$live/reuse-exact.log" >/dev/null
echo "buck2-release-products-test: live rerun reused the published release untouched"

# The REST asset predicate and the release attestation are independent gates:
# a release the predicate accepts is still refused when its release
# attestation does not verify, and nothing is published beside it.
live_prepare reuse-unverifiable fail-verify-asset
live_published_release "$live_expected_tag" "$live_expected_asset" "${live_module[live-product]}"
live_realized 1
live_run reuse-unverifiable "$live/inventory.json" fail
live_expect reuse-unverifiable "GET-BY-TAG $live_expected_tag"
live_expect reuse-unverifiable "VERIFY-ASSET $live_expected_tag $live_expected_asset"
live_expect_reuse_only reuse-unverifiable
echo "buck2-release-products-test: live unverifiable existing release failed closed"

# Any existing release that is not an exact, published, immutable, single-asset
# match of the staged module aborts before this run mutates anything.
live_mismatch() {
  local label="$1" override="$2"
  live_prepare "$label"
  live_published_release "$live_expected_tag" "$live_expected_asset" "${live_module[live-product]}" "$override"
  live_realized 1
  live_run "$label" "$live/inventory.json" fail
  live_expect "$label" "GET-BY-TAG $live_expected_tag"
  live_reject "$label" 'VERIFY-ASSET'
  live_expect_reuse_only "$label"
  grep -F "does not hold exactly the staged module" "$live/$label.log" >/dev/null
}
live_mismatch reuse-by-tag-draft '.draft = true'
live_mismatch reuse-mutable '.immutable = false'
live_mismatch reuse-extra-asset '.assets += [{name: "extra", digest: "sha256:extra"}]'
live_mismatch reuse-no-asset '.assets = []'
live_mismatch reuse-asset-name '.assets[0].name = ("renamed-" + .assets[0].name)'
live_mismatch reuse-asset-digest '.assets[0].digest = ("sha256:" + ("0" * 64))'
echo "buck2-release-products-test: live mismatched existing releases failed closed"

# A listed tag that cannot be read is not a licence to republish it: the run
# aborts on the failed read, before any mutation.
live_prepare reuse-unreadable fail-get-by-tag
live_listed "$live_expected_tag" 9101 false
live_realized 1
live_run reuse-unreadable "$live/inventory.json" fail
live_expect reuse-unreadable "GET-BY-TAG $live_expected_tag"
live_reject reuse-unreadable 'VERIFY-ASSET'
live_expect_reuse_only reuse-unreadable
grep -F "already exists but could not be read" "$live/reuse-unreadable.log" >/dev/null
echo "buck2-release-products-test: live unreadable existing release failed closed"

# A desired tag the listing reports as a draft is a leaked release from an
# earlier run, not a gap: publishing beside it would attach two releases to one
# immutable tag. The run aborts before any mutation, names the id a human needs
# to resolve it, and neither reads nor deletes it.
live_prepare reuse-listed-draft
live_listed "$live_expected_tag" 9201 true
live_realized 1
live_run reuse-listed-draft "$live/inventory.json" fail
live_expect reuse-listed-draft 'LIST-RELEASES'
live_reject reuse-listed-draft 'GET-BY-TAG'
live_reject reuse-listed-draft 'VERIFY-ASSET'
live_expect_reuse_only reuse-listed-draft
grep -F "already exists as an unpublished draft release (id 9201)" \
  "$live/reuse-listed-draft.log" >/dev/null
echo "buck2-release-products-test: live listed draft blocked publication before mutation"

# The listing is the sole authority on which tags exist, so a failed listing
# aborts the run instead of reading as "nothing is published yet".
live_prepare list-failure fail-list
live_realized 1
live_run list-failure "$live/inventory.json" fail
live_expect list-failure 'LIST-RELEASES'
live_reject list-failure 'GET-BY-TAG'
live_reject list-failure 'VERIFY-ASSET'
live_expect_reuse_only list-failure
grep -F "could not list existing releases" "$live/list-failure.log" >/dev/null
echo "buck2-release-products-test: live listing failure aborted the run"

# The incident shape: products 1..N are published, the run is resumed. The
# published product is verified and skipped, the remaining one is published.
live_prepare resume-remaining
live_published_release "$live_expected_tag" "$live_expected_asset" "${live_module[live-product]}"
live_realized 2
live_run resume-remaining "$live/inventory-both.json" ok
live_expect resume-remaining "GET-BY-TAG $live_expected_tag"
live_expect resume-remaining "VERIFY-ASSET $live_expected_tag $live_expected_asset"
live_reject resume-remaining "CREATE-DRAFT $live_expected_tag"
live_reject resume-remaining "UPLOAD $live_expected_asset"
live_expect resume-remaining "CREATE-DRAFT ${live_tag[live-second]}"
live_expect resume-remaining "UPLOAD ${live_asset[live-second]}"
live_expect resume-remaining 'PATCH-RELEASE 4242 draft=false'
live_expect resume-remaining "GET-BY-TAG ${live_tag[live-second]}"
live_expect resume-remaining "VERIFY-ASSET ${live_tag[live-second]} ${live_asset[live-second]}"
live_reject resume-remaining 'UPLOAD-LABEL'
live_uploaded_asset resume-remaining "${live_tag[live-second]}" "${live_asset[live-second]}" \
  "${live_module[live-second]}"
live_reject resume-remaining 'DELETE-RELEASE'
echo "buck2-release-products-test: live resumed run published only the missing product"

# Verification order: the mismatched release belongs to the LAST product, while
# the first is absent. Reuse verification is a complete preflight, so the
# absent product must not be published before the mismatch is discovered.
live_prepare preflight-mismatch
live_published_release "${live_tag[live-second]}" "${live_asset[live-second]}" \
  "${live_module[live-second]}" '.assets[0].digest = ("sha256:" + ("0" * 64))'
live_realized 2
live_run preflight-mismatch "$live/inventory-both.json" fail
live_expect preflight-mismatch "GET-BY-TAG ${live_tag[live-second]}"
live_expect_reuse_only preflight-mismatch
live_reject preflight-mismatch 'VERIFY-ASSET'
grep -F "does not hold exactly the staged module" "$live/preflight-mismatch.log" >/dev/null
echo "buck2-release-products-test: live preflight mismatch blocked every product"

cmp "$repo_root/nix/buck2-products/targets.json" "$tmp/targets.before.json"
cmp "$repo_root/nix/buck2-products/manifest.json" "$tmp/manifest.before.json"
echo "buck2-release-products-test: OK"
