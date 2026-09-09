# Pure loader for immutable Buck-produced JavaScript release assets.
#
# The tracked manifest is the only product-data authority. It embeds each
# canonical descriptor value and binds its payload digest to one deterministic
# immutable GitHub Release and asset. Evaluation validates the whole binding;
# realization fetches only the declared content-addressed module bytes.
{ pkgs }:

let
  lib = pkgs.lib;
  manifest = builtins.fromJSON (builtins.readFile ./manifest.json);
  repositoryReleaseBase = "https://github.com/overengineeringstudio/effect-utils/releases/download";
  expectedDescriptorKeys = [
    "externalCapabilities"
    "externalModules"
    "integrity"
    "modulePath"
    "platform"
    "productKind"
    "productName"
    "provenance"
    "runtimeContract"
    "runtimeContractVersion"
    "runtimeKind"
    "schema"
    "sizeBytes"
    "target"
  ];
  validRelativePath =
    path: builtins.match "[A-Za-z0-9][A-Za-z0-9._+-]*(/[A-Za-z0-9][A-Za-z0-9._+-]*)*" path != null;
  descriptorModuleSha256 =
    descriptor:
    builtins.convertHash {
      hash = descriptor.integrity;
      toHashFormat = "base16";
    };
  checkedProduct =
    entry:
    let
      descriptor = entry.descriptor;
      release = entry.release;
      productName = descriptor.productName;
      moduleSha256 = descriptorModuleSha256 descriptor;
      canonicalDescriptor = builtins.toJSON descriptor;
      derivedTag = "buck2-product-v2-${productName}-${moduleSha256}";
      derivedName = "${moduleSha256}-${descriptor.modulePath}";
      derivedUrl = "${repositoryReleaseBase}/${derivedTag}/${derivedName}";
      descriptorFile = builtins.toFile "${productName}-product.json" canonicalDescriptor;
    in
    assert lib.assertMsg (
      builtins.attrNames entry == [
        "descriptor"
        "descriptorSha256"
        "release"
      ]
    ) "buck2-products: ${productName} manifest product fields are not exact";
    assert lib.assertMsg (
      builtins.attrNames descriptor == expectedDescriptorKeys
    ) "buck2-products: ${productName} descriptor fields are not exact";
    assert lib.assertMsg (
      descriptor.schema == "effect-utils/javascript-product/v2"
    ) "buck2-products: ${productName} has an unsupported descriptor schema";
    assert lib.assertMsg (
      builtins.isString productName && builtins.match "[A-Za-z0-9][A-Za-z0-9._+-]*" productName != null
    ) "buck2-products: descriptor has an unsafe product name";
    assert lib.assertMsg (
      builtins.elem descriptor.productKind [
        "cli"
        "module"
      ]
    ) "buck2-products: ${productName} has an unsupported product kind";
    assert lib.assertMsg (builtins.elem descriptor.runtimeKind [
      "bun"
      "node"
    ]) "buck2-products: ${productName} has an unsupported JavaScript runtime";
    assert lib.assertMsg (
      descriptor.runtimeContract == "javascript-esm"
    ) "buck2-products: ${productName} has an unsupported runtime contract";
    assert lib.assertMsg (
      descriptor.runtimeContractVersion == "v1"
    ) "buck2-products: ${productName} has an unsupported runtime contract version";
    assert lib.assertMsg (
      descriptor.platform == {
        abi = "any";
        architecture = "any";
        os = "any";
      }
    ) "buck2-products: ${productName} is not platform-invariant";
    assert lib.assertMsg (
      validRelativePath descriptor.modulePath
    ) "buck2-products: ${productName} has an unsafe module path";
    assert lib.assertMsg (
      builtins.isList descriptor.externalCapabilities
      && builtins.all builtins.isString descriptor.externalCapabilities
    ) "buck2-products: ${productName} has invalid external capabilities";
    assert lib.assertMsg (
      builtins.isList descriptor.externalModules
      && builtins.all builtins.isString descriptor.externalModules
    ) "buck2-products: ${productName} has invalid external modules";
    assert lib.assertMsg (
      builtins.attrNames descriptor.provenance == [
        "configuredTarget"
        "dependencyClosureIdentity"
        "module"
      ]
      && builtins.all builtins.isString (builtins.attrValues descriptor.provenance)
    ) "buck2-products: ${productName} has invalid provenance";
    assert lib.assertMsg (
      builtins.isString descriptor.target
    ) "buck2-products: ${productName} has an invalid target";
    assert lib.assertMsg (
      builtins.isInt descriptor.sizeBytes && descriptor.sizeBytes > 0
    ) "buck2-products: ${productName} descriptor declares no payload size";
    assert lib.assertMsg (
      builtins.match "sha256-[A-Za-z0-9+/]{43}=" descriptor.integrity != null
    ) "buck2-products: ${productName} integrity must be an SRI SHA-256 digest";
    assert lib.assertMsg (
      builtins.match "[0-9a-f]{64}" entry.descriptorSha256 != null
    ) "buck2-products: ${productName} descriptorSha256 must be lowercase SHA-256 hex";
    assert lib.assertMsg (
      builtins.hashString "sha256" canonicalDescriptor == entry.descriptorSha256
    ) "buck2-products: ${productName} canonical descriptor digest mismatch";
    assert lib.assertMsg (
      builtins.attrNames release == [
        "hash"
        "name"
        "tag"
        "url"
      ]
    ) "buck2-products: ${productName} release fields are not exact";
    assert lib.assertMsg (
      release.tag == derivedTag
    ) "buck2-products: ${productName} release tag does not match its product and payload digest";
    assert lib.assertMsg (
      release.name == derivedName
    ) "buck2-products: ${productName} release asset name does not match its payload digest and module path";
    assert lib.assertMsg (
      release.url == derivedUrl
    ) "buck2-products: ${productName} release URL does not match its tag and asset name";
    assert lib.assertMsg (
      release.hash == descriptor.integrity
    ) "buck2-products: ${productName} release hash does not match descriptor integrity";
    {
      name = productName;
      value = {
        artifact = pkgs.fetchurl {
          name = release.name;
          inherit (release) url hash;
        };
        descriptor = descriptorFile;
        expectedDescriptorSha256 = entry.descriptorSha256;
        expectedModuleSha256 = moduleSha256;
        inherit release;
      };
    };
  checkedProducts = map checkedProduct manifest.products;
  productNames = map (entry: entry.name) checkedProducts;
  releaseTags = map (entry: entry.value.release.tag) checkedProducts;
  uniqueProductNames = lib.unique productNames;
  uniqueReleaseTags = lib.unique releaseTags;
in
assert lib.assertMsg (
  builtins.attrNames manifest == [
    "products"
    "schema"
  ]
) "buck2-products: manifest fields are not exact";
assert lib.assertMsg (
  manifest.schema == "effect-utils/buck2-release-products/v1"
) "buck2-products: unsupported manifest schema";
assert lib.assertMsg (
  builtins.isList manifest.products && manifest.products != [ ]
) "buck2-products: manifest products must be a non-empty list";
assert lib.assertMsg (
  builtins.length uniqueProductNames == builtins.length productNames
) "buck2-products: product names must be unique";
assert lib.assertMsg (
  builtins.length uniqueReleaseTags == builtins.length releaseTags
) "buck2-products: each product payload must have one unique release";
{
  inherit manifest;
  declaredProductNames = builtins.sort builtins.lessThan productNames;
  publishedProductNames = builtins.sort builtins.lessThan productNames;
  products = builtins.listToAttrs checkedProducts;
  fullyPublished = true;
}
