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

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"

  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "FAIL: $label"
    echo "  expected not to contain: $needle"
    echo "  actual output:"
    printf '%s\n' "$haystack" | sed 's/^/    /'
    exit 1
  fi
}

assert_exit_code() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label"
    echo "  expected exit code: $expected"
    echo "  actual exit code:   $actual"
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
    node -e "const fs = require('node:fs'); const marker = 'WORKFLOW_REPORT_V1: '; const text = fs.readFileSync(process.argv[1], 'utf8').trim().split('\n').find((line) => line.trim().length > 0) ?? ''; const json = text.startsWith(marker) ? text.slice(marker.length) : text; const value = JSON.parse(json); const out = (${expression})(value); process.stdout.write(String(out))" "$file"
  )"
  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    exit 1
  fi
}

assert_deploy_modules_include_workflow_report_tasks() {
  local task_names

  task_names="$(
    nix-instantiate --eval --strict --json --expr "
      let
        flake = builtins.getFlake \"$NIX_FLAKE_REF\";
        pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
        evaluated = pkgs.lib.evalModules {
          modules = [
            ({ ... }: {
              config._module.args.pkgs = pkgs;
              options.tasks = pkgs.lib.mkOption {
                type = pkgs.lib.types.attrsOf pkgs.lib.types.anything;
                default = { };
              };
              options.processes = pkgs.lib.mkOption {
                type = pkgs.lib.types.attrsOf pkgs.lib.types.anything;
                default = { };
              };
              options.packages = pkgs.lib.mkOption {
                type = pkgs.lib.types.listOf pkgs.lib.types.anything;
                default = [ ];
              };
            })
            (import $ROOT/nix/devenv-modules/tasks/shared/netlify.nix {
              siteName = \"fake-site\";
              ciToolsBin = \"$tmpdir/ci-tools-wrapper\";
              netlifyBin = \"$tmpdir/fake-netlify-pkg/bin/netlify\";
            })
            (import $ROOT/nix/devenv-modules/tasks/shared/vercel.nix {
              ciToolsBin = \"$tmpdir/ci-tools-wrapper\";
              vercelBin = \"$tmpdir/fake-vercel\";
            })
          ];
        };
      in builtins.attrNames evaluated.config.tasks
    " | jq -r '.[]'
  )"

  assert_contains "$task_names" "netlify:deploy" "Netlify module should expose its aggregate task"
  assert_contains "$task_names" "vercel:deploy" "Vercel module should expose its aggregate task"
  assert_contains "$task_names" "workflow-report:collect-bundle" "Deploy modules should compose report collection"
  assert_contains "$task_names" "workflow-report:render-comment-body" "Deploy modules should compose report rendering"
  assert_contains "$task_names" "workflow-report:publish" "Deploy modules should compose report publication"
}

extract_netlify_task_script() {
  local static_dir="$1"
  local output_path="$2"

  nix-instantiate --eval --strict --json --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      evaluated = pkgs.lib.evalModules {
        modules = [
          ({ ... }: {
            options.tasks = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.processes = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.packages = pkgs.lib.mkOption { type = pkgs.lib.types.listOf pkgs.lib.types.anything; default = [ ]; };
          })
          ((import $ROOT/nix/devenv-modules/tasks/shared/netlify.nix {
            siteName = \"fake-site\";
            siteId = \"fake-site-id\";
            ciToolsBin = \"$tmpdir/ci-tools-wrapper\";
            netlifyBin = \"$tmpdir/fake-netlify-pkg/bin/netlify\";
            deployments = [
              {
                name = \"storybook\";
                staticDir = \"$static_dir\";
                afterTask = null;
              }
            ];
          }) {
            pkgs = pkgs;
            lib = pkgs.lib;
            config = { };
          })
        ];
      };
    in evaluated.config.tasks.\"netlify:deploy:storybook\".exec
  " | jq -r . > "$output_path"
  chmod +x "$output_path"
}

