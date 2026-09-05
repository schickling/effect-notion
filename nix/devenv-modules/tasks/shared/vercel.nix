# Vercel deploy tasks using local artifacts.
#
# The stable devenv task names remain here, but deploy semantics live in
# `ci-tools deploy vercel`.
{
  deployments ? [ ],
  buildTaskPrefix ? null,
  aliasSuffix ? null,
  ciToolsBin,
  vercelCliPkg ? null,
  vercelBin ? null,
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  root = ../../../..;
  resolvedCiToolsBin = ciToolsBin;
  defaultVercelCliPkg =
    if vercelCliPkg == null then
      import (root + "/nix/provider-clis/vercel-cli") { inherit pkgs; }
    else
      vercelCliPkg;
  resolvedVercelBin = if vercelBin == null then "${defaultVercelCliPkg}/bin/vercel" else vercelBin;
  hasDeployments = deployments != [ ];

  mkDeployTask =
    deployment:
    let
      name = deployment.name;
      isStatic = deployment ? staticDir;
      cwd = deployment.cwd or ".";
      artifactDir = if isStatic then deployment.staticDir else ".vercel/output";
      artifactKind = if isStatic then "static" else "prebuilt-output";
      afterTask = deployment.afterTask or null;
      buildDeps =
        if isStatic then
          (if afterTask == null then [ ] else [ afterTask ])
        else if buildTaskPrefix == null then
          [ ]
        else
          [ "${buildTaskPrefix}:${name}" ];
      projectIdEnv = deployment.projectIdEnv or "VERCEL_PROJECT_ID";
      orgIdEnv = deployment.orgIdEnv or "VERCEL_ORG_ID";
      teamIdEnv = deployment.teamIdEnv or null;
      scopeEnv = deployment.scopeEnv or null;
      protectionBypassEnv = deployment.protectionBypassEnv or null;
      aliasPrefix = deployment.aliasPrefix or null;
      productionDomains = deployment.productionDomains or [ ];
      urlEnvKey =
        deployment.urlEnvKey or "VERCEL_DEPLOY_URL_${
          lib.toUpper (builtins.replaceStrings [ "-" "." "/" ] [ "_" "_" "_" ] name)
        }";
      extraEnv = deployment.env or { };
    in
    {
      "vercel:deploy:${name}" = {
        description = "Deploy ${name} to Vercel";
        after = buildDeps;
        exec = trace.exec "vercel:deploy:${name}" ''
          set -euo pipefail

          input="''${DEVENV_TASK_INPUT:-"{}"}"
          deploy_type="$(${pkgs.jq}/bin/jq -r '.type // "preview"' <<<"$input")"
          url_env_key="$(${pkgs.jq}/bin/jq -r '.urlEnvKey // .url_env_key // ${builtins.toJSON urlEnvKey}' <<<"$input")"
          case "$deploy_type" in
            prod|pr|preview) ;;
            *)
              echo "Error: Unknown Vercel deploy type '$deploy_type'. Use: prod, pr, preview" >&2
              exit 1
              ;;
          esac

          args=(
            deploy vercel
            --target ${lib.escapeShellArg name}
            --display-name ${lib.escapeShellArg name}
            --artifact-dir ${lib.escapeShellArg artifactDir}
            --artifact-kind ${lib.escapeShellArg artifactKind}
            --mode "$deploy_type"
            --project-id-env ${lib.escapeShellArg projectIdEnv}
            --org-id-env ${lib.escapeShellArg orgIdEnv}
            --auth-token-env VERCEL_TOKEN
            --vercel-bin ${lib.escapeShellArg resolvedVercelBin}
          )

          if [ "$deploy_type" = "pr" ]; then
            pr_number="$(${pkgs.jq}/bin/jq -r '.pr // empty' <<<"$input")"
            if [ -z "$pr_number" ]; then
              echo "Error: PR deploy requires 'pr' input (e.g. --input pr=123)" >&2
              exit 1
            fi
            args+=(--pr "$pr_number")
          fi

          ${lib.optionalString (aliasSuffix != null) ''
            args+=(--alias-suffix ${lib.escapeShellArg aliasSuffix})
          ''}
          ${lib.optionalString (aliasPrefix != null) ''
            args+=(--alias-prefix ${lib.escapeShellArg aliasPrefix})
          ''}
          ${lib.concatStringsSep "\n          " (
            map (domain: "args+=(--production-domain ${lib.escapeShellArg domain})") productionDomains
          )}
          ${lib.optionalString (teamIdEnv != null) ''
            args+=(--team-id-env ${lib.escapeShellArg teamIdEnv})
          ''}
          ${lib.optionalString (scopeEnv != null) ''
            args+=(--scope-env ${lib.escapeShellArg scopeEnv})
          ''}
          ${lib.optionalString (protectionBypassEnv != null) ''
            args+=(--protection-bypass-env ${lib.escapeShellArg protectionBypassEnv})
          ''}
          ${
            if isStatic then
              ""
            else
              ''
                args+=(--build-prebuilt-output)
                args+=(--vercel-root-directory ${lib.escapeShellArg cwd})
                args+=(--build-env "LD_LIBRARY_PATH=${pkgs.stdenv.cc.cc.lib}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}")
                ${lib.concatStringsSep "\n                " (
                  lib.mapAttrsToList (k: v: "args+=(--build-env ${lib.escapeShellArg "${k}=${v}"})") extraEnv
                )}
              ''
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
        "vercel:deploy" = {
          description = "Deploy all configured targets to Vercel";
          exec = null;
          after =
            if hasDeployments then map (deployment: "vercel:deploy:${deployment.name}") deployments else [ ];
        };
      }
    ]
  );
}
