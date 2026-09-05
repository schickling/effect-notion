#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"

  if ! printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "FAIL: $label"
    echo "  expected to contain: $needle"
    echo "  actual output:"
    printf '%s\n' "$haystack" | sed 's/^/    /'
    exit 1
  fi
}

assert_json_field() {
  local expected="$1"
  local file="$2"
  local expression="$3"
  local label="$4"

  local actual
  actual="$(
    node -e "const fs = require('node:fs'); const value = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const out = (${expression})(value); process.stdout.write(String(out))" "$file"
  )"
  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    exit 1
  fi
}

extract_workflow_report_task_script() {
  local task_name="$1"
  local output_path="$2"

  nix-instantiate --eval --strict --json --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      pkgsForTest = pkgs // {
        gh = \"$tmpdir/fake-gh-pkg\";
      };
      evaluated = pkgs.lib.evalModules {
        modules = [
          ({ ... }: {
            options.tasks = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.processes = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.packages = pkgs.lib.mkOption { type = pkgs.lib.types.listOf pkgs.lib.types.anything; default = [ ]; };
          })
          ((import $ROOT/nix/devenv-modules/tasks/shared/workflow-report.nix {
            ciToolsBin = \"$tmpdir/ci-tools-wrapper\";
          }) {
            pkgs = pkgsForTest;
            lib = pkgs.lib;
            config = { };
          })
        ];
      };
    in evaluated.config.tasks.\"$task_name\".exec
  " | jq -r . > "$output_path"
  chmod +x "$output_path"
}

echo "Running workflow-report task E2E tests..."
echo ""

tmpdir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

mkdir -p "$tmpdir/fake-gh-pkg/bin"

cat > "$tmpdir/ci-tools-wrapper" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "\$@" >> "\${FAKE_CI_TOOLS_LOG:?}"
printf '\n' >> "\${FAKE_CI_TOOLS_LOG:?}"
exec "${CI_TOOLS_BIN:?}" "\$@"
EOF
chmod +x "$tmpdir/ci-tools-wrapper"

cat > "$tmpdir/fake-gh-pkg/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >> "${FAKE_GH_LOG:?}"
printf '\n' >> "${FAKE_GH_LOG:?}"

if [ "${1:-}" = "api" ] && [ "${2:-}" = "repos/overengineeringstudio/effect-utils/issues/123/comments" ]; then
  cat "${FAKE_GH_COMMENTS_JSON:?}"
  exit 0
fi

if [ "${1:-}" = "api" ] && [ "${2:-}" = "--method" ] && [ "${3:-}" = "PATCH" ]; then
  body_arg="${6:-}"
  body_file="${body_arg#body=@}"
  printf 'PATCH_BODY<<EOF\n%s\nEOF\n' "$(cat "$body_file")" >> "${FAKE_GH_LOG:?}"
  exit 0
fi

if [ "${1:-}" = "pr" ] && [ "${2:-}" = "comment" ]; then
  body_file="${5:-}"
  printf 'PR_COMMENT_BODY<<EOF\n%s\nEOF\n' "$(cat "$body_file")" >> "${FAKE_GH_LOG:?}"
  exit 0
fi

echo "unexpected fake gh invocation: $*" >&2
exit 1
EOF
chmod +x "$tmpdir/fake-gh-pkg/bin/gh"

extract_workflow_report_task_script "workflow-report:collect-bundle" "$tmpdir/collect.sh"
extract_workflow_report_task_script "workflow-report:render-comment-body" "$tmpdir/render.sh"
extract_workflow_report_task_script "workflow-report:publish" "$tmpdir/publish.sh"

record='{"_tag":"WorkflowReportRecord","schemaVersion":1,"id":"deploy-e2e","kind":"deploy-preview","subject":{"id":"web","label":"Web"},"status":"success","title":"Web preview deployed","summary":"Preview is ready","createdAtUtc":"2026-06-29T08:00:00Z","links":[{"label":"Preview","url":"https://example.test.invalid","primary":true}],"data":{"provider":"fake","target":"web"}}'
input_log="$tmpdir/input.log"
bundle_path="$tmpdir/bundle.json"
comment_body_path="$tmpdir/comment.md"
summary_path="$tmpdir/summary.md"
github_output="$tmpdir/github-output"
step_summary="$tmpdir/step-summary.md"
comments_json="$tmpdir/comments.json"
ci_tools_log="$tmpdir/ci-tools.log"
gh_log="$tmpdir/gh.log"

printf 'noise\nWORKFLOW_REPORT_V1: %s\n' "$record" > "$input_log"
printf '[]' > "$comments_json"
: > "$ci_tools_log"
: > "$gh_log"