extract_netlify_buck_task_script() {
  local artifact_label="$1"
  local package_json_path="$2"
  local output_path="$3"

  nix-instantiate --eval --strict --json --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      evaluated = pkgs.lib.evalModules {
        modules = [
          ({ ... }: {
            options.tasks = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.processes = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.packages = pkgs.lib.mkOption { type = pkgs.lib.types.listOf pkgs.lib.types.anything; default = [ ]; };
          })
          ((import $ROOT/nix/devenv-modules/tasks/shared/netlify.nix {
            siteName = \"fake-site\";
            siteId = \"fake-site-id\";
            ciToolsBin = \"$tmpdir/ci-tools-wrapper\";
            netlifyBin = \"$tmpdir/fake-netlify-pkg/bin/netlify\";
            deployments = [
              {
                name = \"storybook\";
                artifactLabel = \"$artifact_label\";
                packageJsonPath = \"$package_json_path\";
                workspaceFilter = true;
                afterTask = null;
              }
            ];
          }) {
            pkgs = pkgs;
            lib = pkgs.lib;
            config = { };
          })
        ];
      };
    in evaluated.config.tasks.\"netlify:deploy:storybook\".exec
  " | jq -r . > "$output_path"
  chmod +x "$output_path"
}

extract_vercel_static_task_script() {
  local static_dir="$1"
  local output_path="$2"

  nix-instantiate --eval --strict --json --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      pkgsForTest = pkgs // {
        bun = \"$tmpdir/fake-bun-pkg\";
      };
      evaluated = pkgs.lib.evalModules {
        modules = [
          ({ ... }: {
            options.tasks = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.processes = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.packages = pkgs.lib.mkOption { type = pkgs.lib.types.listOf pkgs.lib.types.anything; default = [ ]; };
          })
          ((import $ROOT/nix/devenv-modules/tasks/shared/vercel.nix {
            aliasSuffix = \"team\";
            ciToolsBin = \"$tmpdir/ci-tools-wrapper\";
            vercelBin = \"$tmpdir/fake-vercel\";
            deployments = [
              {
                name = \"web\";
                staticDir = \"$static_dir\";
                projectIdEnv = \"VERCEL_PROJECT_ID_WEB\";
                scopeEnv = \"VERCEL_SCOPE_WEB\";
                aliasPrefix = \"web-preview\";
                productionDomains = [ \"app.example.com\" ];
                afterTask = null;
              }
            ];
          }) {
            pkgs = pkgsForTest;
            lib = pkgs.lib;
            config = { };
          })
        ];
      };
    in evaluated.config.tasks.\"vercel:deploy:web\".exec
  " | jq -r . > "$output_path"
  chmod +x "$output_path"
}

extract_vercel_build_task_script() {
  local output_path="$1"

  nix-instantiate --eval --strict --json --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      pkgsForTest = pkgs // {
        bun = \"$tmpdir/fake-bun-pkg\";
      };
      evaluated = pkgs.lib.evalModules {
        modules = [
          ({ ... }: {
            options.tasks = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.processes = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.packages = pkgs.lib.mkOption { type = pkgs.lib.types.listOf pkgs.lib.types.anything; default = [ ]; };
          })
          ((import $ROOT/nix/devenv-modules/tasks/shared/vercel.nix {
            aliasSuffix = \"team\";
            ciToolsBin = \"$tmpdir/ci-tools-wrapper\";
            vercelBin = \"$tmpdir/fake-vercel\";
            deployments = [
              {
                name = \"app\";
                cwd = \"app\";
                projectIdEnv = \"VERCEL_PROJECT_ID_APP\";
                scopeEnv = \"VERCEL_SCOPE_APP\";
                aliasPrefix = \"app-preview\";
                productionDomains = [ \"app.example.com\" ];
              }
            ];
          }) {
            pkgs = pkgsForTest;
            lib = pkgs.lib;
            config = { };
          })
        ];
      };
    in evaluated.config.tasks.\"vercel:deploy:app\".exec
  " | jq -r . > "$output_path"
  chmod +x "$output_path"
}

echo "Running deploy task E2E tests..."
echo ""

tmpdir="$(mktemp -d)"
api_pid=""
cleanup() {
  if [ -n "$api_pid" ]; then
    kill "$api_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmpdir"
}
trap cleanup EXIT

workspace="$tmpdir/workspace"
mkdir -p \
  "$workspace/storybook-static" \
  "$workspace/static" \
  "$workspace/app" \
  "$tmpdir/fake-netlify-pkg/bin" \
  "$tmpdir/fake-bun-pkg/bin"

