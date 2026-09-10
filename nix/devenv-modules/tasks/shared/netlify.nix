# Netlify deploy tasks for a single Netlify site.
#
# The stable devenv task names remain here, but deploy semantics live in
# `ci-tools deploy netlify`.
#
# `ciToolsBin` is required and must be an absolute path to the wrapped
# `ci-tools` Buck product; there is no source build and no ambient PATH
# fallback, so a consumer supplies it explicitly:
#
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.netlify {
#       siteName = "example";
#       ciToolsBin = "${inputs.effect-utils.packages.${pkgs.system}.ci-tools}/bin/ci-tools";
#     })
#   ];
{
  deployments ? [ ],
  siteName,
  siteId ? null,
  ciToolsBin,
  netlifyCliPkg ? null,
  netlifyBin ? null,
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  root = ../../../..;
  resolvedCiToolsBin = ciToolsBin;
  defaultNetlifyCliPkg =
    if netlifyCliPkg == null then
      import (root + "/nix/provider-clis/netlify-cli") { inherit pkgs; }
    else
      netlifyCliPkg;
  resolvedNetlifyBin =
    if netlifyBin == null then "${defaultNetlifyCliPkg}/bin/netlify" else netlifyBin;
  hasDeployments = deployments != [ ];

  mkDeployTask =
    deployment:
    let
      name = deployment.name;
      staticDir = deployment.staticDir;
      afterTask = deployment.afterTask or null;
      workspaceFilter = deployment.workspaceFilter or false;
      packageJsonPath = "${builtins.dirOf staticDir}/package.json";
      urlEnvKey =
        deployment.urlEnvKey or "NETLIFY_DEPLOY_URL_${
          lib.toUpper (builtins.replaceStrings [ "-" "." "/" ] [ "_" "_" "_" ] name)
        }";
    in
    {
      "netlify:deploy:${name}" = {
        description = "Deploy ${name} to Netlify";
        after = if afterTask == null then [ ] else [ afterTask ];
        exec = trace.exec "netlify:deploy:${name}" ''
          set -euo pipefail

          input="''${DEVENV_TASK_INPUT:-"{}"}"
          deploy_type="$(${pkgs.jq}/bin/jq -r '.type // "draft"' <<<"$input")"
          missing_auth_policy="$(${pkgs.jq}/bin/jq -r '.missingAuthPolicy // .missing_auth_policy // "fail"' <<<"$input")"
          unauthorized_policy="$(${pkgs.jq}/bin/jq -r '.unauthorizedPolicy // .unauthorized_policy // "fail"' <<<"$input")"
          url_env_key="$(${pkgs.jq}/bin/jq -r '.urlEnvKey // .url_env_key // ${builtins.toJSON urlEnvKey}' <<<"$input")"
          case "$deploy_type" in
            prod|pr|draft) ;;
            *)
              echo "Error: Unknown Netlify deploy type '$deploy_type'. Use: prod, pr, draft" >&2
              exit 1
              ;;
          esac
          case "$missing_auth_policy" in
            fail|skip) ;;
            *)
              echo "Error: Unknown Netlify missing auth policy '$missing_auth_policy'. Use: fail, skip" >&2
              exit 1
              ;;
          esac
          case "$unauthorized_policy" in
            fail|skip) ;;
            *)
              echo "Error: Unknown Netlify unauthorized policy '$unauthorized_policy'. Use: fail, skip" >&2
              exit 1
              ;;
          esac

          args=(
            deploy netlify
            --target ${lib.escapeShellArg name}
            --display-name ${lib.escapeShellArg name}
            --artifact-dir ${lib.escapeShellArg staticDir}
            --mode "$deploy_type"
            --site-name ${lib.escapeShellArg siteName}
            --site-id-env NETLIFY_SITE_ID
            --auth-token-env NETLIFY_AUTH_TOKEN
            --netlify-bin ${lib.escapeShellArg resolvedNetlifyBin}
            --missing-auth-policy "$missing_auth_policy"
            --unauthorized-policy "$unauthorized_policy"
          )

          if [ "$deploy_type" = "pr" ]; then
            pr_number="$(${pkgs.jq}/bin/jq -r '.pr // empty' <<<"$input")"
            if [ -z "$pr_number" ]; then
              echo "Error: PR deploy requires 'pr' input (e.g. --input pr=123)" >&2
              exit 1
            fi
            args+=(--pr "$pr_number")
          fi

          ${if siteId != null then "export NETLIFY_SITE_ID=${lib.escapeShellArg siteId}" else ""}

          ${
            if workspaceFilter then
              ''
                workspace_filter="$(${pkgs.jq}/bin/jq -r '.name // empty' ${lib.escapeShellArg packageJsonPath})"
                if [ -n "$workspace_filter" ]; then
                  args+=(--workspace-filter "$workspace_filter")
                fi
              ''
            else
              ""
          }

          if [ -n "''${WORKFLOW_REPORT_OUTPUT_FILE:-}" ]; then
            args+=(--workflow-report-output-file "$WORKFLOW_REPORT_OUTPUT_FILE")
          fi
          if [ -n "''${GITHUB_OUTPUT:-}" ]; then
            args+=(--github-output-file "$GITHUB_OUTPUT")
          fi
          if [ -n "''${GITHUB_ENV:-}" ]; then
            args+=(--github-env-file "$GITHUB_ENV")
          fi
          if [ -n "$url_env_key" ]; then
            args+=(--url-env-key "$url_env_key")
          fi

          ${lib.escapeShellArg resolvedCiToolsBin} "''${args[@]}"
        '';
      };
    };

in
{
  # The generated deploy workflow always collects and publishes the records
  # emitted by this task. Keep that dependency inside the reusable module so a
  # consumer cannot compose a deploy job with missing report tasks.
  imports = [ ./workflow-report-module.nix ];

  tasks = lib.mkMerge (
    (if hasDeployments then map mkDeployTask deployments else [ ])
    ++ [
      {
        "netlify:deploy" = {
          description = "Deploy all configured targets to Netlify";
          exec = null;
          after = if hasDeployments then map (d: "netlify:deploy:${d.name}") deployments else [ ];
        };
      }
    ]
  );
}
