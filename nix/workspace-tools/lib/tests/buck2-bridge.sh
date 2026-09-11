#!/usr/bin/env bash
set -euo pipefail

# Every fixture below is a Linux ELF build product: buck2-bridge.nix hardcodes
# `platform.os = "linux"` with glibc/musl ABIs, compiles the fixtures with the
# host `stdenv`/`pkgsStatic` C compilers, patches host ELF interpreters, and the
# import path executes the built entrypoint. On a non-Linux host the same
# expressions produce Mach-O binaries described as linux/glibc, so the ELF
# class, machine, interpreter, DT_NEEDED, and symbol-version assertions cannot
# be executed at all. The platform-neutral descriptor contract is covered by
# buck2-build-product-contract.sh, which the gate runs before this script on
# every platform.
host_os="$(uname -s)"
if [ "$host_os" != Linux ]; then
  echo "buck2-bridge-test: SKIP host=$host_os reason=ELF fixture build, runtime inspection, and artifact import require a Linux host; platform-neutral descriptor coverage runs in buck2-build-product-contract.sh"
  exit 0
fi

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)}"
export BUCK2_BRIDGE_REPO="$repo_root"

common_let='repo = builtins.toPath (builtins.getEnv "BUCK2_BRIDGE_REPO");
  flake = builtins.getFlake (toString repo);
  pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
  test = import (repo + "/nix/workspace-tools/lib/tests/buck2-bridge.nix") { inherit pkgs; };
  contract = import (repo + "/nix/workspace-tools/lib/buck2-build-product-contract.nix");
  mkStrictDescriptor = { original, entrypoints }: {
    schema = "buck-build-product/v1";
    name = "fixture-tool";
    platform = original.platform;
    payload = original.payload;
    inherit entrypoints;
    runtime = { kind = "self-contained"; inspectionContract = "elf-static/v1"; };
    semanticProvenance = {
      target = "//fixtures:tool";
      recipe = "fixture-tool/v1";
      toolchain = "rust-linux-musl/v1";
    };
  };'
base_expr="let
  $common_let
in test"

build_expr() {
  nix build --impure --no-link --print-out-paths --expr "$1"
}

expect_build_failure() {
  local label="$1"
  local expected="$2"
  local expression="$3"
  local log
  log="$(mktemp)"
  if nix build --impure --no-link --expr "$expression" >"$log" 2>&1; then
    echo "buck2-bridge-test: expected $label to fail" >&2
    rm -f "$log"
    exit 1
  fi
  if ! grep -F "$expected" "$log" >/dev/null; then
    echo "buck2-bridge-test: $label failed without expected diagnostic: $expected" >&2
    sed -n '1,160p' "$log" >&2
    rm -f "$log"
    exit 1
  fi
  rm -f "$log"
  echo "buck2-bridge-test: RED $label"
}

expect_command_failure() {
  local label="$1"
  local expected="$2"
  shift 2
  local log
  log="$(mktemp)"
  if "$@" >"$log" 2>&1; then
    echo "buck2-bridge-test: expected $label to fail" >&2
    rm -f "$log"
    exit 1
  fi
  if ! grep -F "$expected" "$log" >/dev/null; then
    echo "buck2-bridge-test: $label failed without expected diagnostic: $expected" >&2
    sed -n '1,160p' "$log" >&2
    rm -f "$log"
    exit 1
  fi
  rm -f "$log"
  echo "buck2-bridge-test: RED $label"
}