echo "storybook marker" > "$workspace/storybook-static/index.html"
echo "vercel marker" > "$workspace/static/index.html"
echo '{"name":"fixture-app"}' > "$workspace/app/package.json"

# Buck-mode fixture: the deploy task resolves the declared output of a Buck
# label, so the artifact lives outside the package directory and the workspace
# root must expose `.megarepo/bin/buck2`.
buck_workspace="$tmpdir/buck-workspace"
buck_repo_root="$buck_workspace/repos/effect-utils"
buck_package_dir="$buck_repo_root/packages/@overeng/effect-react"
buck_artifact_dir="$buck_workspace/buck-out/gen/storybook-static"
mkdir -p \
  "$buck_workspace/.megarepo/bin" \
  "$buck_package_dir" \
  "$buck_artifact_dir"
echo '{"name":"@overeng/effect-react"}' > "$buck_package_dir/package.json"
echo "buck storybook marker" > "$buck_artifact_dir/index.html"

cat > "$buck_workspace/.megarepo/bin/buck2" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'cwd=%s args=%s\n' "$PWD" "$*" >> "${FAKE_BUCK2_LOG:?}"

case "${FAKE_BUCK2_MODE:-ok}" in
  ok) echo "buck-out/gen/storybook-static" ;;
  empty) ;;
  missing) echo "buck-out/gen/absent-storybook-static" ;;
  *)
    echo "unexpected fake buck2 mode: ${FAKE_BUCK2_MODE:-}" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$buck_workspace/.megarepo/bin/buck2"

cat > "$tmpdir/fake-api.mjs" <<'EOF'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'

const portFile = process.argv[2]
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  response.setHeader('content-type', 'application/json')

  if (url.pathname === '/api/v1/sites/fake-site-id') {
    response.end(JSON.stringify({ name: 'fake-site', account_slug: 'fake-account' }))
    return
  }

  if (url.pathname === '/v9/projects/fake-project') {
    response.end(JSON.stringify({ id: 'fake-project', name: 'fake-project' }))
    return
  }

  response.statusCode = 404
  response.end(JSON.stringify({ error: { message: `Unhandled fake API route: ${url.pathname}` } }))
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Fake API did not bind to a TCP port')
  }
  writeFileSync(portFile, `${address.port}\n`)
})
EOF

node "$tmpdir/fake-api.mjs" "$tmpdir/api-port" &
api_pid=$!
for _ in $(seq 1 100); do
  if [ -s "$tmpdir/api-port" ]; then
    break
  fi
  sleep 0.05
done
if [ ! -s "$tmpdir/api-port" ]; then
  echo "FAIL: fake API did not start"
  exit 1
fi
export FAKE_API_BASE_URL="http://127.0.0.1:$(cat "$tmpdir/api-port")"

cat > "$tmpdir/fake-netlify-pkg/bin/netlify" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${FAKE_NETLIFY_LOG:?}"

if [ "${1:-}" = "deploy" ]; then
  printf '{"deploy_id":"deploy123","site_name":"fake-site","deploy_url":"https://deploy123--fake-site.netlify.app"}\n'
  exit 0
fi

echo "unexpected fake netlify invocation: $*" >&2
exit 1
EOF
chmod +x "$tmpdir/fake-netlify-pkg/bin/netlify"

cat > "$tmpdir/fake-bun-pkg/bin/bunx" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'cwd=%s args=%s\n' "$PWD" "$*" >> "${FAKE_BUNX_LOG:?}"

if [ "${1:-}" = "vercel" ] && [ "${2:-}" = "pull" ]; then
  mkdir -p .vercel
  printf '{"settings":{}}\n' > .vercel/project.json
  exit 0
fi

if [ "${1:-}" = "vercel" ] && [ "${2:-}" = "build" ]; then
  mkdir -p .vercel/output/static
  printf '{"version":3}\n' > .vercel/output/config.json
  printf 'built marker\n' > .vercel/output/static/index.html
  exit 0
fi

if [ "${1:-}" = "vercel" ] && [ "${2:-}" = "deploy" ]; then
  if [ -f .vercel/output/static/index.html ]; then
    printf 'https://deploy-web.vercel.app\n'
    exit 0
  fi
  echo "missing fake prebuilt output" >&2
  exit 1
