{
  pkgs,
  products,
  gitRev ? "unknown",
  commitTs ? 0,
  workspaceRoot ? ./.,
  dirty ? false,
  typeProofCompilerBin,
}:
let
  candidates = import ./buck2-product-candidates.nix {
    inherit
      pkgs
      products
      typeProofCompilerBin
      gitRev
      commitTs
      dirty
      ;
  };
in
{
  inherit (candidates)
    ci-tools
    genie
    genie-bootstrap-closure-check
    megarepo
    ;
}
