{ pkgs }:

let
  lib = pkgs.lib;
  contract = import ../workspace-tools/lib/buck2-build-product-contract.nix;
  importArtifact = import ../workspace-tools/lib/buck2-artifact-import.nix { inherit pkgs; };
  manifest = builtins.fromJSON (builtins.readFile ./manifest.json);
  targets = builtins.fromJSON (builtins.readFile ./targets.json);
  repositoryReleaseBase = "https://github.com/overengineeringstudio/effect-utils/releases/download";
  ensure = condition: message: if condition then true else throw "buck2-native-products: ${message}";
  platformKey = platform: "${platform.architecture}-${platform.os}-${platform.abi}";
  targetByName = builtins.listToAttrs (
    map (product: {
      inherit (product) name;
      value = product.target;
    }) targets.products
  );
  expectedKeys = builtins.concatMap (
    platform: map (product: "${product.name}/${platformKey platform}") targets.products
  ) targets.platforms;
  checkEntry = entry:
    let
      descriptor = contract.verifyDescriptor {
        inherit (entry) descriptor;
        expectedDescriptorDigest = entry.descriptorSha256;
      };
      name = descriptor.name;
      platform = descriptor.platform;
      key = "${name}/${platformKey platform}";
      release = entry.release;
      tagMatch = builtins.match (
        "buck2-native-product-v1-${name}-${platform.os}-${platform.architecture}-${platform.abi}-([0-9a-f]{64})"
      ) release.tag;
      payloadDigest = if tagMatch == null then "" else builtins.head tagMatch;
      checks = [
        (ensure (builtins.attrNames entry == [ "descriptor" "descriptorSha256" "release" ])
          "${key} manifest fields are not exact")
        (ensure (builtins.hasAttr name targetByName) "${key} is not a declared product")
        (ensure (descriptor.semanticProvenance.target == targetByName.${name})
          "${key} target does not match the release declaration")
        (ensure (builtins.elem platform (map (value: builtins.removeAttrs value [ "system" ]) targets.platforms))
          "${key} platform is not admitted")
        (ensure (builtins.attrNames release == [ "hash" "name" "tag" "url" ])
          "${key} release fields are not exact")
        (ensure (tagMatch != null) "${key} release tag is not content-addressed")
        (ensure (release.name == "${payloadDigest}-${name}-${platform.os}-${platform.architecture}-${platform.abi}.tar")
          "${key} release asset name does not match its tag")
        (ensure (release.url == "${repositoryReleaseBase}/${release.tag}/${release.name}")
          "${key} release URL does not match its immutable tag and asset")
        (ensure (release.hash == descriptor.payload.digest.sri)
          "${key} release hash does not match the descriptor payload")
      ];
    in
    builtins.deepSeq checks {
      inherit (entry) descriptorSha256;
      inherit descriptor key platform release;
    };
  checkedEntries = map checkEntry manifest.products;
  actualKeys = map (entry: entry.key) checkedEntries;
  entryByKey = builtins.listToAttrs (
    map (entry: {
      name = entry.key;
      value = entry;
    }) checkedEntries
  );
  currentPlatform = lib.findFirst (platform: platform.system == pkgs.stdenv.hostPlatform.system) null targets.platforms;
  productsForPlatform = platform:
    let
      key = platformKey (builtins.removeAttrs platform [ "system" ]);
    in
    builtins.listToAttrs (
      map (declaration:
        let
          entry = entryByKey."${declaration.name}/${key}";
        in
        {
          inherit (declaration) name;
          value = importArtifact {
            descriptor = entry.descriptor;
            expectedDescriptorDigest = entry.descriptorSha256;
            expectedPlatform = entry.platform;
            url = entry.release.url;
          };
        }
      ) targets.products
    );
  productsBySystem = builtins.listToAttrs (
    map (platform: {
      name = platform.system;
      value = productsForPlatform platform;
    }) targets.platforms
  );
  products =
    if currentPlatform == null then { } else productsBySystem.${currentPlatform.system};
  topChecks = [
    (ensure (builtins.attrNames manifest == [ "products" "schema" ]) "manifest fields are not exact")
    (ensure (manifest.schema == "effect-utils/buck2-native-release-products/v1") "unsupported manifest schema")
    (ensure (targets.schema == "effect-utils/buck2-native-release-targets/v1") "unsupported target schema")
    (ensure (builtins.length actualKeys == builtins.length expectedKeys) "manifest matrix has the wrong size")
    (ensure (builtins.length actualKeys == builtins.length (lib.unique actualKeys)) "manifest matrix contains duplicates")
    (ensure (lib.sort builtins.lessThan actualKeys == lib.sort builtins.lessThan expectedKeys)
      "manifest does not exactly cover the declared product matrix")
    (ensure (currentPlatform != null) "host platform is not admitted")
  ];
in
builtins.deepSeq topChecks {
  inherit manifest products productsBySystem targets;
}
