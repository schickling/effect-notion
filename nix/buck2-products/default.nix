# Pure loader for the tracked Buck product artifacts.
#
# `products.json` (genie-generated from the product registry) says which
# products must exist; `manifest.json` (written by the publisher) binds each
# published product to content-addressed bytes tracked beside it. Nothing here
# invokes Buck: evaluation only reads tracked files, so `nix build` works in a
# pure flake checkout.
{ lib }:

let
  spec = builtins.fromJSON (builtins.readFile ./products.json);
  manifest = builtins.fromJSON (builtins.readFile ./manifest.json);
  specProductNames = builtins.sort builtins.lessThan (
    map (product: product.productName) spec.products
  );
  manifestProductNames = builtins.sort builtins.lessThan (builtins.attrNames manifest.products);
  specByName = builtins.listToAttrs (
    map (product: {
      name = product.productName;
      value = product;
    }) spec.products
  );

  checkedProduct =
    name:
    let
      entry = manifest.products.${name};
      declared = specByName.${name} or (throw "buck2-products: ${name} is not a declared product");
      artifactPath = ./. + "/${entry.artifact}";
      descriptorPath = ./. + "/${declared.descriptorPath}";
    in
    assert lib.assertMsg (
      builtins.attrNames entry == [
        "artifact"
        "descriptorSha256"
        "label"
        "moduleSha256"
      ]
    ) "buck2-products: ${name} manifest entry fields are not exact";
    assert lib.assertMsg (
      builtins.match "[0-9a-f]{64}" entry.moduleSha256 != null
    ) "buck2-products: ${name} moduleSha256 must be lowercase SHA-256 hex";
    assert lib.assertMsg (
      builtins.match "[0-9a-f]{64}" entry.descriptorSha256 != null
    ) "buck2-products: ${name} descriptorSha256 must be lowercase SHA-256 hex";
    assert lib.assertMsg (
      entry.artifact == "${name}/${entry.moduleSha256}-${declared.module}"
    ) "buck2-products: ${name} artifact is not content-addressed as <product>/<sha256>-<module>";
    assert lib.assertMsg (
      entry.label == declared.label
    ) "buck2-products: ${name} label does not match the declared Buck target";
    assert lib.assertMsg (builtins.pathExists artifactPath)
      "buck2-products: ${name} tracked artifact is missing";
    assert lib.assertMsg (builtins.pathExists descriptorPath)
      "buck2-products: ${name} tracked descriptor is missing";
    {
      artifact = artifactPath;
      descriptor = descriptorPath;
      expectedDescriptorSha256 = entry.descriptorSha256;
      expectedModuleSha256 = entry.moduleSha256;
    };
in
assert lib.assertMsg (
  spec.schema == "effect-utils/tracked-buck-products-spec/v1"
) "buck2-products: unsupported spec schema";
assert lib.assertMsg (
  manifest.schema == "effect-utils/tracked-buck-products/v1"
) "buck2-products: unsupported manifest schema";
assert lib.assertMsg (
  lib.subtractLists specProductNames manifestProductNames == [ ]
) "buck2-products: manifest publishes a product that is not declared in products.json";
{
  inherit spec manifest;
  declaredProductNames = specProductNames;
  publishedProductNames = manifestProductNames;
  # Published products only: a declared-but-unpublished product must not
  # silently resolve to stale or absent bytes.
  products = lib.genAttrs manifestProductNames checkedProduct;
  fullyPublished = specProductNames == manifestProductNames;
}
