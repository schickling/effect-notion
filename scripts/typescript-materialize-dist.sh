#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 REPO_ROOT PACKAGE_PATH BUCK_TARGET DECLARATION_ENTRYPOINT" >&2
  exit 2
fi

root="$(cd "$1" && pwd -P)"
package_path="$2"
target="$3"
declaration_entrypoint="$4"
package_dir="$root/$package_path"
dist="$package_dir/dist"
: "${BUCK2_BIN:?BUCK2_BIN must name the Buck2 executable}"
: "${WORKSPACE_ROOT:?WORKSPACE_ROOT must name the synthesized composition root}"

staging_root="$(mktemp -d "$package_dir/.dist-buck2.XXXXXX")"
staging="$staging_root/dist"
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

(
  cd "$WORKSPACE_ROOT"
  "$BUCK2_BIN" build "$target" --out "$staging"
)
validate_dist "$staging" "Buck target $target"

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
