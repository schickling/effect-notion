{
  repo,
  ruleset,
  # Packaged module exporting reconcileGithubRuleset and
  # formatGithubRulesetReport. Source-tree imports are intentionally unsupported.
  runtimeModule,
  ghPkg,
  file ? ".github/repo-settings.json",
  taskPrefix ? "gh",
  after ? [ "genie:run" ],
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  githubRulesetModule = toString runtimeModule;
  mkTask =
    mode:
    let
      verb = if mode == "apply" then "Apply" else "Check";
      taskName = "${taskPrefix}:${mode}-settings";
      exitOnDrift = if mode == "check" then "if (report.changed) process.exit(1)" else "";
    in
    {
      "${taskName}" = {
        inherit after;
        description = "${verb} ${file} ${
          if mode == "apply" then "to" else "against"
        } the live GitHub ruleset";
        exec = trace.exec taskName ''
          set -euo pipefail
          export PATH=${lib.makeBinPath [ ghPkg ]}
          ${pkgs.bun}/bin/bun --eval ${lib.escapeShellArg ''
            import {
              formatGithubRulesetReport,
              reconcileGithubRuleset,
            } from '${githubRulesetModule}'

            const report = await reconcileGithubRuleset({
              mode: ${builtins.toJSON mode},
              options: {
                repo: ${builtins.toJSON repo},
                ruleset: ${builtins.toJSON ruleset},
                file: ${builtins.toJSON file},
              },
            })
            console.log(formatGithubRulesetReport({
              mode: ${builtins.toJSON mode},
              report,
            }))
            ${exitOnDrift}
          ''}
        '';
      };
    };
in
{
  tasks = lib.mkMerge [
    (mkTask "apply")
    (mkTask "check")
  ];
}
