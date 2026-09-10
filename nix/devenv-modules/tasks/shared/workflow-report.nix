# Backward-compatible parameterized wrapper around the canonical report module.
#
# New modules should import `workflow-report-module.nix` directly. `ciToolsBin`
# is required because the canonical module has no source-build fallback.
{
  ciToolsBin,
}:
{ pkgs, ... }:
{
  imports = [ ./workflow-report-module.nix ];

  effectUtils.workflowReport.ciToolsBin = ciToolsBin;
  effectUtils.workflowReport.ghBin = "${pkgs.gh}/bin/gh";
}
