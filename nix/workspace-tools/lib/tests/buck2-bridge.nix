{ pkgs }:

let
  importArtifact = import ../buck2-artifact-import.nix { inherit pkgs; };
  hostArchitecture = if pkgs.stdenv.hostPlatform.isAarch64 then "aarch64" else "x86_64";
  hostElfMachine = hostArchitecture;
  hostInterpreter =
    if pkgs.stdenv.hostPlatform.isAarch64 then
      "/lib/ld-linux-aarch64.so.1"
    else
      "/lib64/ld-linux-x86-64.so.2";

  dynamicExport =
    pkgs.runCommand "buck2-bridge-dynamic-export"
      {
        nativeBuildInputs = [
          pkgs.binutils
          pkgs.jq
          pkgs.openssl
          pkgs.patchelf
          pkgs.stdenv.cc
        ];
      }
      ''
        set -euo pipefail
        export LC_ALL=C
        mkdir -p payload/bin "$out"
        printf '%s\n' 'int fixture_symbol(void) { return 0; }' > library.c
        printf '%s\n' 'F123456789O { global: fixture_symbol; };' > library.map
        cc -shared -Wl,--version-script=library.map \
          -Wl,-soname,'libfixture[bracket].so' -o 'libfixture[bracket].so' library.c
        printf '%s\n' \
          'extern int fixture_symbol(void);' \
          'int main(void) { return fixture_symbol(); }' > fixture.c
        printf '%s\n' 'LOCAL_DEFINITION { global: main; };' > executable.map
        cc -Wl,--version-script=executable.map -o payload/bin/fixture-tool \
          fixture.c './libfixture[bracket].so'
        # ELF string-table names may contain whitespace even though the linker
        # version-script grammar cannot spell it. Preserve the byte width while
        # making the observed version need distinguishable from field splitting.
        sed -i 's/F123456789O/F  Flags: O/g' payload/bin/fixture-tool
        # Replacing the wrapper-injected store RPATH before removing it ensures
        # those bytes are absent rather than merely unreachable dynamic data.
        patchelf --set-interpreter ${hostInterpreter} --set-rpath /unused payload/bin/fixture-tool
        patchelf --remove-rpath payload/bin/fixture-tool
        chmod 0555 payload/bin/fixture-tool
        tar --create --format=gnu --sort=name --mtime='@1' --owner=0 --group=0 \
          --numeric-owner --file "$out/artifact.tar" --directory payload .
        digest="sha256-$(openssl dgst -sha256 -binary "$out/artifact.tar" | openssl base64 -A)"
        size="$(stat --format=%s "$out/artifact.tar")"
        needed="$(readelf --dynamic payload/bin/fixture-tool \
          | awk '
              /\(NEEDED\)/ {
                marker = "Shared library: ["
                start = index($0, marker)
                if (start == 0) exit 2
                value = substr($0, start + length(marker))
                if (substr(value, length(value), 1) != "]") exit 2
                print substr(value, 1, length(value) - 1)
              }' \
          | sort -u | jq --raw-input --slurp 'split("\n") | map(select(length > 0))')"
        versions="$(readelf --version-info payload/bin/fixture-tool \
          | awk '
              /^[[:space:]]*Version needs section / { in_needs = 1; next }
              /^[[:space:]]*Version (symbols|definition) section / { in_needs = 0 }
              in_needs {
                name_marker = "Name: "
                flags_marker = "  Flags: "
                name_start = index($0, name_marker)
                if (name_start > 0) {
                  value = substr($0, name_start + length(name_marker))
                  flags_start = 0
                  search_start = 1
                  while ((relative_start = index(substr(value, search_start), flags_marker)) > 0) {
                    flags_start = search_start + relative_start - 1
                    search_start = flags_start + length(flags_marker)
                  }
                  if (flags_start == 0) exit 2
                  print substr(value, 1, flags_start - 1)
                }
              }' \
          | sort -u \
          | jq --raw-input --slurp 'split("\n") | map(select(length > 0))')"
        jq --null-input --sort-keys \
          --arg digest "$digest" --argjson size "$size" \
          --arg architecture ${hostArchitecture} --arg machine ${hostElfMachine} \
          --arg interpreter ${hostInterpreter} \
          --argjson needed "$needed" --argjson versions "$versions" \
          '{
            schema: "buck-build-product/v1",
            name: "fixture-tool",
            platform: { os: "linux", architecture: $architecture, abi: "glibc" },
            payload: {
              file: "artifact.tar", format: "tar",
              digest: { algorithm: "sha256", sri: $digest }, sizeBytes: $size
            },
            entrypoints: ["bin/fixture-tool"],
            runtime: {
              kind: "elf-dynamic", inspectionContract: "elf-dynamic/v1",
              elfClass: "ELF64", machine: $machine,
              interpreter: $interpreter,
              neededLibraries: $needed, symbolVersionFloors: $versions,
              rpathPolicy: "empty/v1"
            },
            semanticProvenance: {
              target: "//fixtures:dynamic-tool", recipe: "fixture-dynamic/v1",
              toolchain: "cc-linux-glibc/v1"
            }
          }' > "$out/descriptor.json"
      '';

  failingVersionReadelf = pkgs.writeShellScript "failing-version-readelf" ''
    if [ "''${1-}" = --version-info ]; then
      exit 9
    fi
    exec ${pkgs.binutils}/bin/readelf "$@"
  '';

  emptyVersionReadelf = pkgs.writeShellScript "empty-version-readelf" ''
    if [ "''${1-}" = --version-info ]; then
      exit 0
    fi
    exec ${pkgs.binutils}/bin/readelf "$@"
  '';

  multilineInterpreterReadelf = pkgs.writeShellScript "multiline-interpreter-readelf" ''
    if [ "''${1-}" = --program-headers ]; then
      printf '%s\n' \
        '      [Requesting program interpreter: ${hostInterpreter}' \
        'injected-control-data]'
      exit 0
    fi
    exec ${pkgs.binutils}/bin/readelf "$@"
  '';

  fixtureMachOOtool = pkgs.writeShellScript "fixture-mach-o-otool" ''
    case "''${1-}" in
      -hv)
        printf '%s\n' \
          "$2:" \
          'Mach header' \
          '      magic  cputype cpusubtype  caps    filetype ncmds sizeofcmds      flags' \
          'MH_MAGIC_64    ARM64        ALL  0x00     EXECUTE    19       1984   NOUNDEFS'
        ;;
      -l)
        printf '%s\n' \
          'Load command 0' \
          '      cmd LC_BUILD_VERSION' \
          ' platform 1' \
          '    minos 14.0' \
          'Load command 1' \
          '      cmd LC_CODE_SIGNATURE' \
          '  dataoff 64' \
          ' datasize 60'
        ;;
      -L)
        printf '%s\n' \
          "$2:" \
          '        /usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)'
        ;;
      *) exit 64 ;;
    esac
  '';

  fixtureMachOLipo = pkgs.writeShellScript "fixture-mach-o-lipo" ''
    [ "''${1-}" = -info ] && [ -f "''${2-}" ]
    printf 'Non-fat file: %s is architecture: arm64\n' "$2"
  '';

  fatMachOLipo = pkgs.writeShellScript "fat-mach-o-lipo" ''
    [ "''${1-}" = -info ] && [ -f "''${2-}" ]
    printf 'Architectures in the fat file: %s are: x86_64 arm64\n' "$2"
  '';

  hostileMachOOtool = pkgs.writeShellScript "hostile-mach-o-otool" ''
    if [ "''${1-}" = -L ]; then
      printf '%s\n' \
        "$2:" \
        '        @rpath/libprivate.dylib (compatibility version 1.0.0, current version 1.0.0)'
      exit 0
    fi
    exec ${fixtureMachOOtool} "$@"
  '';

  mkElfProduct =
    {
      name,
      cc,
      static ? false,
    }:
    pkgs.runCommand name
      {
        nativeBuildInputs = [
          cc
          pkgs.gnutar
          pkgs.jq
          pkgs.openssl
        ];
        allowedReferences = [ ];
      }
      ''
        mkdir -p payload/bin "$out"
        printf '%s\n' 'int main(void) { return 0; }' > fixture.c
        $CC ${
          if static then "-static" else "-Wl,--dynamic-linker=${hostInterpreter} -Wl,--disable-new-dtags"
        } fixture.c -o payload/bin/fixture-tool
        tar --create --format=gnu --sort=name --mtime=@1 --owner=0 --group=0 --numeric-owner \
          --file "$out/artifact.tar" --directory payload .
        digest="sha256-$(openssl dgst -sha256 -binary "$out/artifact.tar" | openssl base64 -A)"
        size="$(stat --format=%s "$out/artifact.tar")"
        jq -cn --arg digest "$digest" --argjson size "$size" \
          --arg architecture ${hostArchitecture} '{
          entrypoints: ["bin/fixture-tool"],
          name: "fixture-tool",
          payload: { digest: { algorithm: "sha256", sri: $digest }, file: "artifact.tar", format: "tar", sizeBytes: $size },
          platform: { abi: "musl", architecture: $architecture, os: "linux" },
          runtime: { inspectionContract: "elf-static/v1", kind: "self-contained" },
          schema: "buck-build-product/v1",
          semanticProvenance: { recipe: "fixture/v1", target: "//fixture:tool", toolchain: "fixture/v1" }
        }' > "$out/descriptor.json"
      '';

  staticElfProduct = mkElfProduct {
    name = "buck2-static-elf-product";
    cc = pkgs.pkgsStatic.stdenv.cc;
    static = true;
  };
  dynamicElfProduct = mkElfProduct {
    name = "buck2-dynamic-elf-product";
    cc = pkgs.stdenv.cc;
  };
  storeReferenceElfProduct =
    pkgs.runCommand "buck2-store-reference-elf-product"
      {
        nativeBuildInputs = [
          pkgs.pkgsStatic.stdenv.cc
          pkgs.gnutar
          pkgs.jq
          pkgs.openssl
        ];
      }
      ''
        mkdir -p payload/bin "$out"
        printf '%s\n' 'int main(void) { return 0; }' > fixture.c
        $CC -static fixture.c -o payload/bin/fixture-tool
        printf '%s\n' ${pkgs.hello} >> payload/bin/fixture-tool
        tar --create --format=gnu --sort=name --mtime=@1 --owner=0 --group=0 --numeric-owner \
          --file "$out/artifact.tar" --directory payload .
        digest="sha256-$(openssl dgst -sha256 -binary "$out/artifact.tar" | openssl base64 -A)"
        size="$(stat --format=%s "$out/artifact.tar")"
        jq -cn --arg digest "$digest" --argjson size "$size" \
          --arg architecture ${hostArchitecture} '{
          entrypoints: ["bin/fixture-tool"], name: "fixture-tool",
          payload: { digest: { algorithm: "sha256", sri: $digest }, file: "artifact.tar", format: "tar", sizeBytes: $size },
          platform: { abi: "musl", architecture: $architecture, os: "linux" },
          runtime: { inspectionContract: "elf-static/v1", kind: "self-contained" },
          schema: "buck-build-product/v1",
          semanticProvenance: { recipe: "fixture/v1", target: "//fixture:tool", toolchain: "fixture/v1" }
        }' > "$out/descriptor.json"
      '';

  importProduct =
    product: platform:
    let
      descriptor = builtins.fromJSON (builtins.readFile "${product}/descriptor.json");
    in
    importArtifact {
      inherit descriptor;
      expectedDescriptorDigest = (import ../buck2-build-product-contract.nix).descriptorDigest descriptor;
      expectedPlatform = platform;
      artifact = "${product}/artifact.tar";
    };