fi

if [ "${1:-}" = "vercel" ] && [ "${2:-}" = "alias" ]; then
  printf 'Aliased %s to %s\n' "${3:-}" "${4:-}"
  exit 0
fi

echo "unexpected fake bunx invocation: $*" >&2
exit 1
EOF
chmod +x "$tmpdir/fake-bun-pkg/bin/bunx"

cat > "$tmpdir/fake-vercel" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'cwd=%s args=vercel %s\n' "$PWD" "$*" >> "${FAKE_BUNX_LOG:?}"

if [ "${1:-}" = "pull" ]; then
  mkdir -p .vercel
  printf '{"settings":{}}\n' > .vercel/project.json
  exit 0
fi

if [ "${1:-}" = "build" ]; then
  grep -q '"installCommand":"true"' app/vercel.json
  grep -q '"rootDirectory":"app"' .vercel/project.json
  mkdir -p .vercel/output/static
  printf '{"version":3}\n' > .vercel/output/config.json
  printf 'built marker\n' > .vercel/output/static/index.html
  exit 0
fi

if [ "${1:-}" = "deploy" ]; then
  if [ -f .vercel/output/static/index.html ]; then
    printf 'https://deploy-web.vercel.app\n'
    exit 0
  fi
  echo "missing fake prebuilt output" >&2
  exit 1
fi

if [ "${1:-}" = "alias" ]; then
  printf 'Aliased %s to %s\n' "${2:-}" "${3:-}"
  exit 0
fi

echo "unexpected fake vercel invocation: $*" >&2
exit 1
EOF
chmod +x "$tmpdir/fake-vercel"

cat > "$tmpdir/ci-tools-wrapper" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "\$@" >> "\${FAKE_CI_TOOLS_LOG:?}"
printf '\n' >> "\${FAKE_CI_TOOLS_LOG:?}"

case "\${1:-}:\${2:-}" in
  deploy:netlify)
    exec "${CI_TOOLS_BIN:?}" "\$@" --netlify-api-base-url "\${FAKE_API_BASE_URL:?}"
    ;;
  deploy:vercel)
    exec "${CI_TOOLS_BIN:?}" "\$@" --vercel-api-base-url "\${FAKE_API_BASE_URL:?}"
    ;;
  *)
    echo "unexpected ci-tools wrapper invocation: \$*" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$tmpdir/ci-tools-wrapper"

echo "Test 0: deploy modules compose their workflow-report task dependency"
assert_deploy_modules_include_workflow_report_tasks

extract_netlify_task_script "$workspace/storybook-static" "$tmpdir/netlify-deploy.sh"
extract_vercel_static_task_script "$workspace/static" "$tmpdir/vercel-static-deploy.sh"
extract_vercel_build_task_script "$tmpdir/vercel-build-deploy.sh"

echo "Test 1: Netlify PR task delegates to ci-tools and preserves outputs"
netlify_output_file="$tmpdir/netlify-task-output.json"
netlify_report_file="$tmpdir/netlify-report.jsonl"
netlify_github_output="$tmpdir/netlify-github-output"
netlify_github_env="$tmpdir/netlify-github-env"
netlify_output="$(
  cd "$workspace"
  export FAKE_CI_TOOLS_LOG="$tmpdir/netlify-ci-tools.log"
  export FAKE_NETLIFY_LOG="$tmpdir/netlify.log"
  export NETLIFY_AUTH_TOKEN="fake-token"
  export DEVENV_TASK_INPUT='{"type":"pr","pr":42,"missingAuthPolicy":"skip","urlEnvKey":"STORYBOOK_URL"}'
  export DEVENV_TASK_OUTPUT_FILE="$netlify_output_file"
  export WORKFLOW_REPORT_OUTPUT_FILE="$netlify_report_file"
  export GITHUB_OUTPUT="$netlify_github_output"
  export GITHUB_ENV="$netlify_github_env"
  bash "$tmpdir/netlify-deploy.sh" 2>&1
)"

