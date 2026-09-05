# Netlify deploy tasks for a single Netlify site.
#
# The stable devenv task names remain here, but deploy semantics live in
# `ci-tools deploy netlify`.
#
# Each entry of `deployments` sets exactly one artifact source:
#   artifactLabel = "cell//path:target"  # Buck-owned: the declared output
#                                        # directory is resolved with
#                                        # `buck2 build --show-simple-output`
#   staticDir     = "path/in/source/tree" # legacy source-tree publication
# Both modes fail the task when the artifact directory cannot be resolved, so
# a missing build output can never reach `ci-tools` and be reported as a green
# skipped deploy. `workspaceFilter` needs a `package.json`: it is derived from
# `staticDir`'s parent, or given explicitly via `packageJsonPath` (required in
# Buck mode, where the artifact lives in buck-out rather than the package).
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

  # A deployment either names a literal `staticDir` (legacy consumers that
  # publish from the source tree) or a Buck `artifactLabel` whose declared
  # output directory is resolved at deploy time. Buck mode never copies build
  # output into the source tree and never lets an unresolvable output degrade
  # into a green "skipped" deploy.
  mkDeployTask =
    deployment:
    let
      name = deployment.name;
      staticDir = deployment.staticDir or null;
      artifactLabel = deployment.artifactLabel or null;
      afterTask = deployment.afterTask or null;
      workspaceFilter = deployment.workspaceFilter or false;
      packageJsonPath =
        deployment.packageJsonPath
          or (if staticDir == null then null else "${builtins.dirOf staticDir}/package.json");
      urlEnvKey =
        deployment.urlEnvKey or "NETLIFY_DEPLOY_URL_${
          lib.toUpper (builtins.replaceStrings [ "-" "." "/" ] [ "_" "_" "_" ] name)
        }";
      resolveArtifactDir =
        if artifactLabel == null then
          ''
            artifact_dir=${lib.escapeShellArg staticDir}
            if [ ! -d "$artifact_dir" ]; then
              echo "Error: ${name} artifact directory is missing: $artifact_dir" >&2
              exit 1
            fi
          ''
        else
          ''
            root="''${DEVENV_ROOT:-$PWD}"
            workspace_root="$(${pkgs.coreutils}/bin/realpath "$root/../..")"
            buck2_bin="$workspace_root/.megarepo/bin/buck2"
            if [ ! -x "$buck2_bin" ]; then
              echo "Error: no Buck binary at $buck2_bin; cannot resolve ${artifactLabel}" >&2
              exit 1
            fi
            # Buck prints the declared output path; the build is cached, so this
            # both re-proves and locates the artifact instead of guessing a path.
            artifact_output="$(
              cd "$workspace_root" \
                && "$buck2_bin" build --show-simple-output ${lib.escapeShellArg artifactLabel} \
                | ${pkgs.coreutils}/bin/tail -n 1
            )"
            if [ -z "$artifact_output" ]; then
              echo "Error: buck2 reported no output path for ${artifactLabel}" >&2
              exit 1
            fi
            case "$artifact_output" in
              /*) artifact_dir="$artifact_output" ;;
              *) artifact_dir="$workspace_root/$artifact_output" ;;
            esac
            if [ ! -d "$artifact_dir" ]; then
              echo "Error: Buck output for ${artifactLabel} is not a directory: $artifact_dir" >&2
              exit 1
            fi
          '';
    in
    assert lib.assertMsg (
      (staticDir == null) != (artifactLabel == null)
    ) "netlify.nix deployment '${name}' must set exactly one of staticDir or artifactLabel";
    assert lib.assertMsg (
      !workspaceFilter || packageJsonPath != null
    ) "netlify.nix deployment '${name}' sets workspaceFilter but no packageJsonPath could be derived";
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

          # Input validation precedes artifact resolution: an invalid request
          # must never trigger a build.
          pr_number=""
          if [ "$deploy_type" = "pr" ]; then
            pr_number="$(${pkgs.jq}/bin/jq -r '.pr // empty' <<<"$input")"
            if [ -z "$pr_number" ]; then
              echo "Error: PR deploy requires 'pr' input (e.g. --input pr=123)" >&2
              exit 1
            fi
          fi

          ${resolveArtifactDir}

          args=(
            deploy netlify
            --target ${lib.escapeShellArg name}
            --display-name ${lib.escapeShellArg name}
            --artifact-dir "$artifact_dir"
            --mode "$deploy_type"
            --site-name ${lib.escapeShellArg siteName}
            --site-id-env NETLIFY_SITE_ID
            --auth-token-env NETLIFY_AUTH_TOKEN
            --netlify-bin ${lib.escapeShellArg resolvedNetlifyBin}
            --missing-auth-policy "$missing_auth_policy"
            --unauthorized-policy "$unauthorized_policy"
          )

          if [ -n "$pr_number" ]; then
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
