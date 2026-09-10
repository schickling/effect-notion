# Bundle the CLIs downstream repos consume by name.
#
# The CLIs are wrapped Buck products, so `products` (the `products` attribute of
# `nix/buck2-products`) is a required argument: there is no source build to fall
# back to, and a caller that cannot supply the tracked products has no CLI.
{
  pkgs,
  products,
  typeProofCompilerBin,
  oxfmtPkg ? pkgs.oxfmt,
  gitRev ? "unknown",
  commitTs ? 0,
  dirty ? false,
}:
let
  candidates = import ./buck2-product-candidates.nix {
    inherit
      pkgs
      products
      typeProofCompilerBin
      oxfmtPkg
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
