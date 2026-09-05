{
  authorityTask ? "buck2:editor-authority",
  after ? [
    "mr:apply"
    "genie:run"
  ],
  buckCell ? "effect_utils",
  statusFile ? ".devenv/buck-watch-status.json",
  workspaceAuthority ? ".devenv/editor-workspace-authority.json",
  snapshotRetention ? 3,
}:
{
  lib,
  pkgs,
  ...
}:
let
  trace = import ../lib/trace.nix { inherit lib; };
  editorViewRunner = pkgs.writeShellScript "buck-editor-view" ''
    set -euo pipefail
    root="''${DEVENV_ROOT:-$PWD}"
    workspace_root="$(${pkgs.coreutils}/bin/realpath "$root/../..")"
    exec "$workspace_root/.megarepo/bin/buck2" run effect_utils//scripts:editor-view -- "$@"
  '';
  taskAfter = after ++ [ authorityTask ];
  common = ''
    root="''${DEVENV_ROOT:-$PWD}"
    workspace_root="$(${pkgs.coreutils}/bin/realpath "$root/../..")"
    buck="$workspace_root/.megarepo/bin/buck2"
    editor_view=${editorViewRunner}
    authority="$root/${workspaceAuthority}"
    common_args=(
      --repo-root "$root"
      --workspace-root "$workspace_root"
      --buck-cell ${lib.escapeShellArg buckCell}
      --buck2 "$buck"
      --editor-view "$editor_view"
      --workspace-authority "$authority"
      --cp ${pkgs.coreutils}/bin/cp
      --mv ${pkgs.coreutils}/bin/mv
      --snapshot-retention ${toString snapshotRetention}
    )
  '';
in
{
  tasks."buck2:typescript:publish-editor-views" = {
    description = "Build and atomically publish all Buck editor views";
    after = taskAfter;
    exec = trace.exec "buck2:typescript:publish-editor-views" ''
      set -euo pipefail
      ${common}
      exec "$buck" run effect_utils//scripts:buck-watch -- publish "''${common_args[@]}"
    '';
  };

  tasks."buck2:typescript:check-editor-views" = {
    description = "Build and check all Buck editor views";
    after = taskAfter;
    exec = trace.exec "buck2:typescript:check-editor-views" ''
      set -euo pipefail
      ${common}
      exec "$buck" run effect_utils//scripts:buck-watch -- check "''${common_args[@]}"
    '';
  };

  tasks."buck2:typescript:watch" = {
    description = "Watch TypeScript sources and reconcile affected Buck products/editor views";
    after = taskAfter;
    exec = trace.exec "buck2:typescript:watch" ''
      set -euo pipefail
      ${common}
      export PATH=${
        lib.makeBinPath [
          pkgs.coreutils
          pkgs.watchman
        ]
      }
      exec "$buck" run effect_utils//scripts:buck-watch -- watch "''${common_args[@]}" \
        --watchman ${pkgs.watchman}/bin/watchman \
        --status-file "$root/${statusFile}"
    '';
  };

  tasks."buck2:typescript:watch-status" = {
    description = "Print the machine-readable Buck watch status";
    exec = trace.exec "buck2:typescript:watch-status" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      workspace_root="$(${pkgs.coreutils}/bin/realpath "$root/../..")"
      exec "$workspace_root/.megarepo/bin/buck2" run effect_utils//scripts:buck-watch -- status \
        --status-file "$root/${statusFile}"
    '';
  };
}
