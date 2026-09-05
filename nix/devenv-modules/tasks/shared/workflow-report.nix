# Parameterized wrapper around the canonical report module.
{
  ciToolsBin,
}:
{ pkgs, ... }:
{
  imports = [ ./workflow-report-module.nix ];

  effectUtils.workflowReport.ciToolsBin = ciToolsBin;
  effectUtils.workflowReport.ghBin = "${pkgs.gh}/bin/gh";
}
