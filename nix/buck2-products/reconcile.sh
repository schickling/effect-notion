#!/usr/bin/env bash
# Publish or verify the tracked Buck product artifacts.
#
#   reconcile.sh publish   # rebuild every declared product and rewrite the tracked tree
#   reconcile.sh check     # fail when the tracked tree is not byte-identical to Buck output
#
# Required environment: BUCK2_BIN, JQ_BIN, PRODUCTS_DIR, WORKSPACE_ROOT, CELL.
set -euo pipefail

mode="${1:?usage: reconcile.sh publish|check}"
case "$mode" in
publish | check) ;;
*)
  echo "reconcile.sh: unknown mode '$mode'" >&2
  exit 2
  ;;
esac

: "${BUCK2_BIN:?BUCK2_BIN is required}"
: "${JQ_BIN:?JQ_BIN is required}"
: "${PRODUCTS_DIR:?PRODUCTS_DIR is required}"
: "${WORKSPACE_ROOT:?WORKSPACE_ROOT is required}"
cell="${CELL:-effect_utils}"

spec="$PRODUCTS_DIR/products.json"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

build_one() {
  # Buck prints the absolute declared output path and no label with this mode.
  "$BUCK2_BIN" build --show-full-simple-output "$1" | tail -n 1
}

manifest_entries="$staging/entries.json"
echo '{}' >"$manifest_entries"

count="$("$JQ_BIN" '.products | length' "$spec")"
for index in $(seq 0 $((count - 1))); do
  product="$("$JQ_BIN" -c ".products[$index]" "$spec")"
  name="$("$JQ_BIN" -r '.productName' <<<"$product")"
  label="$("$JQ_BIN" -r '.label' <<<"$product")"
  module="$("$JQ_BIN" -r '.module' <<<"$product")"
  descriptor_path="$("$JQ_BIN" -r '.descriptorPath' <<<"$product")"

  cd "$WORKSPACE_ROOT"
  module_output="$(build_one "${cell}${label}")"
  descriptor_output="$(build_one "${cell}${label}[descriptor]")"

  digest="$(sha256sum "$module_output" | cut -d ' ' -f 1)"
  descriptor_digest="$(sha256sum "$descriptor_output" | cut -d ' ' -f 1)"
  descriptor_name="$("$JQ_BIN" -r '.productName' "$descriptor_output")"
  if [ "$descriptor_name" != "$name" ]; then
    echo "reconcile.sh: $label descriptor names product '$descriptor_name', expected '$name'" >&2
    exit 1
  fi

  mkdir -p "$staging/tree/$name"
  install -m 0644 "$module_output" "$staging/tree/$name/$digest-$module"
  install -m 0644 "$descriptor_output" "$staging/tree/$descriptor_path"

  "$JQ_BIN" \
    --arg name "$name" \
    --arg label "$label" \
    --arg artifact "$name/$digest-$module" \
    --arg descriptor_digest "$descriptor_digest" \
    --arg digest "$digest" \
    '.[$name] = {
       artifact: $artifact,
       descriptorSha256: $descriptor_digest,
       label: $label,
       moduleSha256: $digest
     }' \
    "$manifest_entries" >"$manifest_entries.next"
  mv "$manifest_entries.next" "$manifest_entries"
done

"$JQ_BIN" -S \
  --slurpfile products "$manifest_entries" \
  -n '{ schema: "effect-utils/tracked-buck-products/v1", products: $products[0] }' \
  >"$staging/tree/manifest.json"

if [ "$mode" = publish ]; then
  find "$PRODUCTS_DIR" -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +
  cp -R "$staging/tree/." "$PRODUCTS_DIR/"
  echo "reconcile.sh: published $count product(s)"
  exit 0
fi

expected_files="$staging/expected-files"
actual_files="$staging/actual-files"
(cd "$staging/tree" && find . -type f | sort) >"$expected_files"
(
  cd "$PRODUCTS_DIR"
  find . -type f \
    ! -name default.nix \
    ! -name products.json \
    ! -name products.json.genie.ts \
    ! -name reconcile.sh |
    sort
) >"$actual_files"

status=0
for tracked in $(cd "$staging/tree" && find . -type f | sort); do
  if ! cmp -s "$staging/tree/$tracked" "$PRODUCTS_DIR/$tracked"; then
    echo "reconcile.sh: tracked artifact is stale: ${tracked#./}" >&2
    status=1
  fi
done
if ! cmp -s "$expected_files" "$actual_files"; then
  echo "reconcile.sh: tracked artifact file set differs from declared products" >&2
  diff -u "$expected_files" "$actual_files" >&2 || true
  status=1
fi
if [ "$status" -ne 0 ]; then
  echo "reconcile.sh: run the publish mode to refresh nix/buck2-products" >&2
fi
exit "$status"
