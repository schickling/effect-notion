#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 5 ]; then
  echo "usage: $0 REPO_ROOT PACKAGE_PATH BUCK_TARGET DECLARATION_ENTRYPOINT PROJECT [DECLARATION_SOURCE...]" >&2
  exit 2
fi

root="$(cd "$1" && pwd -P)"
package_path="$2"
target="$3"
declaration_entrypoint="$4"
project="$5"
shift 5
# Registry-declared handwritten declarations: exactly the set the emit action
# copies into the published dist.
declaration_sources=("$@")
package_dir="$root/$package_path"
dist="$package_dir/dist"
mode="${TYPESCRIPT_DIST_MODE:?TYPESCRIPT_DIST_MODE must be publish or check}"
staging_root="$(mktemp -d "$package_dir/.dist-buck2.XXXXXX")"
# `staging` is mode-specific because the two modes have different depth
# constraints, and both are load-bearing. Buck materializes its output tree into
# a fresh path, so publication stages `<staging_root>/dist` and swaps that whole
# directory into place. The standalone comparison instead compiles, and a
# compiler records declaration-map `sources` relative to the emitting directory:
# staging one level deeper than `dist` would prepend a `../` to every map and
# report the entire map surface as stale. So it emits into the staging root
# itself, which sits exactly where `dist` sits — one directory below the package
# root, the same depth the Buck emit action compiles at inside its own tree.
cleanup_staging() {
  status=$?
  trap - EXIT
  if [ -e "$staging_root" ]; then
    chmod -R u+w "$staging_root" || status=$?
    rm -rf -- "$staging_root" || status=$?
  fi
  exit "$status"
}
trap cleanup_staging EXIT

validate_dist() {
  local candidate="$1"
  local context="$2"
  if [ ! -d "$candidate" ]; then
    echo "$context did not materialize a directory: $candidate" >&2
    return 1
  fi
  if [ ! -f "$candidate/$declaration_entrypoint" ]; then
    echo "$context is missing $declaration_entrypoint: $candidate" >&2
    return 1
  fi
}

# The emit action copies handwritten declarations verbatim instead of compiling
# them, so the detached comparison has to stage the identical registry-declared
# set. Without this every copied `.d.ts` reads as staleness no compile can fix.
copy_declaration_sources() {
  local destination="$1"
  local relative
  [ "${#declaration_sources[@]}" -gt 0 ] || return 0
  for relative in "${declaration_sources[@]}"; do
    if [ ! -f "$package_dir/$relative" ]; then
      echo "Declared handwritten declaration source is missing: $package_path/$relative" >&2
      return 1
    fi
    mkdir -p "$destination/$(dirname "$relative")"
    cp -- "$package_dir/$relative" "$destination/$relative"
  done
}

case "$mode" in
  publish)
    : "${BUCK2_BIN:?BUCK2_BIN must name the Buck2 executable}"
    : "${WORKSPACE_ROOT:?WORKSPACE_ROOT must name the synthesized composition root}"
    staging="$staging_root/dist"
    (
      cd "$WORKSPACE_ROOT"
      "$BUCK2_BIN" build "$target" --out "$staging"
    )
    validate_dist "$staging" "Buck target $target"
    ;;
  check)
    : "${TSGO_BIN:?TSGO_BIN must name the tsgo executable}"
    : "${DIFF_BIN:?DIFF_BIN must name the diff executable}"
    staging="$staging_root"
    # A detached checkout cannot run Buck, so this mode only compares against
    # declarations a composed workspace already published. State that once, up
    # front, instead of spending a full compile to fail inside the comparison.
    if [ ! -f "$dist/$declaration_entrypoint" ]; then
      echo "Standalone declaration check for $package_path found no published declarations at $package_path/dist/$declaration_entrypoint, so there is nothing to compare against." >&2
      echo "Publish them from a composed workspace root (devenv tasks run mr:apply buck2:typescript:materialize-dist); a detached checkout has no Buck composition and cannot materialize declarations itself." >&2
      exit 1
    fi
    # Mirror the emit action exactly: declaration-only, non-composite,
    # non-incremental. Emitting JavaScript here would only be excluded from the
    # comparison again, which is how extra published files used to hide.
    (
      cd "$package_dir"
      "$TSGO_BIN" \
        --project "$project" \
        --outDir "$staging" \
        --noEmit false \
        --composite false \
        --incremental false \
        --declaration true \
        --emitDeclarationOnly true \
        --pretty false
    )
    validate_dist "$staging" "Standalone declaration check for $package_path"
    copy_declaration_sources "$staging"
    # Compare the declaration surface exactly, files and maps alike. The one
    # exclusion is `tsconfig.tsbuildinfo`: source-owned build metadata rather
    # than a published declaration, it embeds absolute paths, and this
    # comparison deliberately produces none (`--incremental false`), so a
    # published copy would otherwise read as staleness no compile can clear.
    if ! "$DIFF_BIN" --no-dereference --recursive --brief \
      --exclude=tsconfig.tsbuildinfo "$staging" "$dist"; then
      echo "Published $package_path dist is stale; materialize it from a synthesized composition root" >&2
      exit 1
    fi
    exit 0
    ;;
  *)
    echo "TYPESCRIPT_DIST_MODE must be publish or check, got: $mode" >&2
    exit 2
    ;;
esac

had_dist=false
if [ -e "$dist" ] || [ -L "$dist" ]; then
  had_dist=true
  mv --exchange --no-copy -T "$staging" "$dist"
else
  mv --no-copy -T "$staging" "$dist"
fi

if ! validate_dist "$dist" "Published $package_path dist"; then
  echo "Published $package_path dist failed validation; restoring the previous dist" >&2
  if [ "$had_dist" = true ]; then
    mv --exchange --no-copy -T "$staging" "$dist"
  else
    rm -rf -- "$dist"
  fi
  exit 1
fi
