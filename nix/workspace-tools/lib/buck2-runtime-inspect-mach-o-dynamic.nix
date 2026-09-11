# Inspect an extracted buck-build-product/v1 Mach-O payload without rewriting it.
{
  pkgs,
  inspectionTools,
}:

let
  expectedTools = [
    "lipo"
    "otool"
  ];
  exactTools = builtins.attrNames inspectionTools == expectedTools;
  validTool =
    tool:
    builtins.isAttrs tool
    &&
      builtins.attrNames tool == [
        "executable"
        "identity"
      ]
    && builtins.isString tool.identity
    && builtins.match "/nix/store/[0-9a-z]{32}-[^/]+" tool.identity != null
    && builtins.isString tool.executable
    && (tool.executable == tool.identity || pkgs.lib.hasPrefix "${tool.identity}/" tool.executable);
  toolsValid = exactTools && builtins.all (name: validTool inspectionTools.${name}) expectedTools;
  script = pkgs.writeShellScript "buck2-runtime-inspect-mach-o-dynamic" ''
    set -euo pipefail
    export LC_ALL=C

    fail() {
      echo "buck2-runtime-inspect-mach-o-dynamic: FATAL - $*" >&2
      exit 1
    }

    [ "$#" -eq 2 ] || fail "usage: $0 DESCRIPTOR_JSON EXTRACTED_ROOT"
    descriptor="$1"
    root="$2"
    [ -f "$descriptor" ] || fail "descriptor does not exist"
    [ -d "$root" ] || fail "extracted root does not exist"
    [ "$(${pkgs.jq}/bin/jq -r '.runtime.kind' "$descriptor")" = mach-o-dynamic ] \
      || fail "descriptor runtime kind must be mach-o-dynamic"
    [ "$(${pkgs.jq}/bin/jq -r '.runtime.inspectionContract' "$descriptor")" = mach-o-dynamic/v1 ] \
      || fail "unsupported inspection contract"
    [ -x ${pkgs.lib.escapeShellArg inspectionTools.otool.executable} ] || fail "Mach-O inspector is unavailable"
    [ -x ${pkgs.lib.escapeShellArg inspectionTools.lipo.executable} ] || fail "Mach-O architecture inspector is unavailable"

    read_be32() {
      local file="$1" offset="$2" bytes
      read -r -a bytes <<<"$(${pkgs.coreutils}/bin/od -An -tu1 -j "$offset" -N 4 "$file")"
      [ "''${#bytes[@]}" -eq 4 ] || fail "truncated Mach-O signature structure"
      printf '%s\n' "$((bytes[0] * 16777216 + bytes[1] * 65536 + bytes[2] * 256 + bytes[3]))"
    }

    inspect_entrypoint() {
      local relative="$1"
      local executable="$root/$relative"
      [ -f "$executable" ] && [ ! -L "$executable" ] \
        || fail "entrypoint must be a regular non-symlink file: $relative"
      [ -x "$executable" ] || fail "entrypoint is not executable: $relative"

      local headers load_commands lipo_info actual_architecture header_architecture actual_platform actual_minimum_os
      lipo_info="$(${pkgs.lib.escapeShellArg inspectionTools.lipo.executable} -info "$executable")" \
        || fail "lipo architecture inspection failed for $relative"
      case "$lipo_info" in
        "Non-fat file: $executable is architecture: "*) ;;
        *) fail "Mach-O entrypoint must contain exactly one architecture: $relative" ;;
      esac
      actual_architecture="''${lipo_info#Non-fat file: $executable is architecture: }"
      case "$actual_architecture" in
        arm64|x86_64) ;;
        *) fail "unsupported Mach-O architecture for $relative: $actual_architecture" ;;
      esac
      [ "$actual_architecture" = "$(${pkgs.jq}/bin/jq -r '.runtime.architecture' "$descriptor")" ] \
        || fail "Mach-O architecture mismatch for $relative"

      headers="$(${pkgs.lib.escapeShellArg inspectionTools.otool.executable} -hv "$executable")" \
        || fail "otool header inspection failed for $relative"
      header_architecture="$(printf '%s\n' "$headers" | ${pkgs.gawk}/bin/awk '
        $1 == "MH_MAGIC_64" && ($2 == "ARM64" || $2 == "X86_64") {
          print tolower($2)
          seen++
        }
        END { if (seen != 1) exit 2 }
      ')" || fail "malformed Mach-O architecture observation: $relative"
      [ "$header_architecture" = "$actual_architecture" ] \
        || fail "Mach-O header architecture disagrees with lipo for $relative"

      load_commands="$(${pkgs.lib.escapeShellArg inspectionTools.otool.executable} -l "$executable")" \
        || fail "otool load-command inspection failed for $relative"
      read -r actual_platform actual_minimum_os < <(printf '%s\n' "$load_commands" | ${pkgs.gawk}/bin/awk '
        /^      cmd LC_BUILD_VERSION$/ { in_version = 1; next }
        in_version && /^ platform / { platform = $2; next }
        in_version && /^    minos / { minos = $2; matches++; in_version = 0 }
        END {
          if (matches != 1 || platform == "" || minos == "") exit 2
          print platform, minos
        }
      ') || fail "malformed Mach-O build-version observation: $relative"
      [ "$actual_platform" = "MACOS" ] || [ "$actual_platform" = "1" ] \
        || fail "Mach-O build platform mismatch for $relative"
      [ "$actual_minimum_os" = "$(${pkgs.jq}/bin/jq -r '.runtime.minimumOs' "$descriptor")" ] \
        || fail "Mach-O minimum OS mismatch for $relative"

      local actual_dylibs expected_dylibs
      actual_dylibs="$(${pkgs.lib.escapeShellArg inspectionTools.otool.executable} -L "$executable" | ${pkgs.gawk}/bin/awk 'NR > 1 {
        sub(/^[[:space:]]+/, "")
        sub(/[[:space:]]+\(compatibility version .*$/, "")
        print
      }' | ${pkgs.coreutils}/bin/sort -u)"
      expected_dylibs="$(${pkgs.jq}/bin/jq -r '.runtime.dylibs[]' "$descriptor")"
      [ "$actual_dylibs" = "$expected_dylibs" ] || fail "Mach-O dylib mismatch for $relative"
      if printf '%s\n' "$actual_dylibs" | ${pkgs.gnugrep}/bin/grep -Ev '^/usr/lib/|^/System/Library/' >/dev/null; then
        fail "Mach-O install names must be system-only: $relative"
      fi
      if printf '%s\n' "$load_commands" | ${pkgs.gnugrep}/bin/grep -Eq '^      cmd LC_RPATH$'; then
        fail "Mach-O LC_RPATH must be absent: $relative"
      fi
      local signature_offset signature_size file_size magic declared_size count index slot blob_offset blob_magic blob_size flags
      read -r signature_offset signature_size < <(printf '%s\n' "$load_commands" | ${pkgs.gawk}/bin/awk '
        /^      cmd LC_CODE_SIGNATURE$/ { in_signature = 1; matches++; next }
        in_signature && /^  dataoff / { offset = $2; next }
        in_signature && /^ datasize / { size = $2; in_signature = 0 }
        END {
          if (matches != 1 || offset !~ /^[0-9]+$/ || size !~ /^[0-9]+$/ || size == 0) exit 2
          print offset, size
        }
      ') || fail "malformed Mach-O LC_CODE_SIGNATURE observation: $relative"
      file_size="$(${pkgs.coreutils}/bin/stat -c %s "$executable")"
      [ "$signature_offset" -le "$file_size" ] \
        && [ "$signature_size" -le "$((file_size - signature_offset))" ] \
        || fail "Mach-O code signature is outside the executable: $relative"
      magic="$(read_be32 "$executable" "$signature_offset")"
      [ "$magic" -eq 4208856256 ] || fail "Mach-O code signature is not a superblob: $relative"
      declared_size="$(read_be32 "$executable" "$((signature_offset + 4))")"
      count="$(read_be32 "$executable" "$((signature_offset + 8))")"
      [ "$declared_size" -ge 12 ] \
        && [ "$declared_size" -le "$signature_size" ] \
        && [ "$count" -le "$(( (declared_size - 12) / 8 ))" ] \
        || fail "malformed Mach-O code signature superblob: $relative"
      flags=
      index=0
      while [ "$index" -lt "$count" ]; do
        slot="$(read_be32 "$executable" "$((signature_offset + 12 + index * 8))")"
        blob_offset="$(read_be32 "$executable" "$((signature_offset + 16 + index * 8))")"
        [ "$blob_offset" -le "$((declared_size - 8))" ] \
          || fail "Mach-O code-signature blob is outside the superblob: $relative"
        if [ "$slot" -eq 65536 ]; then
          blob_magic="$(read_be32 "$executable" "$((signature_offset + blob_offset))")"
          blob_size="$(read_be32 "$executable" "$((signature_offset + blob_offset + 4))")"
          [ "$blob_magic" -eq 4208855809 ] \
            && [ "$blob_size" -eq 8 ] \
            && [ "$((blob_offset + blob_size))" -le "$declared_size" ] \
            || fail "Mach-O CMS signature blob must be empty: $relative"
        fi
        if [ "$slot" -eq 0 ]; then
          blob_magic="$(read_be32 "$executable" "$((signature_offset + blob_offset))")"
          blob_size="$(read_be32 "$executable" "$((signature_offset + blob_offset + 4))")"
          [ "$blob_magic" -ge 4208856066 ] \
            && [ "$blob_magic" -le 4208856068 ] \
            && [ "$blob_size" -ge 16 ] \
            && [ "$((blob_offset + blob_size))" -le "$declared_size" ] \
            || fail "Mach-O CodeDirectory is invalid: $relative"
          flags="$(read_be32 "$executable" "$((signature_offset + blob_offset + 12))")"
        fi
        index="$((index + 1))"
      done
      [ -n "$flags" ] || fail "Mach-O CodeDirectory must be present: $relative"
      [ "$((flags & 2))" -eq 2 ] || fail "Mach-O CodeDirectory must carry the ad-hoc flag: $relative"
    }

    while IFS= read -r entrypoint; do
      inspect_entrypoint "$entrypoint"
    done < <(${pkgs.jq}/bin/jq -r '.entrypoints[]' "$descriptor")
  '';
in
assert pkgs.lib.assertMsg toolsValid
  "buck2-runtime-inspect-mach-o-dynamic: inspectionTools must declare exact Nix-store identities and executables";
script.overrideAttrs (old: {
  passthru = (old.passthru or { }) // {
    inspectionToolIdentities = builtins.mapAttrs (_: tool: tool.identity) inspectionTools;
  };
})
