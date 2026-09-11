# Notion integration tests
#
# Runs live Notion integration tests for packages that exercise real API semantics.
# Requires each package's Notion token and scratch parent environment variables;
# skips gracefully when credentials are not available.
#
# Provides:
#   - test:notion-integration - Run all Notion integration tests
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  pnpmTaskHelpersScript = pkgs.writeText "pnpm-task-helpers.sh" (
    builtins.readFile ../shared/pnpm-task-helpers.sh
  );
  packages = [
    {
      path = "packages/@overeng/notion-effect-client";
      name = "notion-effect-client";
      tokenEnv = "NOTION_API_TOKEN";
      kind = "integration-config";
    }
    {
      path = "packages/@overeng/notion-cli";
      name = "notion-cli";
      tokenEnv = "NOTION_API_TOKEN";
      kind = "integration-config";
    }
    {
      path = "packages/@overeng/notion-datasource-sync";
      name = "notion-datasource-sync";
      tokenEnv = "NOTION_API_TOKEN";
      kind = "datasource-sync-live";
    }
    {
      path = "packages/@overeng/notion-md";
      name = "notion-md";
      tokenEnv = "NOTION_API_TOKEN";
      kind = "integration-config";
    }
    {
      path = "packages/@overeng/notion-react";
      name = "notion-react";
      tokenEnv = "NOTION_API_TOKEN";
      kind = "integration-config";
    }
  ];
  integrationVitestExec = tokenEnv: ''
    set -euo pipefail
    token_name=${lib.escapeShellArg tokenEnv}
    if [ -z "''${!token_name:-}" ]; then
      echo "$token_name not set, skipping integration tests"
      exit 0
    fi
    source ${lib.escapeShellArg pnpmTaskHelpersScript}
    run_package_bin vitest vitest run --config vitest.integration.config.ts
  '';
  datasourceSyncVitestExec = tokenEnv: ''
    set -euo pipefail
    token_name=${lib.escapeShellArg tokenEnv}
    if [ -z "''${!token_name:-}" ]; then
      echo "$token_name not set, skipping notion-datasource-sync live tests"
      exit 0
    fi

    if [ -z "''${NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID:-}" ]; then
      if [ -n "''${NOTION_TEST_PARENT_PAGE_ID:-}" ]; then
        export NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID="$NOTION_TEST_PARENT_PAGE_ID"
      else
        echo "NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID or NOTION_TEST_PARENT_PAGE_ID not set, skipping notion-datasource-sync live tests"
        exit 0
      fi
    fi

    export NOTION_DATASOURCE_SYNC_LIVE=1
    export NOTION_DATASOURCE_SYNC_LEDGER_PATH="''${NOTION_DATASOURCE_SYNC_LEDGER_PATH:-tmp/notion-datasource-sync-live/ci-''${GITHUB_RUN_ID:-local}-''${GITHUB_RUN_ATTEMPT:-0}.json}"

    source ${lib.escapeShellArg pnpmTaskHelpersScript}
    run_package_bin vitest vitest run \
      src/e2e/live-notion.e2e.test.ts \
      src/e2e/live-demo-replica.e2e.test.ts \
      --config vitest.config.ts
  '';
  vitestExec =
    pkg:
    if pkg.kind == "datasource-sync-live" then
      datasourceSyncVitestExec pkg.tokenEnv
    else
      integrationVitestExec pkg.tokenEnv;
  mkTestTask = pkg: {
    "test:notion-integration:${pkg.name}" = {
      description = "Run Notion integration tests for ${pkg.name}";
      exec = trace.exec "test:notion-integration:${pkg.name}" (vitestExec pkg);
      cwd = pkg.path;
      after = [ "pnpm:install" ];
    };
  };
in
{
  tasks = lib.mkMerge (
    (map mkTestTask packages)
    ++ [
      {
        "test:notion-integration" = {
          description = "Run all Notion integration tests";
          after = map (pkg: "test:notion-integration:${pkg.name}") packages;
        };
      }
    ]
  );
}