echo "Test 1: collect-bundle task delegates to ci-tools"
(
  export FAKE_CI_TOOLS_LOG="$ci_tools_log"
  export WORKFLOW_REPORT_BUNDLE_ID="deploy-preview"
  export WORKFLOW_REPORT_INPUT_PATHS_JSON="[\"$input_log\"]"
  export WORKFLOW_REPORT_OUTPUT_PATH="$bundle_path"
  export WORKFLOW_REPORT_ALLOW_MISSING_INPUT="1"
  export WORKFLOW_REPORT_GITHUB_OUTPUT_NAME="bundle_path"
  export GITHUB_OUTPUT="$github_output"
  bash "$tmpdir/collect.sh"
)

assert_json_field "deploy-preview" "$bundle_path" "value => value.bundleId" "collect task should write bundle id"
assert_json_field "deploy-e2e" "$bundle_path" "value => value.records[0].id" "collect task should preserve record id"
assert_contains "$(cat "$ci_tools_log")" "workflow-report collect-bundle" "collect task should call ci-tools collect-bundle"
assert_contains "$(cat "$github_output")" "bundle_path=$bundle_path" "collect task should expose optional output path"

echo "Test 2: render-comment-body task owns PR comment lookup"
(
  export FAKE_CI_TOOLS_LOG="$ci_tools_log"
  export FAKE_GH_LOG="$gh_log"
  export FAKE_GH_COMMENTS_JSON="$comments_json"
  export GH_REPO="overengineeringstudio/effect-utils"
  export WORKFLOW_REPORT_EVENT_NAME="pull_request"
  export WORKFLOW_REPORT_PR_NUMBER="123"
  export WORKFLOW_REPORT_BUNDLE_PATH="$bundle_path"
  export WORKFLOW_REPORT_COMMENT_BODY_PATH="$comment_body_path"
  export WORKFLOW_REPORT_SUMMARY_PATH="$summary_path"
  export WORKFLOW_REPORT_TITLE="Deploy Preview"
  export WORKFLOW_REPORT_NO_RECORDS_MESSAGE="No deploy records."
  export WORKFLOW_REPORT_STATE_ID="deploy-preview"
  export WORKFLOW_REPORT_ENTRY_ID="commit-abc123"
  export WORKFLOW_REPORT_ENTRY_LABEL="PR 123"
  export WORKFLOW_REPORT_TIME_ZONE="Europe/Berlin"
  bash "$tmpdir/render.sh"
)

assert_contains "$(cat "$comment_body_path")" "Deploy Preview" "render task should write comment body"
assert_contains "$(cat "$summary_path")" "Web preview deployed" "render task should write summary"
assert_contains "$(cat "$gh_log")" "api repos/overengineeringstudio/effect-utils/issues/123/comments --paginate" "render task should query existing comments"
assert_contains "$(cat "$ci_tools_log")" "workflow-report render-comment-body" "render task should call ci-tools render-comment-body"

echo "Test 3: publish task appends summary and patches managed comment"
node -e "const fs = require('node:fs'); fs.writeFileSync(process.argv[2], JSON.stringify([{ id: 42, body: fs.readFileSync(process.argv[1], 'utf8') }]))" "$comment_body_path" "$comments_json"
(
  export FAKE_CI_TOOLS_LOG="$ci_tools_log"
  export FAKE_GH_LOG="$gh_log"
  export FAKE_GH_COMMENTS_JSON="$comments_json"
  export GH_REPO="overengineeringstudio/effect-utils"
  export WORKFLOW_REPORT_EVENT_NAME="pull_request"
  export WORKFLOW_REPORT_PR_NUMBER="123"
  export WORKFLOW_REPORT_HEAD_REPO="overengineeringstudio/effect-utils"
  export WORKFLOW_REPORT_COMMENT_BODY_PATH="$comment_body_path"
  export WORKFLOW_REPORT_SUMMARY_PATH="$summary_path"
  export WORKFLOW_REPORT_STATE_ID="deploy-preview"
  export GITHUB_STEP_SUMMARY="$step_summary"
  bash "$tmpdir/publish.sh"
)

assert_contains "$(cat "$step_summary")" "Web preview deployed" "publish task should append job summary"
assert_contains "$(cat "$ci_tools_log")" "workflow-report find-comment" "publish task should call ci-tools find-comment"
assert_contains "$(cat "$gh_log")" "--method PATCH repos/overengineeringstudio/effect-utils/issues/comments/42" "publish task should patch existing managed comment"
assert_contains "$(cat "$gh_log")" "PATCH_BODY" "publish task should send the rendered comment body"

echo ""
echo "Workflow-report task E2E tests passed."