netlify_args="$(cat "$tmpdir/netlify-ci-tools.log")"
assert_contains "$netlify_output" "Netlify deploy URL: https://storybook-pr-42--fake-site.netlify.app" "Netlify wrapper should surface ci-tools output"
assert_contains "$netlify_args" "deploy netlify" "Netlify wrapper should call ci-tools deploy netlify"
assert_contains "$netlify_args" "--target storybook" "Netlify wrapper should preserve target"
assert_contains "$netlify_args" "--mode pr" "Netlify wrapper should pass PR mode"
assert_contains "$netlify_args" "--pr 42" "Netlify wrapper should pass PR number"
assert_contains "$netlify_args" "--site-name fake-site" "Netlify wrapper should pass site name"
assert_contains "$netlify_args" "--site-id-env NETLIFY_SITE_ID" "Netlify wrapper should pass site id env name"
assert_contains "$netlify_args" "--missing-auth-policy skip" "Netlify wrapper should pass missing-auth policy"
assert_contains "$netlify_args" "--workflow-report-output-file $netlify_report_file" "Netlify wrapper should pass report path"
assert_contains "$netlify_args" "--github-output-file $netlify_github_output" "Netlify wrapper should pass GitHub output path"
assert_contains "$netlify_args" "--url-env-key STORYBOOK_URL" "Netlify wrapper should pass URL env key"
assert_contains "$netlify_args" "--github-env-file $netlify_github_env" "Netlify wrapper should pass GitHub env path"
assert_json_field "https://storybook-pr-42--fake-site.netlify.app/" "$netlify_output_file" "value => value.devenv.env.NETLIFY_DEPLOY_URL_STORYBOOK" "Netlify task output should be delegated through ci-tools"
assert_json_field "netlify" "$netlify_report_file" "value => value.data.provider" "Netlify report record should be delegated through ci-tools"
assert_contains "$(cat "$netlify_github_output")" "workflow_report_path=$netlify_report_file" "Netlify GitHub outputs should include report path from ci-tools"
assert_contains "$(cat "$netlify_github_env")" "STORYBOOK_URL=https://storybook-pr-42--fake-site.netlify.app/" "Netlify wrapper should let ci-tools write the deploy URL env var"

echo "Test 2: Netlify PR task without PR input fails before ci-tools"
set +e
netlify_missing_pr_output="$(
  cd "$workspace"
  : > "$tmpdir/netlify-missing-pr.log"
  export FAKE_CI_TOOLS_LOG="$tmpdir/netlify-missing-pr.log"
  export FAKE_NETLIFY_LOG="$tmpdir/netlify-missing-pr-provider.log"
  export NETLIFY_AUTH_TOKEN="fake-token"
  export DEVENV_TASK_INPUT='{"type":"pr"}'
  bash "$tmpdir/netlify-deploy.sh" 2>&1
)"
netlify_missing_pr_status=$?
set -e

assert_exit_code 1 "$netlify_missing_pr_status" "Netlify missing PR input should fail"
assert_contains "$netlify_missing_pr_output" "Error: PR deploy requires 'pr' input" "Netlify missing PR input should explain required field"
if [ -s "$tmpdir/netlify-missing-pr.log" ]; then
  echo "FAIL: Netlify missing PR input should not call ci-tools"
  exit 1
fi

echo "Test 2a: Netlify Buck task deploys the output resolved from the Buck label"
extract_netlify_buck_task_script \
  "effect_utils//packages/@overeng/effect-react:storybook_build_candidate" \
  "packages/@overeng/effect-react/package.json" \
  "$tmpdir/netlify-buck-deploy.sh"

netlify_buck_report_file="$tmpdir/netlify-buck-report.jsonl"
netlify_buck_output="$(
  cd "$buck_repo_root"
  export DEVENV_ROOT="$buck_repo_root"
  export FAKE_CI_TOOLS_LOG="$tmpdir/netlify-buck-ci-tools.log"
  export FAKE_NETLIFY_LOG="$tmpdir/netlify-buck-provider.log"
  export FAKE_BUCK2_LOG="$tmpdir/netlify-buck2.log"
  export NETLIFY_AUTH_TOKEN="fake-token"
  export DEVENV_TASK_INPUT='{"type":"pr","pr":7}'
  export WORKFLOW_REPORT_OUTPUT_FILE="$netlify_buck_report_file"
  bash "$tmpdir/netlify-buck-deploy.sh" 2>&1
)"

