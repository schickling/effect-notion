# Megarepo tasks.
#
# Uses the `mr` CLI for megarepo operations.
#
# Tasks:
# - mr:bootstrap - Materialize the minimal lock-based members needed for local tooling
# - mr:setup - Materialize committed root members without fetching or rewriting locks
# - mr:fetch-apply - Fetch latest refs and apply to workspace (mr fetch --apply)
# - mr:lock - Record the current workspace into megarepo.lock (mr lock)
# - mr:apply - Apply megarepo.lock to the workspace (explicit apply operation)
# - mr:check - Verify megarepo setup is complete
# - mr:lock-sync-check - Verify Nix lock files match megarepo.lock revisions (~5ms)
#
# Options:
# - syncAll: Whether explicit update/apply tasks use `--all` (recursive nested
#   sync). Default: true for backwards compatibility.
#   Set to false in CI where root members are already synced and nested sync
#   may fail due to credential scoping or version mismatches.
# - bootstrapMembers: Minimal members that must exist before tooling like genie
#   can evaluate. Uses lock-based `mr apply --only ...` and never fetches remote
#   refs. Default: [ ] (task becomes a no-op)
# NOTE: No pnpm:install:megarepo dependency here — this shared module is used by
# repos where megarepo may be a Nix package (no pnpm install needed). Repos that
# use source-mode megarepo via pnpm should add dependencies in their devenv.nix:
#   tasks."mr:setup".after = [ "pnpm:install:megarepo" ];
#   tasks."mr:fetch-apply".after = [ "pnpm:install:megarepo" ];
{
  syncAll ? true,
  bootstrapMembers ? [ ],
  # Real derivation/path backing the `mr` guard. When set, the guard owns
  # `bin/mr` and exec's this by absolute path under passthrough (see
  # cli-guard.nix). Required for source-mode `mr` (no node_modules/.bin
  # fallback) so passthrough does not exit 127.
  mrPkg ? null,
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
  jq = "${pkgs.jq}/bin/jq";
  bootstrapOnlyArgs = lib.concatMapStringsSep " " (
    member: "--only ${lib.escapeShellArg member}"
  ) bootstrapMembers;
  cacheRoot = ".devenv/task-cache/mr-apply";
  membersFile = "${cacheRoot}/members.txt";
  recordWorkspaceMembers = ''
    set -o pipefail
    mkdir -p ${lib.escapeShellArg cacheRoot}
    tmp_members_file="$(mktemp)"
    # Rewrite the manifest atomically so a failed `mr ls` never leaves behind
    # an empty file that would make the warm-path output proof vacuous.
    mr ls --output json \
      | ${jq} -r '${mrLsMemberNamesJq}' \
      | while IFS= read -r member; do
          [ -n "$member" ] || continue
          case ",''${MEGAREPO_SKIP_MEMBERS:-}," in
            *,"$member",*) continue ;;
          esac
          printf '%s\n' "$member"
        done \
      | LC_ALL=C sort -u > "$tmp_members_file"
    mv "$tmp_members_file" ${lib.escapeShellArg membersFile}
  '';

  # Single-pass jq script that compares megarepo.lock member commits against
  # a Nix lock file (devenv.lock or flake.lock). Handles multiple inputs
  # pointing to the same repo (e.g. effect-utils + playwright), including
  # branch-pinned git locks that encode GitHub remotes as `type = "git"`.
  # Takes two args: $1 = megarepo.lock path, $2 = lock file path
  lockSyncCheckScript = ''
    set -euo pipefail

    ml="$1"
    lf="$2"

    mismatches=$(${jq} -n \
      --slurpfile ml "$ml" \
      --slurpfile lf "$lf" \
      -f ${./megarepo-lock-sync.jq})

    count=$(echo "$mismatches" | ${jq} -r 'length')
    if [ "$count" -gt 0 ]; then
      echo "$mismatches" | ${jq} -r '.[] | "  \(.member) (\(.input)): expected \(.expected[0:12])… got \(.actual[0:12])… [\(.reason)]"'
      return 1
    fi
    return 0
  '';

  loadCheckSkipMembersScript = ''
    _mr_skip_csv="''${MEGAREPO_SKIP_MEMBERS:-}"

    build_mr_skip_args() {
      MR_SKIP_ARGS=()
      if [ -z "$_mr_skip_csv" ]; then
        return 0
      fi

      MR_SKIP_ARGS+=(--skip "$_mr_skip_csv")
    }

    should_skip_member() {
      local member="$1"
      if [ -z "$_mr_skip_csv" ]; then
        return 1
      fi

      case ",$_mr_skip_csv," in
        *,"$member",*) return 0 ;;
        *) return 1 ;;
      esac
    }
  '';

  checkWorkspaceMembersScript = ''
    set -o pipefail
    workspace_root="$(mr root --output json | ${jq} -er '.root')"
    [ -d "$workspace_root/repos" ] || exit 1

    ${loadCheckSkipMembersScript}

    members=$(mr ls --output json | ${jq} -r '${mrLsMemberNamesJq}') || exit 1
    for member in $members; do
      if should_skip_member "$member"; then
        continue
      fi
      if [ ! -L "$workspace_root/repos/$member" ] && [ ! -d "$workspace_root/repos/$member" ]; then
        exit 1
      fi
    done
  '';

  mrLsMemberNamesJq = ''
    select(._tag == "Success")
    | (.members // .value.members // .value.value.members // [])
    | .[].name
  '';

  mrStatusCheck = ''
    # Use the already-installed source CLI here. `nix run ...#megarepo` adds a
    # second eval/build hop to every warm status check.
    if [ ! -f ./megarepo.kdl ] && [ ! -f ./megarepo.json ]; then
      exit 0
    fi

    if [ "''${DEVENV_SETUP_OUTER_CACHE_HIT:-0}" = "1" ]; then
      ${checkWorkspaceMembersScript}
      exit 0
    fi

    ${checkWorkspaceMembersScript}

    status_json=$(mr status --output json 2>/dev/null) || exit 1
    echo "$status_json" \
      | ${jq} -e '(.syncNeeded // false) == false and (.applyNeeded // false) == false' \
      >/dev/null 2>&1
  '';

  tasks = {
    "mr:bootstrap" = {
      guard = "mr";
      description = "Materialize bootstrap members from megarepo.lock";
      exec = trace.exec "mr:bootstrap" ''
        if [ ! -f ./megarepo.kdl ] && [ ! -f ./megarepo.json ]; then
          exit 0
        fi

        if [ "${toString (builtins.length bootstrapMembers)}" -eq 0 ]; then
          exit 0
        fi

        mr apply --worktree-mode commit ${bootstrapOnlyArgs}
      '';
      status = trace.status "mr:bootstrap" "path" ''
        if [ ! -f ./megarepo.kdl ] && [ ! -f ./megarepo.json ]; then
          exit 0
        fi

        if [ "${toString (builtins.length bootstrapMembers)}" -eq 0 ]; then
          exit 0
        fi

        if [ ! -d ./repos ]; then
          exit 1
        fi

        ${lib.concatMapStringsSep "\n" (member: ''
          if [ ! -L "./repos/${member}" ] && [ ! -d "./repos/${member}" ]; then
            exit 1
          fi
        '') bootstrapMembers}

        exit 0
      '';
    };

    "mr:setup" = {
      guard = "mr";
      description = "Materialize committed root members without fetching or rewriting locks";
      exec = trace.exec "mr:setup" ''
        set -euo pipefail

        if [ ! -f ./megarepo.kdl ] && [ ! -f ./megarepo.json ]; then
          exit 0
        fi

        ${loadCheckSkipMembersScript}
        build_mr_skip_args
        mr apply --worktree-mode tracking --lock-sync off "''${MR_SKIP_ARGS[@]}"
        ${recordWorkspaceMembers}
      '';
      status = trace.status "mr:setup" "binary" mrStatusCheck;
    };

    "mr:fetch-apply" = {
      guard = "mr";
      description = "Fetch latest refs and apply to workspace";
      exec = trace.exec "mr:fetch-apply" ''
        set -euo pipefail

        if [ ! -f ./megarepo.kdl ] && [ ! -f ./megarepo.json ]; then
          exit 0
        fi

        ${loadCheckSkipMembersScript}
        build_mr_skip_args
        mr fetch --apply --worktree-mode tracking${if syncAll then " --all" else ""} "''${MR_SKIP_ARGS[@]}"
        ${recordWorkspaceMembers}
      '';
      status = trace.status "mr:fetch-apply" "binary" mrStatusCheck;
    };

    "mr:lock" = {
      guard = "mr";
      description = "Record current workspace state into megarepo.lock";
      exec = trace.exec "mr:lock" ''
        if [ ! -f ./megarepo.kdl ] && [ ! -f ./megarepo.json ]; then
          exit 0
        fi

        ${loadCheckSkipMembersScript}
        build_mr_skip_args
        mr lock${if syncAll then " --all" else ""} "''${MR_SKIP_ARGS[@]}"
      '';
    };

    "mr:apply" = {
      guard = "mr";
      description = "Apply megarepo.lock to workspace";
      exec = trace.exec "mr:apply" ''
        set -euo pipefail

        if [ ! -f ./megarepo.kdl ] && [ ! -f ./megarepo.json ]; then
          exit 0
        fi

        ${loadCheckSkipMembersScript}
        build_mr_skip_args
        mr apply --worktree-mode tracking${if syncAll then " --all" else ""} "''${MR_SKIP_ARGS[@]}"
        ${recordWorkspaceMembers}
      '';
      status = trace.status "mr:apply" "binary" mrStatusCheck;
    };

    "mr:check" = {
      guard = "mr";
      description = "Verify megarepo setup is complete";
      after = [ "mr:setup" ];
      # Check that repos dir exists and all members have symlinks
      status = trace.status "mr:check" "path" ''
        if [ ! -f ./megarepo.kdl ] && [ ! -f ./megarepo.json ]; then
          exit 0
        fi

        ${checkWorkspaceMembersScript}
        exit 0
      '';
      exec = trace.exec "mr:check" ''
        set -o pipefail
        if [ ! -f ./megarepo.kdl ] && [ ! -f ./megarepo.json ]; then
          exit 0
        fi

        workspace_root="$(mr root --output json | ${jq} -er '.root')"
        if [ ! -d "$workspace_root/repos" ]; then
          echo "[devenv] Missing workspace repos/ directory." >&2
          echo "[devenv] Fix: devenv tasks run mr:setup" >&2
          exit 1
        fi

        ${loadCheckSkipMembersScript}

        # Check for missing member symlinks
        missing=""
        members=$(mr ls --output json | ${jq} -r '${mrLsMemberNamesJq}') || exit 1
        for member in $members; do
          if should_skip_member "$member"; then
            continue
          fi
          if [ ! -L "$workspace_root/repos/$member" ] && [ ! -d "$workspace_root/repos/$member" ]; then
            missing="$missing $member"
          fi
        done

        if [ -n "$missing" ]; then
          echo "[devenv] Missing member symlinks:$missing" >&2
          echo "[devenv] Fix: devenv tasks run mr:setup" >&2
          exit 1
        fi
      '';
    };

    "mr:lock-sync-check" = {
      description = "Verify Nix lock files match megarepo.lock revisions";
      status = trace.status "mr:lock-sync-check" "binary" ''
        if [ ! -f ./megarepo.lock ]; then
          exit 0
        fi

        check_lock() {
          ${lockSyncCheckScript}
        }

        if [ -f ./devenv.lock ]; then
          check_lock ./megarepo.lock ./devenv.lock || exit 1
        fi

        if [ -f ./flake.lock ]; then
          check_lock ./megarepo.lock ./flake.lock || exit 1
        fi

        exit 0
      '';
      exec = trace.exec "mr:lock-sync-check" ''
        set -euo pipefail

        if [ ! -f ./megarepo.lock ]; then
          exit 0
        fi

        check_lock() {
          ${lockSyncCheckScript}
        }

        failed=0

        if [ -f ./devenv.lock ]; then
          echo "Checking devenv.lock against megarepo.lock..."
          if ! check_lock ./megarepo.lock ./devenv.lock; then
            failed=1
          else
            echo "  ✓ devenv.lock in sync"
          fi
        fi

        if [ -f ./flake.lock ]; then
          echo "Checking flake.lock against megarepo.lock..."
          if ! check_lock ./megarepo.lock ./flake.lock; then
            failed=1
          else
            echo "  ✓ flake.lock in sync"
          fi
        fi

        if [ "$failed" -eq 1 ]; then
          echo ""
          echo "Lock files out of sync with megarepo.lock."
          echo "Fix: devenv tasks run mr:apply"
          exit 1
        fi
      '';
    };

    "mr:source-policy-check" = {
      guard = "mr";
      description = "Verify megarepo GitHub source and lock-file policy";
      status = trace.status "mr:source-policy-check" "binary" ''
        if [ ! -f ./megarepo.lock ]; then
          exit 0
        fi

        mr check --all
      '';
      exec = trace.exec "mr:source-policy-check" ''
        set -euo pipefail

        if [ ! -f ./megarepo.lock ]; then
          exit 0
        fi

        mr check --all
      '';
    };
  };
in
{
  # mr shells out to git for clone/fetch/worktree operations
  packages = [
    pkgs.git
    pkgs.openssh
  ]
  ++ cliGuard.fromTasks {
    inherit tasks;
    reals = lib.optionalAttrs (mrPkg != null) { mr = mrPkg; };
  };

  tasks =
    cliGuard.stripGuards tasks
    // lib.optionalAttrs (bootstrapMembers != [ ]) {
      # Repos that source-import genie helpers from bootstrap members should ensure
      # those members exist before any genie-backed task runs.
      "genie:prepare".after = lib.mkAfter [ "mr:bootstrap" ];
    };
}
