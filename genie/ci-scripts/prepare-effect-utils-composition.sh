#!/usr/bin/env bash
set -euo pipefail
checkout_root="${GITHUB_WORKSPACE:?GITHUB_WORKSPACE not set}"
export XDG_CACHE_HOME="${RUNNER_TEMP:?RUNNER_TEMP not set}/composition-state/nix-cache"
mkdir -p "$XDG_CACHE_HOME"
printf 'XDG_CACHE_HOME=%s\n' "$XDG_CACHE_HOME" >> "$GITHUB_ENV"
source_sha="$(git -C "$checkout_root" rev-parse --verify HEAD)"
case "$source_sha" in
  ''|*[!0-9a-f]*) echo "::error::checkout HEAD is not an exact lowercase Git object id: $source_sha" >&2; exit 1 ;;
esac
checkout_status_before="$(git -C "$checkout_root" status --porcelain=v1 --untracked-files=all)"

# Fail closed when any component of a composed path is an absolute symlink.
#
# Uploaded CAS bytes and action keys are derived from the composed member tree, so a path
# component that hops to an unrelated absolute location on the runner would publish
# digests whose provenance is not the tree under proof, and would make two compositions
# that look distinct share bytes. This runs BEFORE the composition overlay (and therefore
# before the first upload-enabled Buck invocation) and again on the composed member root.
#
# This checks the PREFIX only. A relative symlink in a prefix component is accepted here
# because it cannot be rewritten to a foreign absolute location by relocation; it is NOT
# accepted on the grounds that relative links stay inside the prefix, which is false
# (`../../outside` escapes). Content-level escape is covered by
# `assert_member_symlinks_stay_inside_workspace` below.
assert_no_absolute_symlink_traversal() {
  local subject="$1" scanned='' component link_target
  local -a components
  IFS='/' read -r -a components <<<"${subject#/}"
  for component in "${components[@]}"; do
    scanned="$scanned/$component"
    [ -L "$scanned" ] || continue
    if ! link_target="$(readlink "$scanned")"; then
      echo "::error::cannot read a symlink on the composed path: $scanned" >&2
      exit 1
    fi
    case "$link_target" in
      /*)
        echo "::error::composed path traverses an absolute symlink: $scanned -> $link_target" >&2
        exit 1
        ;;
    esac
  done
}

# Fail closed when a symlink INSIDE the composed member escapes the composed workspace.
#
# Buck records a symlink that leaves the project as an external symlink whose digest comes
# from the absolute target path rather than from bytes, so an escaping link either keys one
# action differently in every job prefix or maps one key onto whatever that absolute path
# holds on the next host. Both are cache poisoning, so an absolute target and a relative
# target that resolves outside the workspace are equally refused.
#
# Scope is the member's TRACKED symlinks (`git ls-files -s` mode 120000). The caller
# asserts the member worktree is clean first, so at this point tracked content IS the whole
# member tree, and that is exactly the revision whose bytes the lane uploads. Links a later
# devenv shell entry may create (for example a `/nix/store` `.pre-commit-config.yaml`) are
# deliberately out of scope: they are not part of the revision and no Buck target declares
# them as a source.
assert_member_symlinks_stay_inside_workspace() {
  local member="$1" workspace="$2" workspace_real link mode target resolved
  workspace_real="$(cd "$workspace" && pwd -P)"
  while IFS= read -r -d '' entry; do
    mode="${entry%% *}"
    [ "$mode" = 120000 ] || continue
    link="${entry#*$'\t'}"
    if ! target="$(readlink "$member/$link")"; then
      echo "::error::cannot read tracked member symlink: $link" >&2
      exit 1
    fi
    case "$target" in
      /*)
        echo "::error::tracked member symlink is absolute: $link -> $target" >&2
        exit 1
        ;;
    esac
    # `-e` on purpose: a dangling tracked link is a refusal, not a pass, because there is
    # nothing whose provenance could be checked.
    if ! resolved="$(realpath -e "$member/$link" 2>/dev/null)"; then
      echo "::error::tracked member symlink does not resolve: $link -> $target" >&2
      exit 1
    fi
    case "$resolved" in
      "$workspace_real"/*) ;;
      *)
        echo "::error::tracked member symlink escapes the composed workspace: $link -> $target (resolves to $resolved)" >&2
        exit 1
        ;;
    esac
  done < <(git -C "$member" ls-files -s -z)
}

mr_out="$(cd "$checkout_root" && nix build --no-link --print-out-paths .#megarepo)"
mr_bin="$mr_out/bin/mr"
if [ ! -x "$mr_bin" ]; then
  echo "::error::exact-checkout megarepo build did not produce an executable: $mr_bin" >&2
  exit 1
fi

branch_seed="ci-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-${GITHUB_JOB:-job}"
branch_name="$(printf '%s' "$branch_seed" | tr -c 'A-Za-z0-9_-' '_')"
branch_ref="refs/heads/$branch_name"
store_root="${MEGAREPO_STORE:-${RUNNER_TEMP:?}/megarepo-store/${GITHUB_RUN_ID:-local}/${GITHUB_RUN_ATTEMPT:-0}/${GITHUB_JOB:-job}}"
repo_root="$store_root/github.com/overengineeringstudio/effect-utils"
bare_repo="$repo_root/.bare"
workspace_root="$repo_root/$branch_ref"
member_root="$workspace_root/repos/effect-utils"
mkdir -p "$repo_root"
if [ ! -d "$bare_repo" ]; then
  git init --bare "$bare_repo"
elif [ "$(git --git-dir="$bare_repo" rev-parse --is-bare-repository)" != true ]; then
  echo "::error::canonical megarepo store path is not a bare Git repository: $bare_repo" >&2
  exit 1
fi
origin_url="${EFFECT_UTILS_CI_ORIGIN_URL:-https://github.com/${GITHUB_REPOSITORY:?GITHUB_REPOSITORY not set}.git}"
if git --git-dir="$bare_repo" remote get-url origin >/dev/null 2>&1; then
  git --git-dir="$bare_repo" remote set-url origin "$origin_url"
else
  git --git-dir="$bare_repo" remote add origin "$origin_url"
fi

# Preserve the full main history required by merge-base consumers and fetch the
# exact checked-out commit from the public origin, never from a shallow checkout.
git --git-dir="$bare_repo" fetch --no-tags --prune origin \
  '+refs/heads/main:refs/remotes/origin/main' \
  "$source_sha"
if git --git-dir="$bare_repo" show-ref --verify --quiet "$branch_ref"; then
  existing_sha="$(git --git-dir="$bare_repo" rev-parse "$branch_ref^{commit}")"
  if [ "$existing_sha" != "$source_sha" ]; then
    echo "::error::job-owned branch already names another commit: $branch_ref ($existing_sha != $source_sha)" >&2
    exit 1
  fi
  if [ ! -d "$workspace_root" ]; then
    echo "::error::job-owned branch exists without its canonical workspace: $workspace_root" >&2
    exit 1
  fi
else
  if [ -e "$workspace_root" ] || [ -L "$workspace_root" ]; then
    echo "::error::refusing foreign canonical workspace path: $workspace_root" >&2
    exit 1
  fi
  git --git-dir="$bare_repo" update-ref "$branch_ref" "$source_sha"
  mkdir -p "$(dirname "$workspace_root")"
  git --git-dir="$bare_repo" worktree add "$workspace_root" "$branch_name"
fi

# Before the overlay: no upload-enabled Buck invocation has run yet, and the whole
# workspace prefix is already materialized, so this is the last point at which a
# provenance-breaking path can be rejected for free.
assert_no_absolute_symlink_traversal "$workspace_root"

workspace_parent="$(dirname "$workspace_root")"
(
  cd "$workspace_parent"
  env -i \
    HOME="$HOME" \
    TMPDIR="${TMPDIR:-/tmp}" \
    XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}" \
    PATH="$PATH" \
    NIX_CONFIG='accept-flake-config = true' \
    MEGAREPO_STORE="$store_root" \
    CI=true \
    BUCK2_NO_REMOTE_CACHE="${BUCK2_NO_REMOTE_CACHE:-}" \
    BUCK2_CACHE_ENDPOINT="${BUCK2_CACHE_ENDPOINT:-}" \
    BUCK2_CACHE_INSTANCE_NAME="${BUCK2_CACHE_INSTANCE_NAME:-}" \
    "$mr_bin" --cwd "$workspace_root" apply --worktree-mode tracking --lock-sync off --output ci
)

if git -C "$workspace_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "::error::synthesized workspace root must not be a Git worktree: $workspace_root" >&2
  exit 1
fi
test -f "$workspace_root/.megarepo-owned-worktree.json"
test -f "$workspace_root/.megarepo/composition-generation.json"
test -f "$workspace_root/.buckconfig"
test -x "$workspace_root/.megarepo/bin/buck2"
test -L "$workspace_root/repos/effect"
assert_no_absolute_symlink_traversal "$member_root"
# The tracked-symlink scope below is only the whole member tree if nothing untracked or
# modified is present, so state that premise instead of assuming it.
member_status="$(git -C "$member_root" status --porcelain=v1 --untracked-files=all)"
if [ -n "$member_status" ]; then
  echo "::error::composed member is not clean, so tracked content is not the whole member tree:" >&2
  printf '%s\n' "$member_status" >&2
  exit 1
fi
assert_member_symlinks_stay_inside_workspace "$member_root" "$workspace_root"
member_sha="$(git -C "$member_root" rev-parse --verify HEAD)"
member_ref="$(git -C "$member_root" symbolic-ref --quiet HEAD)"
if [ "$member_sha" != "$source_sha" ] || [ "$member_ref" != "$branch_ref" ]; then
  echo "::error::owned member identity mismatch: $member_ref@$member_sha, expected $branch_ref@$source_sha" >&2
  exit 1
fi
if [ "$(git -C "$checkout_root" rev-parse --verify HEAD)" != "$source_sha" ] || [ "$(git -C "$checkout_root" status --porcelain=v1 --untracked-files=all)" != "$checkout_status_before" ]; then
  echo "::error::composition preparation modified the actions checkout" >&2
  exit 1
fi

export EFFECT_UTILS_WORKSPACE_ROOT="$workspace_root"
export EFFECT_UTILS_MEMBER_ROOT="$member_root"
export MEGAREPO_STORE="$store_root"
printf 'EFFECT_UTILS_WORKSPACE_ROOT=%s\nEFFECT_UTILS_MEMBER_ROOT=%s\nMEGAREPO_STORE=%s\n' "$workspace_root" "$member_root" "$store_root" >> "$GITHUB_ENV"