netlify_buck_args="$(cat "$tmpdir/netlify-buck-ci-tools.log")"
assert_contains "$(cat "$tmpdir/netlify-buck2.log")" "args=build --show-simple-output effect_utils//packages/@overeng/effect-react:storybook_build_candidate" "Buck-mode deploy should resolve the declared storybook output"
assert_contains "$netlify_buck_args" "--artifact-dir $buck_artifact_dir" "Buck-mode deploy should publish the resolved Buck output directory"
assert_not_contains "$netlify_buck_args" "packages/@overeng/effect-react/storybook-static" "Buck-mode deploy should never publish a source-tree storybook-static path"
assert_contains "$netlify_buck_args" "--workspace-filter @overeng/effect-react" "Buck-mode deploy should read the workspace filter from the declared package.json"
assert_contains "$netlify_buck_output" "Netlify deploy URL: https://storybook-pr-7--fake-site.netlify.app" "Buck-mode deploy should surface the ci-tools deploy URL"
assert_json_field "netlify" "$netlify_buck_report_file" "value => value.data.provider" "Buck-mode deploy should emit the delegated workflow report record"

echo "Test 2b: Netlify Buck task fails closed when Buck reports no output path"
set +e
netlify_buck_empty_output="$(
  cd "$buck_repo_root"
  : > "$tmpdir/netlify-buck-empty-ci-tools.log"
  export DEVENV_ROOT="$buck_repo_root"
  export FAKE_CI_TOOLS_LOG="$tmpdir/netlify-buck-empty-ci-tools.log"
  export FAKE_BUCK2_LOG="$tmpdir/netlify-buck2-empty.log"
  export FAKE_BUCK2_MODE="empty"
  export NETLIFY_AUTH_TOKEN="fake-token"
  export DEVENV_TASK_INPUT='{"type":"draft"}'
  bash "$tmpdir/netlify-buck-deploy.sh" 2>&1
)"
netlify_buck_empty_status=$?
set -e

assert_exit_code 1 "$netlify_buck_empty_status" "Unresolvable Buck output should fail the deploy task"
assert_contains "$netlify_buck_empty_output" "buck2 reported no output path" "Unresolvable Buck output should explain the failure"
if [ -s "$tmpdir/netlify-buck-empty-ci-tools.log" ]; then
  echo "FAIL: Unresolvable Buck output should not reach ci-tools"
  exit 1
fi

echo "Test 2c: Netlify Buck task fails closed when the resolved output is missing"
set +e
netlify_buck_missing_output="$(
  cd "$buck_repo_root"
  : > "$tmpdir/netlify-buck-missing-ci-tools.log"
  export DEVENV_ROOT="$buck_repo_root"
  export FAKE_CI_TOOLS_LOG="$tmpdir/netlify-buck-missing-ci-tools.log"
  export FAKE_BUCK2_LOG="$tmpdir/netlify-buck2-missing.log"
  export FAKE_BUCK2_MODE="missing"
  export NETLIFY_AUTH_TOKEN="fake-token"
  export DEVENV_TASK_INPUT='{"type":"draft"}'
  bash "$tmpdir/netlify-buck-deploy.sh" 2>&1
)"
netlify_buck_missing_status=$?
set -e

assert_exit_code 1 "$netlify_buck_missing_status" "A missing Buck output directory should fail instead of skipping"
assert_contains "$netlify_buck_missing_output" "is not a directory" "A missing Buck output should explain the failure"
if [ -s "$tmpdir/netlify-buck-missing-ci-tools.log" ]; then
  echo "FAIL: A missing Buck output should not reach ci-tools and be reported as skipped"
  exit 1
fi

echo "Test 2d: Netlify Buck task rejects invalid input before building"
set +e
netlify_buck_no_pr_output="$(
  cd "$buck_repo_root"
  : > "$tmpdir/netlify-buck-no-pr-buck2.log"
  export DEVENV_ROOT="$buck_repo_root"
  export FAKE_CI_TOOLS_LOG="$tmpdir/netlify-buck-no-pr-ci-tools.log"
  export FAKE_BUCK2_LOG="$tmpdir/netlify-buck-no-pr-buck2.log"
  export NETLIFY_AUTH_TOKEN="fake-token"
  export DEVENV_TASK_INPUT='{"type":"pr"}'
  bash "$tmpdir/netlify-buck-deploy.sh" 2>&1
)"
netlify_buck_no_pr_status=$?
set -e

