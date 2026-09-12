# Inspect an extracted buck-build-product/v1 elf-static payload without
# rewriting it. The descriptor is a claim; readelf output is the observation.
{
  pkgs,
  readelf ? "${pkgs.binutils}/bin/readelf",
}:

pkgs.writeShellScript "buck2-runtime-inspect-elf-static" ''
  set -euo pipefail
  export LC_ALL=C

  fail() {
    echo "buck2-runtime-inspect-elf-static: FATAL - $*" >&2
    exit 1
  }

  [ "$#" -eq 2 ] || fail "usage: $0 DESCRIPTOR_JSON EXTRACTED_ROOT"
  descriptor="$1"
  root="$2"
  [ -f "$descriptor" ] || fail "descriptor does not exist"
  [ -d "$root" ] || fail "extracted root does not exist"

  [ "$(${pkgs.jq}/bin/jq -r '.runtime.kind' "$descriptor")" = elf-static ] \
    || fail "descriptor runtime kind must be elf-static"
  [ "$(${pkgs.jq}/bin/jq -r '.runtime.inspectionContract' "$descriptor")" = elf-static/v1 ] \
    || fail "unsupported inspection contract"

  inspect_entrypoint() {
    local relative="$1"
    local executable="$root/$relative"
    [ -f "$executable" ] && [ ! -L "$executable" ] \
      || fail "entrypoint must be a regular non-symlink file: $relative"
    [ -x "$executable" ] || fail "entrypoint is not executable: $relative"

    local actual_class expected_class raw_machine actual_machine expected_machine headers
    actual_class="$(${readelf} --file-header "$executable" \
      | ${pkgs.gawk}/bin/awk -F: '$1 ~ /^[[:space:]]*Class$/ { sub(/^[[:space:]]+/, "", $2); print $2 }')"
    expected_class="$(${pkgs.jq}/bin/jq -r '.runtime.elfClass' "$descriptor")"
    [ "$actual_class" = "$expected_class" ] \
      || fail "ELF class mismatch for $relative: expected $expected_class, got $actual_class"

    raw_machine="$(${readelf} --file-header "$executable" \
      | ${pkgs.gawk}/bin/awk -F: '$1 ~ /^[[:space:]]*Machine$/ { sub(/^[[:space:]]+/, "", $2); print $2 }')"
    case "$raw_machine" in
      "Advanced Micro Devices X86-64") actual_machine=x86_64 ;;
      "AArch64") actual_machine=aarch64 ;;
      *) fail "unsupported ELF machine for $relative: $raw_machine" ;;
    esac
    expected_machine="$(${pkgs.jq}/bin/jq -r '.runtime.machine' "$descriptor")"
    [ "$actual_machine" = "$expected_machine" ] \
      || fail "ELF machine mismatch for $relative: expected $expected_machine, got $actual_machine"

    headers="$(${readelf} --program-headers "$executable")" \
      || fail "readelf --program-headers failed for $relative"
    printf '%s\n' "$headers" | ${pkgs.gnugrep}/bin/grep -Eq '^[[:space:]]*LOAD[[:space:]]' \
      || fail "entrypoint has no loadable ELF segment: $relative"
    if printf '%s\n' "$headers" | ${pkgs.gnugrep}/bin/grep -Eq '^[[:space:]]*(INTERP|DYNAMIC)[[:space:]]'; then
      fail "entrypoint is not static: $relative"
    fi
  }

  while IFS= read -r entrypoint; do
    inspect_entrypoint "$entrypoint"
  done < <(${pkgs.jq}/bin/jq -r '.entrypoints[]' "$descriptor")
''