in
{
  inherit
    dynamicExport
    staticElfProduct
    failingVersionReadelf
    emptyVersionReadelf
    multilineInterpreterReadelf
    fixtureMachOOtool
    fixtureMachOLipo
    fatMachOLipo
    hostileMachOOtool
    ;
  staticElfImport = importProduct staticElfProduct {
    os = "linux";
    architecture = hostArchitecture;
    abi = "musl";
  };
  dynamicElfImport = importProduct dynamicElfProduct {
    os = "linux";
    architecture = hostArchitecture;
    abi = "musl";
  };
  storeReferenceElfImport = importProduct storeReferenceElfProduct {
    os = "linux";
    architecture = hostArchitecture;
    abi = "musl";
  };
  foreignArchitectureImport =
    let
      original = builtins.fromJSON (builtins.readFile "${staticElfProduct}/descriptor.json");
      foreignArchitecture = if hostArchitecture == "aarch64" then "x86_64" else "aarch64";
      descriptor = original // {
        platform = {
          os = "linux";
          architecture = foreignArchitecture;
          abi = "musl";
        };
      };
    in
    importArtifact {
      inherit descriptor;
      expectedDescriptorDigest = (import ../buck2-build-product-contract.nix).descriptorDigest descriptor;
      expectedPlatform = descriptor.platform;
      artifact = "${staticElfProduct}/artifact.tar";
    };

  mkImport =
    {
      descriptor,
      expectedDescriptorDigest,
      expectedPlatform,
      url ? null,
      artifact ? null,
    }:
    importArtifact {
      inherit
        artifact
        descriptor
        expectedDescriptorDigest
        expectedPlatform
        url
        ;
    };
}