assert_exit_code 1 "$netlify_buck_no_pr_status" "Buck-mode deploy without a PR number should fail"
assert_contains "$netlify_buck_no_pr_output" "Error: PR deploy requires 'pr' input" "Buck-mode deploy should validate input"
if [ -s "$tmpdir/netlify-buck-no-pr-buck2.log" ]; then
  echo "FAIL: Invalid deploy input should not trigger a Buck build"
  exit 1
fi

echo "Test 3: Vercel static PR task delegates alias and static artifact config"
vercel_output_file="$tmpdir/vercel-task-output.json"
vercel_report_file="$tmpdir/vercel-report.jsonl"
vercel_github_output="$tmpdir/vercel-github-output"
vercel_github_env="$tmpdir/vercel-github-env"
vercel_output="$(
  cd "$workspace"
  export FAKE_CI_TOOLS_LOG="$tmpdir/vercel-static-ci-tools.log"
  export FAKE_BUNX_LOG="$tmpdir/static-bunx.log"
  export VERCEL_TOKEN="fake-token"
  export VERCEL_ORG_ID="fake-org"
  export VERCEL_PROJECT_ID_WEB="fake-project"
  export VERCEL_SCOPE_WEB="fake-scope"
  export DEVENV_TASK_INPUT='{"type":"pr","pr":123}'
  export DEVENV_TASK_OUTPUT_FILE="$vercel_output_file"
  export WORKFLOW_REPORT_OUTPUT_FILE="$vercel_report_file"
  export GITHUB_OUTPUT="$vercel_github_output"
  export GITHUB_ENV="$vercel_github_env"
  bash "$tmpdir/vercel-static-deploy.sh" 2>&1
)"

vercel_static_args="$(cat "$tmpdir/vercel-static-ci-tools.log")"
assert_contains "$vercel_output" "Vercel deploy URL: https://web-preview-pr-123-team.vercel.app" "Vercel static wrapper should surface ci-tools output"
assert_contains "$vercel_static_args" "deploy vercel" "Vercel static wrapper should call ci-tools deploy vercel"
assert_contains "$vercel_static_args" "--target web" "Vercel static wrapper should keep record target"
assert_contains "$vercel_static_args" "--alias-prefix web-preview" "Vercel static wrapper should preserve alias prefix"
assert_contains "$vercel_static_args" "--alias-suffix team" "Vercel static wrapper should preserve alias suffix"
assert_contains "$vercel_static_args" "--artifact-kind static" "Vercel static wrapper should pass static artifact kind"
assert_contains "$vercel_static_args" "--project-id-env VERCEL_PROJECT_ID_WEB" "Vercel static wrapper should pass project id env"
assert_contains "$vercel_static_args" "--scope-env VERCEL_SCOPE_WEB" "Vercel static wrapper should pass scope env"
assert_contains "$vercel_static_args" "--github-output-file $vercel_github_output" "Vercel static wrapper should pass GitHub output path"
assert_contains "$vercel_static_args" "--url-env-key VERCEL_DEPLOY_URL_WEB" "Vercel static wrapper should pass default URL env key"
assert_contains "$vercel_static_args" "--github-env-file $vercel_github_env" "Vercel static wrapper should pass GitHub env path"
assert_contains "$vercel_static_args" "--production-domain app.example.com" "Vercel static wrapper should pass production domains"
assert_json_field "https://web-preview-pr-123-team.vercel.app/" "$vercel_output_file" "value => value.devenv.env.VERCEL_DEPLOY_URL_WEB" "Vercel task output should be delegated through ci-tools"
assert_json_field "vercel" "$vercel_report_file" "value => value.data.provider" "Vercel report record should be delegated through ci-tools"
assert_contains "$(cat "$vercel_github_output")" "workflow_report_path=$vercel_report_file" "Vercel GitHub outputs should include report path from ci-tools"
assert_contains "$(cat "$vercel_github_env")" "VERCEL_DEPLOY_URL_WEB=https://web-preview-pr-123-team.vercel.app/" "Vercel static wrapper should let ci-tools write the deploy URL env var"

