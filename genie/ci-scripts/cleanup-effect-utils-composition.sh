#!/usr/bin/env bash
set -euo pipefail
store_root="${MEGAREPO_STORE:-${RUNNER_TEMP:?}/megarepo-store/${GITHUB_RUN_ID:-local}/${GITHUB_RUN_ATTEMPT:-0}/${GITHUB_JOB:-job}}"
branch_seed="ci-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-${GITHUB_JOB:-job}"
branch_name="$(printf '%s' "$branch_seed" | tr -c 'A-Za-z0-9_-' '_')"
branch_ref="refs/heads/$branch_name"
repo_root="$store_root/github.com/overengineeringstudio/effect-utils"
bare_repo="$repo_root/.bare"
workspace_root="$repo_root/$branch_ref"
member_root="$workspace_root/repos/effect-utils"

if [ ! -e "$workspace_root" ] && [ ! -L "$workspace_root" ]; then
  exit 0
fi

# Everything below compares these paths against Git output, and Git always
# answers with resolved paths. RUNNER_TEMP and MEGAREPO_STORE arrive as the
# runner set them, which on macOS is under the /var -> /private/var symlink, so
# an unresolved store root would never equal the worktree Git reports and the
# guards below would abort a legitimate cleanup. Resolve once, on both sides,
# and re-derive; the existence test above deliberately stays on the raw path.
store_root="$(cd "$store_root" && pwd -P)"
runner_temp="$(cd "${RUNNER_TEMP:?RUNNER_TEMP not set}" && pwd -P)"
repo_root="$store_root/github.com/overengineeringstudio/effect-utils"
bare_repo="$repo_root/.bare"
workspace_root="$repo_root/$branch_ref"
member_root="$workspace_root/repos/effect-utils"

test -d "$bare_repo"
[ "$(git --git-dir="$bare_repo" rev-parse --is-bare-repository)" = true ]
case "$store_root" in
  "$runner_temp"/megarepo-store/*) ;;
  *) echo "::error::refusing cleanup outside job-local runner store: $store_root" >&2; exit 1 ;;
esac

owned_worktree="$member_root"

current_worktree=
registered_worktree=
matching_registrations=0
while IFS= read -r -d '' field; do
  case "$field" in
    worktree\ *) current_worktree="${field#worktree }" ;;
    "branch $branch_ref")
      test -n "$current_worktree"
      registered_worktree="$current_worktree"
      matching_registrations=$((matching_registrations + 1))
      ;;
    '') current_worktree= ;;
  esac
done < <(git --git-dir="$bare_repo" worktree list --porcelain -z)

[ "$matching_registrations" -eq 1 ]
[ "$registered_worktree" = "$owned_worktree" ]
[ "$(git -C "$owned_worktree" rev-parse --path-format=absolute --show-toplevel)" = "$owned_worktree" ]
[ "$(git -C "$owned_worktree" rev-parse --path-format=absolute --git-common-dir)" = "$bare_repo" ]
[ "$(git -C "$owned_worktree" symbolic-ref --quiet HEAD)" = "$branch_ref" ]

git --git-dir="$bare_repo" worktree remove --force "$owned_worktree"
rm -rf -- "$workspace_root"
git --git-dir="$bare_repo" update-ref -d "$branch_ref"
rm -rf -- "$store_root"