static_product="$(build_expr "($base_expr).staticElfProduct")"
export BUCK2_BRIDGE_STATIC_PRODUCT="$static_product"
unsupported_runtime_expr="let
  $common_let
  exported = builtins.storePath (builtins.getEnv \"BUCK2_BRIDGE_STATIC_PRODUCT\");
    original = builtins.fromJSON (builtins.readFile (exported + \"/descriptor.json\"));
    descriptor = mkStrictDescriptor {
      inherit original;
      entrypoints = [ \"bin/fixture-tool\" ];
    };
  in test.mkImport {
    inherit descriptor;
    expectedDescriptorDigest = contract.descriptorDigest descriptor;
    expectedPlatform = descriptor.platform;
    artifact = exported + \"/artifact.tar\";
  }"
expect_build_failure \
  "unsupported build-product runtime" \
  "runtime inspector is not available for self-contained" \
  "$unsupported_runtime_expr"

dynamic_export="$(build_expr "($base_expr).dynamicExport")"
export BUCK2_BRIDGE_DYNAMIC_EXPORT="$dynamic_export"
jq -e '
  (.runtime.neededLibraries | index("libfixture[bracket].so")) != null and
  (.runtime.symbolVersionFloors | index("F  Flags: O")) != null and
  (.runtime.symbolVersionFloors | index("F")) == null and
  (.runtime.symbolVersionFloors | index("LOCAL_DEFINITION")) == null
' "$dynamic_export/descriptor.json" >/dev/null
dynamic_import_expr="let
  $common_let
  exported = builtins.storePath (builtins.getEnv \"BUCK2_BRIDGE_DYNAMIC_EXPORT\");
  descriptor = builtins.fromJSON (builtins.readFile (exported + \"/descriptor.json\"));
in test.mkImport {
  inherit descriptor;
  expectedDescriptorDigest = contract.descriptorDigest descriptor;
  expectedPlatform = descriptor.platform;
  artifact = exported + \"/artifact.tar\";
}"
dynamic_import="$(build_expr "$dynamic_import_expr")"
[ -x "$dynamic_import/bin/fixture-tool" ] || {
  echo "buck2-bridge-test: admitted dynamic entrypoint is missing" >&2
  exit 1
}

inspector_expr="let
  $common_let
in import (repo + \"/nix/workspace-tools/lib/buck2-runtime-inspect-elf-dynamic.nix\") { inherit pkgs; }"
inspector_out="$(build_expr "$inspector_expr")"
patchelf_out="$(build_expr "let $common_let in pkgs.patchelf")"
rpath_root="$(mktemp -d)"
tar --extract --file "$dynamic_export/artifact.tar" --directory "$rpath_root"
chmod u+w "$rpath_root/bin/fixture-tool"
"$patchelf_out/bin/patchelf" --set-rpath /hostile/runtime/path "$rpath_root/bin/fixture-tool"
expect_command_failure \
  "undeclared ELF runtime path" \
  "RPATH/RUNPATH must be absent" \
  "$inspector_out" "$dynamic_export/descriptor.json" "$rpath_root"
rm -rf "$rpath_root"

mutation_root() {
  local root
  root="$(mktemp -d)"
  tar --extract --file "$dynamic_export/artifact.tar" --directory "$root"
  chmod u+w "$root/bin/fixture-tool"
  printf '%s\n' "$root"
}

class_root="$(mutation_root)"
printf '\x01' | dd of="$class_root/bin/fixture-tool" bs=1 seek=4 conv=notrunc status=none
expect_command_failure "ELF class mutation" "ELF class mismatch" \
  "$inspector_out" "$dynamic_export/descriptor.json" "$class_root"
rm -rf "$class_root"

machine_root="$(mutation_root)"
case "$(jq -r '.platform.architecture' "$dynamic_export/descriptor.json")" in
  aarch64) foreign_machine='\x3e\x00' ;;
  x86_64) foreign_machine='\xb7\x00' ;;
  *)
    echo "buck2-bridge-test: unsupported native ELF architecture" >&2
    exit 1
    ;;
esac
printf '%b' "$foreign_machine" | dd of="$machine_root/bin/fixture-tool" bs=1 seek=18 conv=notrunc status=none
expect_command_failure "ELF machine mutation" "ELF machine mismatch" \
  "$inspector_out" "$dynamic_export/descriptor.json" "$machine_root"
rm -rf "$machine_root"

interpreter_root="$(mutation_root)"
mutated_interpreter='/wrong/interpreter: [loader]'
"$patchelf_out/bin/patchelf" --set-interpreter "$mutated_interpreter" "$interpreter_root/bin/fixture-tool"
expect_command_failure "ELF interpreter mutation" \
  "ELF interpreter mismatch for bin/fixture-tool: expected $(jq -r '.runtime.interpreter' "$dynamic_export/descriptor.json"), got $mutated_interpreter" \
  "$inspector_out" "$dynamic_export/descriptor.json" "$interpreter_root"
rm -rf "$interpreter_root"

needed_root="$(mutation_root)"
bracket_needed="$(jq -er '.runtime.neededLibraries[] | select(contains("["))' "$dynamic_export/descriptor.json")"
"$patchelf_out/bin/patchelf" --replace-needed "$bracket_needed" 'libfixture[changed].so' "$needed_root/bin/fixture-tool"
expect_command_failure "DT_NEEDED mutation" "DT_NEEDED mismatch" \
  "$inspector_out" "$dynamic_export/descriptor.json" "$needed_root"
rm -rf "$needed_root"

symbol_root="$(mutation_root)"
first_version="$(jq -er '.runtime.symbolVersionFloors[] | select(. == "F  Flags: O")' "$dynamic_export/descriptor.json")"
case "$first_version" in
  *9) mutated_version="${first_version%?}8" ;;
  *) mutated_version="${first_version%?}9" ;;
esac
escaped_version="${first_version//./\\.}"
sed -i "s/$escaped_version/$mutated_version/g" "$symbol_root/bin/fixture-tool"
expect_command_failure "symbol versions mutation" "symbol-version mismatch" \
  "$inspector_out" "$dynamic_export/descriptor.json" "$symbol_root"
rm -rf "$symbol_root"

clean_root="$(mutation_root)"
multiline_interpreter_inspector_expr="let
  $common_let
in import (repo + \"/nix/workspace-tools/lib/buck2-runtime-inspect-elf-dynamic.nix\") {
  inherit pkgs;
  readelf = builtins.toString test.multilineInterpreterReadelf;
}"
multiline_interpreter_inspector_out="$(build_expr "$multiline_interpreter_inspector_expr")"
expect_command_failure \
  "multiline PT_INTERP observation" \
  "malformed ELF program interpreter observation: bin/fixture-tool" \
  "$multiline_interpreter_inspector_out" "$dynamic_export/descriptor.json" "$clean_root"

failing_inspector_expr="let
  $common_let
in import (repo + \"/nix/workspace-tools/lib/buck2-runtime-inspect-elf-dynamic.nix\") {
  inherit pkgs;
  readelf = builtins.toString test.failingVersionReadelf;
}"
failing_inspector_out="$(build_expr "$failing_inspector_expr")"
expect_command_failure "readelf version-info failure" "readelf --version-info failed" \
  "$failing_inspector_out" "$dynamic_export/descriptor.json" "$clean_root"

empty_descriptor="$(mktemp)"
jq '.runtime.symbolVersionFloors = []' "$dynamic_export/descriptor.json" >"$empty_descriptor"
empty_inspector_expr="let
  $common_let
in import (repo + \"/nix/workspace-tools/lib/buck2-runtime-inspect-elf-dynamic.nix\") {
  inherit pkgs;
  readelf = builtins.toString test.emptyVersionReadelf;
}"
empty_inspector_out="$(build_expr "$empty_inspector_expr")"
"$empty_inspector_out" "$empty_descriptor" "$clean_root"
rm -rf "$clean_root"
rm -f "$empty_descriptor"

mach_o_root="$(mktemp -d)"
mkdir -p "$mach_o_root/bin"
dd if=/dev/zero of="$mach_o_root/bin/fixture-tool" bs=1 count=64 status=none
printf '\372\336\014\300\000\000\000\074\000\000\000\002\000\000\000\000\000\000\000\034\000\001\000\000\000\000\000\064\372\336\014\002\000\000\000\030\000\000\000\000\000\000\000\002\000\000\000\000\000\000\000\000\372\336\013\001\000\000\000\010' >>"$mach_o_root/bin/fixture-tool"
chmod +x "$mach_o_root/bin/fixture-tool"
mach_o_descriptor="$(mktemp)"
jq -cn '{
  schema: "buck-build-product/v1", name: "fixture-tool",
  platform: { os: "darwin", architecture: "aarch64", abi: "darwin" },
  payload: { file: "artifact.tar", format: "tar", digest: { algorithm: "sha256", sri: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }, sizeBytes: 1 },
  entrypoints: ["bin/fixture-tool"],
  runtime: { kind: "mach-o-dynamic", inspectionContract: "mach-o-dynamic/v1", architecture: "arm64", minimumOs: "14.0", dylibs: ["/usr/lib/libSystem.B.dylib"], installNamePolicy: "system-only/v1", rpathPolicy: "empty/v1", signingPolicy: "adhoc/v1" },
  semanticProvenance: { target: "//fixtures:tool", recipe: "fixture/v1", toolchain: "rust-darwin/v1" }
}' >"$mach_o_descriptor"
mach_o_inspector_expr="let
  $common_let
in import (repo + \"/nix/workspace-tools/lib/buck2-runtime-inspect-mach-o-dynamic.nix\") {
  inherit pkgs;
  inspectionTools = {
    otool = { identity = builtins.toString test.fixtureMachOOtool; executable = builtins.toString test.fixtureMachOOtool; };
    lipo = { identity = builtins.toString test.fixtureMachOLipo; executable = builtins.toString test.fixtureMachOLipo; };
  };
}"
mach_o_inspector_out="$(build_expr "$mach_o_inspector_expr")"
"$mach_o_inspector_out" "$mach_o_descriptor" "$mach_o_root"
cp "$mach_o_root/bin/fixture-tool" "$mach_o_root/bin/no-adhoc-tool"
printf '\000\000\000\000' | dd of="$mach_o_root/bin/no-adhoc-tool" bs=1 seek=104 conv=notrunc status=none
jq '.entrypoints = ["bin/no-adhoc-tool"]' "$mach_o_descriptor" >"$mach_o_descriptor.no-adhoc"
expect_command_failure "Mach-O CodeDirectory without ad-hoc flag" "must carry the ad-hoc flag" \
  "$mach_o_inspector_out" "$mach_o_descriptor.no-adhoc" "$mach_o_root"
cp "$mach_o_root/bin/fixture-tool" "$mach_o_root/bin/cms-tool"
printf '\011' | dd of="$mach_o_root/bin/cms-tool" bs=1 seek=123 conv=notrunc status=none
jq '.entrypoints = ["bin/cms-tool"]' "$mach_o_descriptor" >"$mach_o_descriptor.cms"
expect_command_failure "Mach-O non-empty CMS signature wrapper" "CMS signature blob must be empty" \
  "$mach_o_inspector_out" "$mach_o_descriptor.cms" "$mach_o_root"
hostile_mach_o_inspector_expr="let
  $common_let
in import (repo + \"/nix/workspace-tools/lib/buck2-runtime-inspect-mach-o-dynamic.nix\") {
  inherit pkgs;
  inspectionTools = {
    otool = { identity = builtins.toString test.hostileMachOOtool; executable = builtins.toString test.hostileMachOOtool; };
    lipo = { identity = builtins.toString test.fixtureMachOLipo; executable = builtins.toString test.fixtureMachOLipo; };
  };
}"
hostile_mach_o_inspector_out="$(build_expr "$hostile_mach_o_inspector_expr")"
expect_command_failure "Mach-O non-system dylib observation" "Mach-O dylib mismatch" \
  "$hostile_mach_o_inspector_out" "$mach_o_descriptor" "$mach_o_root"
fat_mach_o_inspector_expr="let
  $common_let
in import (repo + \"/nix/workspace-tools/lib/buck2-runtime-inspect-mach-o-dynamic.nix\") {
  inherit pkgs;
  inspectionTools = {
    otool = { identity = builtins.toString test.fixtureMachOOtool; executable = builtins.toString test.fixtureMachOOtool; };
    lipo = { identity = builtins.toString test.fatMachOLipo; executable = builtins.toString test.fatMachOLipo; };
  };
}"
fat_mach_o_inspector_out="$(build_expr "$fat_mach_o_inspector_expr")"
expect_command_failure "Mach-O universal binary" "must contain exactly one architecture" \
  "$fat_mach_o_inspector_out" "$mach_o_descriptor" "$mach_o_root"
rm -rf "$mach_o_root"
rm -f "$mach_o_descriptor" "$mach_o_descriptor.no-adhoc" "$mach_o_descriptor.cms"

tampered_archive="$(mktemp)"
cp "$dynamic_export/artifact.tar" "$tampered_archive"
printf x | dd of="$tampered_archive" bs=1 seek=1024 conv=notrunc status=none
export BUCK2_BRIDGE_TAMPERED_ARCHIVE="$tampered_archive"
expect_build_failure \
  "payload tampering before archive scan" \
  "payload digest mismatch" \
  "let
    $common_let
    exported = builtins.storePath (builtins.getEnv \"BUCK2_BRIDGE_DYNAMIC_EXPORT\");
    descriptor = builtins.fromJSON (builtins.readFile (exported + \"/descriptor.json\"));
  in test.mkImport {
    inherit descriptor;
    expectedDescriptorDigest = contract.descriptorDigest descriptor;
    expectedPlatform = descriptor.platform;
    artifact = builtins.path {
      path = builtins.getEnv \"BUCK2_BRIDGE_TAMPERED_ARCHIVE\";
      name = \"tampered-artifact.tar\";
    };
  }"
rm -f "$tampered_archive"

duplicate_import_entrypoint_expr="let
  $common_let
  exported = builtins.storePath (builtins.getEnv \"BUCK2_BRIDGE_DYNAMIC_EXPORT\");
    original = builtins.fromJSON (builtins.readFile (exported + \"/descriptor.json\"));
    descriptor = mkStrictDescriptor {
      inherit original;
      entrypoints = [ \"bin/fixture-tool\" \"bin/fixture-tool\" ];
    };
  in test.mkImport {
    inherit descriptor;
    expectedDescriptorDigest = \"sha256:0000000000000000000000000000000000000000000000000000000000000000\";
    expectedPlatform = descriptor.platform;
    artifact = exported + \"/artifact.tar\";
  }"
expect_build_failure \
  "duplicate import entrypoint" \
  "descriptor.entrypoints entries must be unique" \
  "$duplicate_import_entrypoint_expr"

scan_expr="let
  $common_let
in import (repo + \"/nix/workspace-tools/lib/buck2-artifact-scan.nix\") { inherit pkgs; }"
scan_out="$(build_expr "$scan_expr")"

store_reference_root="$(mktemp -d)"
tar --extract --file "$dynamic_export/artifact.tar" --directory "$store_reference_root"
chmod u+w "$store_reference_root/bin/fixture-tool"
printf '%s' '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-host-leak' \
  >>"$store_reference_root/bin/fixture-tool"
expect_command_failure \
  "dynamic payload store reference" \
  "forbidden Nix store reference" \
  "$scan_out" tree "$store_reference_root"
rm -rf "$store_reference_root"

unreadable_archive_root="$(mktemp -d)"
unreadable_extract_root="$(mktemp -d)"
unreadable_archive="$(mktemp)"
printf '%s\n' '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-unreadable-leak' \
  >"$unreadable_archive_root/unreadable"
tar --create --mode=000 --file "$unreadable_archive" \
  --directory "$unreadable_archive_root" unreadable
tar --extract --file "$unreadable_archive" \
  --directory "$unreadable_extract_root"
[ ! -r "$unreadable_extract_root/unreadable" ] \
  || fail "unreadable archive fixture unexpectedly remained readable"
expect_command_failure \
  "unreadable archive member store reference" \
  "failed to scan tree for forbidden Nix store references" \
  "$scan_out" tree "$unreadable_extract_root"
chmod u+r "$unreadable_extract_root/unreadable"
rm -rf "$unreadable_archive_root" "$unreadable_extract_root" "$unreadable_archive"

portable_symlink_root="$(mktemp -d)"
mkdir -p "$portable_symlink_root/bin" "$portable_symlink_root/lib"
printf '%s\n' portable >"$portable_symlink_root/lib/tool"
ln -s ../lib/tool "$portable_symlink_root/bin/tool"
"$scan_out" tree "$portable_symlink_root"
rm -rf "$portable_symlink_root"

for symlink_case in \
  'backslash|foo\bar|portable POSIX separators' \
  'repeated-separator|foo//bar|normalized' \
  'dot-component|foo/./bar|normalized'
do
  symlink_label="${symlink_case%%|*}"
  symlink_remainder="${symlink_case#*|}"
  symlink_target="${symlink_remainder%%|*}"
  symlink_diagnostic="${symlink_remainder#*|}"
  symlink_root="$(mktemp -d)"
  ln -s "$symlink_target" "$symlink_root/link"
  expect_command_failure \
    "$symlink_label symlink target" \
    "$symlink_diagnostic" \
    "$scan_out" tree "$symlink_root"
  rm -rf "$symlink_root"
done

control_symlink_targets=($'foo\nbar' $'foo\tbar' $'foo\x7fbar')
for control_index in "${!control_symlink_targets[@]}"; do
  control_symlink_root="$(mktemp -d)"
  ln -s "${control_symlink_targets[$control_index]}" "$control_symlink_root/link"
  expect_command_failure \
    "control-character-$control_index symlink target" \
    "control characters" \
    "$scan_out" tree "$control_symlink_root"
  rm -rf "$control_symlink_root"
done

special_root="$(mktemp -d)"
trap 'rm -rf "$special_root"' EXIT
mkfifo "$special_root/fixture.fifo"
expect_command_failure \
  "special tree node" \
  "unsupported tree node type" \
  "$scan_out" tree "$special_root"
tar --create --file "$special_root.tar" --directory "$special_root" .
expect_command_failure \
  "special archive member" \
  "unsupported archive member type" \
  "$scan_out" archive "$special_root.tar"
rm -f "$special_root.tar"

duplicate_root="$(mktemp -d)"
mkdir -p "$duplicate_root/bin"
printf '%s\n' first >"$duplicate_root/bin/tool"
tar --create --file "$duplicate_root.tar" --directory "$duplicate_root" bin/tool
printf '%s\n' second >"$duplicate_root/bin/tool"
tar --append --file "$duplicate_root.tar" --directory "$duplicate_root" bin/tool
expect_command_failure \
  "duplicate archive member" \
  "duplicate archive member: bin/tool" \
  "$scan_out" archive "$duplicate_root.tar"
rm -rf "$duplicate_root" "$duplicate_root.tar"

backslash_root="$(mktemp -d)"
mkdir -p "$backslash_root/share"
tar --create --file "$backslash_root.tar" --directory "$backslash_root" \
  --transform='s|share|share\\bad|' share
expect_command_failure \
  "backslash archive member" \
  "archive member must use portable POSIX separators" \
  "$scan_out" archive "$backslash_root.tar"
rm -rf "$backslash_root" "$backslash_root.tar"

collision_root="$(mktemp -d)"
mkdir -p "$collision_root/inside"
printf '%s\n' collision >"$collision_root/inside/file"
ln -s inside "$collision_root/link"
tar --create --file "$collision_root.tar" --directory "$collision_root" link
tar --append --file "$collision_root.tar" --directory "$collision_root" \
  --transform='s|inside|link|' inside/file
expect_command_failure \
  "symlink ancestor archive member" \
  "archive member is beneath symlink ancestor" \
  "$scan_out" archive "$collision_root.tar"
rm -rf "$collision_root" "$collision_root.tar"

sparse_root="$(mktemp -d)"
truncate --size=5G "$sparse_root/oversized"
tar --sparse --create --file "$sparse_root.tar" --directory "$sparse_root" oversized
expect_command_failure \
  "oversized sparse archive member" \
  "archive member exceeds extracted-size limit" \
  "$scan_out" archive "$sparse_root.tar"
rm -rf "$sparse_root" "$sparse_root.tar"

aggregate_root="$(mktemp -d)"
for index in 1 2 3 4 5; do
  truncate --size=900M "$aggregate_root/part-$index"
done
tar --sparse --create --file "$aggregate_root.tar" --directory "$aggregate_root" .
expect_command_failure \
  "aggregate sparse archive size" \
  "archive exceeds aggregate extracted-size limit" \
  "$scan_out" archive "$aggregate_root.tar"
rm -rf "$aggregate_root" "$aggregate_root.tar"

trailing_root="$(mktemp -d)"
printf '%s\n' payload >"$trailing_root/file"
tar --create --file "$trailing_root.tar" --directory "$trailing_root" file
printf '%s' trailing-bytes >>"$trailing_root.tar"
expect_command_failure \
  "trailing archive bytes" \
  "archive contains trailing data after end-of-archive marker" \
  "$scan_out" archive "$trailing_root.tar"
rm -rf "$trailing_root" "$trailing_root.tar"

concatenated_root="$(mktemp -d)"
printf '%s\n' first >"$concatenated_root/first"
printf '%s\n' second >"$concatenated_root/second"
tar --create --file "$concatenated_root.tar" --directory "$concatenated_root" first
tar --create --file "$concatenated_root-second.tar" --directory "$concatenated_root" second
${CAT_BIN:-cat} "$concatenated_root-second.tar" >>"$concatenated_root.tar"
expect_command_failure \
  "concatenated archive" \
  "archive contains trailing data after end-of-archive marker" \
  "$scan_out" archive "$concatenated_root.tar"
rm -rf "$concatenated_root" "$concatenated_root.tar" "$concatenated_root-second.tar"

echo "buck2-bridge-test: PASS static_product=$static_product dynamic_import=$dynamic_import"
