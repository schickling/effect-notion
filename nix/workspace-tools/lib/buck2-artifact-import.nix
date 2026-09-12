# Verify and import a published Buck2 build product into the Nix store.
#
# Shape validation is not runtime proof. Each accepted tagged runtime dispatches
# to an exact inspector; all other runtime kinds remain fail closed.
{
  pkgs,
  inspectElfDynamic ? import ./buck2-runtime-inspect-elf-dynamic.nix { inherit pkgs; },
  inspectElfStatic ? import ./buck2-runtime-inspect-elf-static.nix { inherit pkgs; },
  inspectMachODynamic ?
    if pkgs.stdenv.hostPlatform.isDarwin then
      import ./buck2-runtime-inspect-mach-o-dynamic.nix {
        inherit pkgs;
        inspectionTools = import ./buck2-darwin-inspection-tools.nix { inherit pkgs; };
      }
    else
      null,
}:

let
  lib = pkgs.lib;
  contract = import ./buck2-build-product-contract.nix;
  scan = import ./buck2-artifact-scan.nix { inherit pkgs; };
in
{
  descriptor,
  expectedDescriptorDigest,
  expectedPlatform,
  url ? null,
  artifact ? null,
}:

let
  checkedDescriptor = contract.verifyDescriptor {
    inherit descriptor expectedDescriptorDigest;
  };
  checkedPlatform = checkedDescriptor.platform;
  runtimeKind = checkedDescriptor.runtime.kind;
  payload = checkedDescriptor.payload;
  fetchedArtifact =
    if url == null then
      artifact
    else
      pkgs.fetchurl {
        inherit url;
        hash = payload.digest.sri;
      };
  descriptorFile = pkgs.writeText "${checkedDescriptor.name}-buck-build-product.json" (
    contract.canonicalDescriptorJson checkedDescriptor
  );
in
assert lib.assertMsg (builtins.isAttrs expectedPlatform)
  "buck2-artifact-import: expectedPlatform must be an exact platform attribute set";
assert lib.assertMsg (
  checkedPlatform == expectedPlatform
) "buck2-artifact-import: platform mismatch";
assert lib.assertMsg (
  !(url != null && artifact != null)
) "buck2-artifact-import: choose either a published URL or a declared artifact path";
assert lib.assertMsg (
  url != null || artifact != null
) "buck2-artifact-import: a published URL or declared artifact path is required";
if
  !(builtins.elem runtimeKind [
    "elf-dynamic"
    "elf-static"
    "mach-o-dynamic"
  ])
then
  throw "buck2-artifact-import: runtime inspector is not available for ${runtimeKind}"
else if runtimeKind == "mach-o-dynamic" && inspectMachODynamic == null then
  throw "buck2-artifact-import: mach-o-dynamic inspection requires a Darwin Nix tool realization"
else
  pkgs.runCommand "${checkedDescriptor.name}-buck2-import"
    {
      nativeBuildInputs = [ pkgs.openssl ];
      allowedReferences = [ ];
      passthru = {
        descriptorDigest = expectedDescriptorDigest;
        inherit checkedDescriptor;
      };
    }
    ''
      set -euo pipefail
      archive=${lib.escapeShellArg (toString fetchedArtifact)}
      actual_size="$(${pkgs.coreutils}/bin/stat --format=%s "$archive")"
      [ "$actual_size" = ${lib.escapeShellArg (toString payload.sizeBytes)} ] || {
        echo "buck2-artifact-import: payload size mismatch: expected ${toString payload.sizeBytes}, got $actual_size" >&2
        exit 1
      }
      actual_digest="sha256-$(${pkgs.openssl}/bin/openssl dgst -sha256 -binary "$archive" \
        | ${pkgs.openssl}/bin/openssl base64 -A)"
      [ "$actual_digest" = ${lib.escapeShellArg payload.digest.sri} ] || {
        echo "buck2-artifact-import: payload digest mismatch" >&2
        exit 1
      }

      ${scan} archive "$archive"
      mkdir -p "$out"
      ${pkgs.gnutar}/bin/tar --extract --file "$archive" --directory "$out" \
        --no-same-owner --no-same-permissions
      ${scan} tree "$out"
      ${
        if runtimeKind == "elf-dynamic" then
          inspectElfDynamic
        else if runtimeKind == "elf-static" then
          inspectElfStatic
        else
          inspectMachODynamic
      } ${descriptorFile} "$out"

      ${pkgs.findutils}/bin/find "$out" -type d -exec chmod 0555 {} +
      while IFS= read -r -d "" file; do
        if [ -x "$file" ]; then chmod 0555 "$file"; else chmod 0444 "$file"; fi
      done < <(${pkgs.findutils}/bin/find "$out" -type f -print0)
    ''
