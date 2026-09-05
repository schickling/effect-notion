# Workflow-report tasks backed by @overeng/ci-tools.
#
# CI should only pass GitHub event context and paths through environment
# variables; record collection, comment rendering, and publication live here.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.effectUtils.workflowReport;
  trace = import ../lib/trace.nix { inherit lib; };
  resolvedCiToolsBin = cfg.ciToolsBin;
  ciTools = lib.escapeShellArg resolvedCiToolsBin;
  gh = if cfg.ghBin == null then "${pkgs.gh}/bin/gh" else cfg.ghBin;
in
{
  options.effectUtils.workflowReport = {
    ciToolsBin = lib.mkOption {
      type = lib.types.str;
      description = "Absolute ci-tools binary used by the shared workflow-report tasks.";
    };

    ghBin = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      internal = true;
      description = "Absolute GitHub CLI binary used by the shared workflow-report tasks.";
    };
  };

  config.tasks = {
    "workflow-report:collect-bundle" = {
      description = "Collect marked workflow-report records into a bundle";
      exec = trace.exec "workflow-report:collect-bundle" ''
        set -euo pipefail

        : "''${WORKFLOW_REPORT_BUNDLE_ID:?WORKFLOW_REPORT_BUNDLE_ID is required}"
        : "''${WORKFLOW_REPORT_INPUT_PATHS_JSON:?WORKFLOW_REPORT_INPUT_PATHS_JSON is required}"
        : "''${WORKFLOW_REPORT_OUTPUT_PATH:?WORKFLOW_REPORT_OUTPUT_PATH is required}"

        args=(
          workflow-report collect-bundle
          --bundle-id "$WORKFLOW_REPORT_BUNDLE_ID"
          --input-paths-json "$WORKFLOW_REPORT_INPUT_PATHS_JSON"
          --output-path "$WORKFLOW_REPORT_OUTPUT_PATH"
        )

        if [ -n "''${WORKFLOW_REPORT_RECORD_MARKER:-}" ]; then
          args+=(--record-marker "$WORKFLOW_REPORT_RECORD_MARKER")
        fi
        if [ "''${WORKFLOW_REPORT_ALLOW_MISSING_INPUT:-0}" = "1" ]; then
          args+=(--allow-missing-input)
        fi

        ${ciTools} "''${args[@]}"

        if [ -n "''${WORKFLOW_REPORT_GITHUB_OUTPUT_NAME:-}" ]; then
          : "''${GITHUB_OUTPUT:?GITHUB_OUTPUT is required when WORKFLOW_REPORT_GITHUB_OUTPUT_NAME is set}"
          echo "$WORKFLOW_REPORT_GITHUB_OUTPUT_NAME=$WORKFLOW_REPORT_OUTPUT_PATH" >> "$GITHUB_OUTPUT"
        fi
      '';
    };

    "workflow-report:render-comment-body" = {
      description = "Render a managed workflow-report comment body and summary";
      exec = trace.exec "workflow-report:render-comment-body" ''
        set -euo pipefail

        : "''${WORKFLOW_REPORT_BUNDLE_PATH:?WORKFLOW_REPORT_BUNDLE_PATH is required}"
        : "''${WORKFLOW_REPORT_COMMENT_BODY_PATH:?WORKFLOW_REPORT_COMMENT_BODY_PATH is required}"
        : "''${WORKFLOW_REPORT_SUMMARY_PATH:?WORKFLOW_REPORT_SUMMARY_PATH is required}"
        : "''${WORKFLOW_REPORT_TITLE:?WORKFLOW_REPORT_TITLE is required}"
        : "''${WORKFLOW_REPORT_NO_RECORDS_MESSAGE:?WORKFLOW_REPORT_NO_RECORDS_MESSAGE is required}"
        : "''${WORKFLOW_REPORT_STATE_ID:?WORKFLOW_REPORT_STATE_ID is required}"
        : "''${WORKFLOW_REPORT_ENTRY_ID:?WORKFLOW_REPORT_ENTRY_ID is required}"
        : "''${WORKFLOW_REPORT_ENTRY_LABEL:?WORKFLOW_REPORT_ENTRY_LABEL is required}"

        comments_json="$(mktemp)"
        if [ "''${WORKFLOW_REPORT_EVENT_NAME:-}" = "pull_request" ]; then
          : "''${GH_REPO:?GH_REPO is required for pull_request workflow-report rendering}"
          : "''${WORKFLOW_REPORT_PR_NUMBER:?WORKFLOW_REPORT_PR_NUMBER is required for pull_request workflow-report rendering}"
          ${gh} api "repos/$GH_REPO/issues/$WORKFLOW_REPORT_PR_NUMBER/comments" --paginate > "$comments_json"
        else
          printf '[]' > "$comments_json"
        fi

        ${ciTools} workflow-report render-comment-body \
          --bundle-path "$WORKFLOW_REPORT_BUNDLE_PATH" \
          --comments-path "$comments_json" \
          --comment-body-path "$WORKFLOW_REPORT_COMMENT_BODY_PATH" \
          --summary-path "$WORKFLOW_REPORT_SUMMARY_PATH" \
          --title "$WORKFLOW_REPORT_TITLE" \
          --no-records-message "$WORKFLOW_REPORT_NO_RECORDS_MESSAGE" \
          --state-id "$WORKFLOW_REPORT_STATE_ID" \
          --entry-id "$WORKFLOW_REPORT_ENTRY_ID" \
          --entry-label "$WORKFLOW_REPORT_ENTRY_LABEL" \
          --created-at-utc "''${WORKFLOW_REPORT_CREATED_AT_UTC:-}" \
          --time-zone "''${WORKFLOW_REPORT_TIME_ZONE:-UTC}" \
          --managed-marker "''${WORKFLOW_REPORT_MANAGED_MARKER:-<!-- workflow-report:managed -->}"
      '';
    };

    "workflow-report:publish" = {
      description = "Publish a workflow-report summary and managed pull-request comment";
      exec = trace.exec "workflow-report:publish" ''
        set -euo pipefail

        : "''${WORKFLOW_REPORT_COMMENT_BODY_PATH:?WORKFLOW_REPORT_COMMENT_BODY_PATH is required}"
        : "''${WORKFLOW_REPORT_SUMMARY_PATH:?WORKFLOW_REPORT_SUMMARY_PATH is required}"
        : "''${WORKFLOW_REPORT_STATE_ID:?WORKFLOW_REPORT_STATE_ID is required}"

        if [ -s "$WORKFLOW_REPORT_SUMMARY_PATH" ]; then
          : "''${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required when a workflow report summary exists}"
          cat "$WORKFLOW_REPORT_SUMMARY_PATH" >> "$GITHUB_STEP_SUMMARY"
        fi

        if [ "''${WORKFLOW_REPORT_EVENT_NAME:-}" != "pull_request" ]; then
          exit 0
        fi

        : "''${GH_REPO:?GH_REPO is required for workflow-report PR publishing}"
        : "''${WORKFLOW_REPORT_PR_NUMBER:?WORKFLOW_REPORT_PR_NUMBER is required for workflow-report PR publishing}"

        if [ "''${WORKFLOW_REPORT_HEAD_REPO:-$GH_REPO}" != "$GH_REPO" ]; then
          # stderr, not stdout: devenv does not forward a task's stdout to the
          # caller, so a workflow command echoed there never reaches the runner.
          echo "::notice::workflow report PR comment skipped for fork pull request; summary remains available in the job summary" >&2
          exit 0
        fi

        if [ ! -s "$WORKFLOW_REPORT_COMMENT_BODY_PATH" ]; then
          echo "::notice::workflow report comment body is empty; skipping PR comment" >&2
          exit 0
        fi

        comments_json="$(mktemp)"
        comment_id_file="$(mktemp)"
        ${gh} api "repos/$GH_REPO/issues/$WORKFLOW_REPORT_PR_NUMBER/comments" --paginate > "$comments_json"

        ${ciTools} workflow-report find-comment \
          --comments-path "$comments_json" \
          --comment-body-path "$WORKFLOW_REPORT_COMMENT_BODY_PATH" \
          --comment-id-path "$comment_id_file" \
          --state-id "$WORKFLOW_REPORT_STATE_ID" \
          --managed-marker "''${WORKFLOW_REPORT_MANAGED_MARKER:-<!-- workflow-report:managed -->}"

        comment_id="$(cat "$comment_id_file")"
        if [ -n "$comment_id" ]; then
          ${gh} api \
            --method PATCH \
            "repos/$GH_REPO/issues/comments/$comment_id" \
            --field body=@"$WORKFLOW_REPORT_COMMENT_BODY_PATH" >/dev/null
        else
          ${gh} pr comment "$WORKFLOW_REPORT_PR_NUMBER" --body-file "$WORKFLOW_REPORT_COMMENT_BODY_PATH"
        fi
      '';
    };
  };
}
