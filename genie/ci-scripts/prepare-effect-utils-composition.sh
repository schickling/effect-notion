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
workspace_parent="$(dirname "$workspace_root")"
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
  mkdir -p "$workspace_parent"
  created_member_root="$(
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
      "$mr_bin" store worktree new overengineeringstudio/effect-utils \
        --ref "$branch_name" \
        --base "$source_sha" \
        --porcelain
  )"
  case "$created_member_root" in
    "$workspace_root"|"$member_root") ;;
    *)
      echo "::error::worktree creation returned '$created_member_root', expected '$workspace_root' or '$member_root'" >&2
      exit 1
      ;;
  esac
fi
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
    "$mr_bin" --cwd "$workspace_root" apply --worktree-mode tracking --lock-sync off --output ci
)

if git -C "$workspace_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "::error::synthesized workspace root must not be a Git worktree: $workspace_root" >&2
  exit 1
fi
test -f "$workspace_root/.megarepo/composition-generation.json"
test -f "$workspace_root/.buckconfig"
test -x "$workspace_root/.megarepo/bin/buck2"
test -L "$workspace_root/repos/effect"
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