echo "Test 4: Vercel static task delegates missing auth to ci-tools reporting"
vercel_missing_auth_report_file="$tmpdir/vercel-missing-auth-report.jsonl"
set +e
vercel_missing_auth_output="$(
  cd "$workspace"
  export FAKE_CI_TOOLS_LOG="$tmpdir/vercel-missing-auth-ci-tools.log"
  export FAKE_BUNX_LOG="$tmpdir/static-missing-auth-bunx.log"
  unset VERCEL_TOKEN
  export VERCEL_ORG_ID="fake-org"
  export VERCEL_PROJECT_ID_WEB="fake-project"
  export VERCEL_SCOPE_WEB="fake-scope"
  export DEVENV_TASK_INPUT='{"type":"preview"}'
  export WORKFLOW_REPORT_OUTPUT_FILE="$vercel_missing_auth_report_file"
  bash "$tmpdir/vercel-static-deploy.sh" 2>&1
)"
vercel_missing_auth_status=$?
set -e

assert_exit_code 1 "$vercel_missing_auth_status" "Vercel missing auth should fail through ci-tools"
assert_contains "$(cat "$tmpdir/vercel-missing-auth-ci-tools.log")" "--workflow-report-output-file $vercel_missing_auth_report_file" "Vercel missing auth should still call ci-tools with report path"
assert_json_field "MissingAuth" "$vercel_missing_auth_report_file" "value => value.data.errorKind" "Vercel missing auth should emit typed workflow report"

echo "Test 5: Vercel build-mode task builds locally then delegates prebuilt output"
build_output="$(
  cd "$workspace"
  export FAKE_BUNX_LOG="$tmpdir/build-bunx.log"
  export FAKE_CI_TOOLS_LOG="$tmpdir/vercel-build-ci-tools.log"
  export VERCEL_TOKEN="fake-token"
  export VERCEL_ORG_ID="fake-org"
  export VERCEL_PROJECT_ID_APP="fake-project"
  export VERCEL_SCOPE_APP="fake-scope"
  export DEVENV_TASK_INPUT='{"type":"prod"}'
  unset DEVENV_TASK_OUTPUT_FILE
  bash "$tmpdir/vercel-build-deploy.sh" 2>&1
)"

build_bunx_args="$(cat "$tmpdir/build-bunx.log")"
build_ci_tools_args="$(cat "$tmpdir/vercel-build-ci-tools.log")"
assert_contains "$build_output" "Pulling Vercel project settings and env for app (production)..." "Vercel build wrapper should keep local pull/build phase"
assert_contains "$build_bunx_args" "args=vercel pull --yes --environment production --scope fake-scope --token fake-token" "Vercel build wrapper should pull production env in the configured scope"
assert_contains "$build_bunx_args" "args=vercel build --yes --prod --scope fake-scope --token fake-token" "Vercel build wrapper should build prod locally in the configured scope"
assert_contains "$build_ci_tools_args" "--target app" "Vercel build wrapper should keep record target"
assert_contains "$build_ci_tools_args" "--alias-prefix app-preview" "Vercel build wrapper should preserve build-mode alias prefix"
assert_contains "$build_ci_tools_args" "--artifact-kind prebuilt-output" "Vercel build wrapper should pass prebuilt output kind"
assert_contains "$build_ci_tools_args" "--artifact-dir .vercel/output" "Vercel build wrapper should pass local Vercel output"
assert_contains "$build_ci_tools_args" "--build-prebuilt-output" "Vercel build wrapper should delegate local build mode to ci-tools"
assert_contains "$build_ci_tools_args" "--vercel-root-directory app" "Vercel build wrapper should pass Vercel root directory to ci-tools"
assert_contains "$build_ci_tools_args" "--build-env LD_LIBRARY_PATH=" "Vercel build wrapper should pass native library build env to ci-tools"
assert_not_contains "$build_output" "Error:" "Vercel build wrapper should not surface shell-owned build errors"
if [ -e "$workspace/.vercel" ]; then
  echo "Assertion failed: Vercel build wrapper should let ci-tools clean local .vercel state" >&2
  exit 1
fi

echo ""
echo "Deploy task E2E tests passed."
