#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)}"
export BUCK2_BRIDGE_REPO="$repo_root"

contract_expr='repo = builtins.toPath (builtins.getEnv "BUCK2_BRIDGE_REPO");
  contract = import (repo + "/nix/workspace-tools/lib/buck2-build-product-contract.nix");
  valid = {
    schema = "buck-build-product/v1";
    name = "fixture-tool";
    platform = {
      os = "linux";
      architecture = "x86_64";
      abi = "musl";
    };
    payload = {
      file = "artifact.tar";
      format = "tar";
      digest = {
        algorithm = "sha256";
        sri = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      };
      sizeBytes = 123;
    };
    entrypoints = [ "bin/fixture-tool" ];
    runtime = {
      kind = "self-contained";
      inspectionContract = "elf-static/v1";
    };
    semanticProvenance = {
      target = "//fixtures:tool";
      recipe = "fixture-tool/v1";
      toolchain = "rust-linux-musl/v1";
    };
  };
  validMachO = valid // {
    platform = { os = "darwin"; architecture = "aarch64"; abi = "darwin"; };
    runtime = {
      kind = "mach-o-dynamic";
      inspectionContract = "mach-o-dynamic/v1";
      architecture = "arm64";
      minimumOs = "14.0";
      dylibs = [ "/usr/lib/libSystem.B.dylib" ];
      installNamePolicy = "system-only/v1";
      rpathPolicy = "empty/v1";
      signingPolicy = "adhoc/v1";
    };
  };'

eval_raw() {
  nix eval --impure --raw --expr "let $contract_expr in $1"
}

expect_eval_failure() {
  local label="$1"
  local expected="$2"
  local expression="$3"
  local log
  log="$(mktemp)"
  if eval_raw "$expression" >"$log" 2>&1; then
    echo "buck2-build-product-contract-test: expected $label to fail" >&2
    rm -f "$log"
    exit 1
  fi
  if ! grep -F "$expected" "$log" >/dev/null; then
    echo "buck2-build-product-contract-test: $label failed without expected diagnostic: $expected" >&2
    sed -n '1,160p' "$log" >&2
    rm -f "$log"
    exit 1
  fi
  rm -f "$log"
  echo "buck2-build-product-contract-test: RED $label"
}

canonical="$(eval_raw 'contract.canonicalDescriptorJson valid')"
[ "$canonical" = "$(eval_raw 'contract.canonicalDescriptorJson valid')" ]
expected_canonical='{"entrypoints":["bin/fixture-tool"],"name":"fixture-tool","payload":{"digest":{"algorithm":"sha256","sri":"sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"file":"artifact.tar","format":"tar","sizeBytes":123},"platform":{"abi":"musl","architecture":"x86_64","os":"linux"},"runtime":{"inspectionContract":"elf-static/v1","kind":"self-contained"},"schema":"buck-build-product/v1","semanticProvenance":{"recipe":"fixture-tool/v1","target":"//fixtures:tool","toolchain":"rust-linux-musl/v1"}}'
[ "$canonical" = "$expected_canonical" ] || {
  echo "buck2-build-product-contract-test: canonical descriptor bytes changed" >&2
  exit 1
}

descriptor_digest="$(eval_raw 'contract.descriptorDigest valid')"
[ "$descriptor_digest" = "sha256:920dafd10e3eb7c3d54a0ef6d80213a58ceac533019537cb9e7098177b72389d" ] || {
  echo "buck2-build-product-contract-test: canonical descriptor digest changed: $descriptor_digest" >&2
  exit 1
}

verified="$(eval_raw 'contract.canonicalDescriptorJson (contract.verifyDescriptor {
  descriptor = valid;
  expectedDescriptorDigest = contract.descriptorDigest valid;
})')"
[ "$verified" = "$canonical" ]

expect_eval_failure \
  "missing independent descriptor digest" \
  "expectedDescriptorDigest must be a sha256 digest" \
  'contract.canonicalDescriptorJson (contract.verifyDescriptor {
    descriptor = valid;
    expectedDescriptorDigest = "";
  })'

expect_eval_failure \
  "wrong independent descriptor digest" \
  "descriptor digest mismatch" \
  'contract.canonicalDescriptorJson (contract.verifyDescriptor {
    descriptor = valid;
    expectedDescriptorDigest = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  })'

expect_eval_failure \
  "unknown descriptor field" \
  "descriptor has unknown fields: surprise" \
  'contract.canonicalDescriptorJson (valid // { surprise = true; })'

expect_eval_failure \
  "unknown nested payload field" \
  "descriptor.payload has unknown fields: surprise" \
  'contract.canonicalDescriptorJson (valid // {
    payload = valid.payload // { surprise = true; };
  })'

expect_eval_failure \
  "unknown nested digest field" \
  "descriptor.payload.digest has unknown fields: surprise" \
  'contract.canonicalDescriptorJson (valid // {
    payload = valid.payload // {
      digest = valid.payload.digest // { surprise = true; };
    };
  })'

expect_eval_failure \
  "unknown nested platform field" \
  "descriptor.platform has unknown fields: surprise" \
  'contract.canonicalDescriptorJson (valid // {
    platform = valid.platform // { surprise = true; };
  })'

expect_eval_failure \
  "evidence provenance in semantic descriptor" \
  "descriptor has unknown fields: evidenceProvenance" \
  'contract.canonicalDescriptorJson (valid // {
    evidenceProvenance = { invocationId = "invocation-1"; };
  })'

expect_eval_failure \
  "action identity in semantic provenance" \
  "descriptor.semanticProvenance has unknown fields: actionDigest" \
  'contract.canonicalDescriptorJson (valid // {
    semanticProvenance = valid.semanticProvenance // { actionDigest = "action-1"; };
  })'

expect_eval_failure \
  "unknown runtime variant" \
  "unsupported runtime kind: wasm-magic" \
  'contract.canonicalDescriptorJson (valid // {
    runtime = { kind = "wasm-magic"; };
  })'

expect_eval_failure \
  "unknown runtime field" \
  "descriptor.runtime has unknown fields: assumedPortable" \
  'contract.canonicalDescriptorJson (valid // {
    runtime = valid.runtime // { assumedPortable = true; };
  })'

expect_eval_failure \
  "newline entrypoint" \
  "descriptor.entrypoints must be safe relative paths" \
  'contract.canonicalDescriptorJson (valid // {
    entrypoints = [ "bin/fixture\nunsafe" ];
  })'

expect_eval_failure \
  "carriage-return entrypoint" \
  "descriptor.entrypoints must be safe relative paths" \
  'contract.canonicalDescriptorJson (valid // {
    entrypoints = [ "bin/fixture\runsafe" ];
  })'

expect_eval_failure \
  "tab entrypoint" \
  "descriptor.entrypoints must be safe relative paths" \
  'contract.canonicalDescriptorJson (valid // {
    entrypoints = [ "bin/fixture\tunsafe" ];
  })'

expect_eval_failure \
  "escape entrypoint" \
  "descriptor.entrypoints must be safe relative paths" \
  'contract.canonicalDescriptorJson (valid // {
    entrypoints = [ (builtins.fromJSON "\"bin/fixture\\u001bunsafe\"") ];
  })'

expect_eval_failure \
  "non-canonical sha256 trailing digit" \
  "descriptor.payload.digest.sri must be a sha256 SRI digest" \
  'contract.canonicalDescriptorJson (valid // {
    payload = valid.payload // {
      digest = valid.payload.digest // {
        sri = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB=";
      };
    };
  })'

expect_eval_failure \
  "missing sha256 padding" \
  "descriptor.payload.digest.sri must be a sha256 SRI digest" \
  'contract.canonicalDescriptorJson (valid // {
    payload = valid.payload // {
      digest = valid.payload.digest // {
        sri = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      };
    };
  })'

expect_eval_failure \
  "sha256 digest of 31 bytes" \
  "descriptor.payload.digest.sri must be a sha256 SRI digest" \
  'contract.canonicalDescriptorJson (valid // {
    payload = valid.payload // {
      digest = valid.payload.digest // {
        sri = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
      };
    };
  })'

semantic_change_digest="$(eval_raw 'contract.descriptorDigest (valid // {
  semanticProvenance = valid.semanticProvenance // { recipe = "fixture-tool/v2"; };
})')"
[ "$semantic_change_digest" != "$descriptor_digest" ] || {
  echo "buck2-build-product-contract-test: semantic provenance did not change descriptor identity" >&2
  exit 1
}

expect_eval_failure \
  "duplicate entrypoint" \
  "descriptor.entrypoints entries must be unique" \
  'contract.canonicalDescriptorJson (valid // {
    entrypoints = [ "bin/fixture-tool" "bin/fixture-tool" ];
  })'

for variant in interpreter elf-dynamic elf-static mach-o-dynamic self-contained; do
  platform_override=''
  case "$variant" in
    interpreter)
      runtime='{ kind = "interpreter"; runtimeId = "bun"; runtimeContract = "bun-1.2/v1"; program = "bin/fixture-tool"; }'
      ;;
    elf-dynamic)
      runtime='{ kind = "elf-dynamic"; inspectionContract = "elf-dynamic/v1"; elfClass = "ELF64"; machine = "x86_64"; interpreter = "/lib64/ld-linux-x86-64.so.2"; neededLibraries = [ "libc.so.6" ]; symbolVersionFloors = [ "GLIBC_2.39" ]; rpathPolicy = "empty/v1"; }'
      platform_override='platform = valid.platform // { abi = "glibc"; };'
      ;;
    elf-static)
      runtime='{ kind = "elf-static"; inspectionContract = "elf-static/v1"; elfClass = "ELF64"; machine = "x86_64"; }'
      platform_override='platform = valid.platform // { abi = "glibc"; };'
      ;;
    mach-o-dynamic)
      runtime='{ kind = "mach-o-dynamic"; inspectionContract = "mach-o-dynamic/v1"; architecture = "arm64"; minimumOs = "14.0"; dylibs = [ "/usr/lib/libSystem.B.dylib" ]; installNamePolicy = "system-only/v1"; rpathPolicy = "empty/v1"; signingPolicy = "adhoc/v1"; }'
      platform_override='platform = { os = "darwin"; architecture = "aarch64"; abi = "darwin"; };'
      ;;
    self-contained)
      runtime='{ kind = "self-contained"; inspectionContract = "elf-static/v1"; }'
      ;;
  esac
  eval_raw "contract.descriptorDigest (valid // { $platform_override runtime = $runtime; })" >/dev/null
done

expect_eval_failure \
  "Mach-O runtime on Linux" \
  "mach-o-dynamic requires descriptor.platform.os = darwin" \
  'contract.descriptorDigest (valid // {
    runtime = {
      kind = "mach-o-dynamic";
      inspectionContract = "mach-o-dynamic/v1";
      architecture = "x86_64";
      minimumOs = "14.0";
      dylibs = [ "/usr/lib/libSystem.B.dylib" ];
      installNamePolicy = "system-only/v1";
      rpathPolicy = "empty/v1";
      signingPolicy = "adhoc/v1";
    };
  })'

expect_eval_failure \
  "Mach-O non-system install name" \
  "descriptor.runtime.dylibs must use system install names" \
  'contract.descriptorDigest (valid // {
    platform = { os = "darwin"; architecture = "aarch64"; abi = "darwin"; };
    runtime = {
      kind = "mach-o-dynamic";
      inspectionContract = "mach-o-dynamic/v1";
      architecture = "arm64";
      minimumOs = "14.0";
      dylibs = [ "@rpath/libprivate.dylib" ];
      installNamePolicy = "system-only/v1";
      rpathPolicy = "empty/v1";
      signingPolicy = "adhoc/v1";
    };
  })'

expect_eval_failure \
  "missing Mach-O inspection contract" \
  "descriptor.runtime is missing fields: inspectionContract" \
  'contract.descriptorDigest (validMachO // {
    runtime = builtins.removeAttrs validMachO.runtime [ "inspectionContract" ];
  })'

expect_eval_failure \
  "wrong Mach-O inspection contract" \
  "descriptor.runtime.inspectionContract must be mach-o-dynamic/v1" \
  'contract.descriptorDigest (validMachO // {
    runtime = validMachO.runtime // { inspectionContract = "mach-o-dynamic/v2"; };
  })'

expect_eval_failure \
  "unknown Mach-O runtime field" \
  "descriptor.runtime has unknown fields: universal" \
  'contract.descriptorDigest (validMachO // {
    runtime = validMachO.runtime // { universal = true; };
  })'

expect_eval_failure \
  "Mach-O ABI mismatch" \
  "mach-o-dynamic/v1 requires descriptor.platform.abi = darwin" \
  'contract.descriptorDigest (validMachO // {
    platform = validMachO.platform // { abi = "none"; };
  })'

expect_eval_failure \
  "Mach-O architecture mismatch" \
  "descriptor.runtime.architecture must match descriptor.platform.architecture" \
  'contract.descriptorDigest (validMachO // {
    runtime = validMachO.runtime // { architecture = "x86_64"; };
  })'

expect_eval_failure \
  "malformed Mach-O minimum OS" \
  "descriptor.runtime.minimumOs must be a canonical version" \
  'contract.descriptorDigest (validMachO // {
    runtime = validMachO.runtime // { minimumOs = "14"; };
  })'

expect_eval_failure \
  "unsorted Mach-O dylibs" \
  "descriptor.runtime.dylibs must be sorted" \
  'contract.descriptorDigest (validMachO // {
    runtime = validMachO.runtime // {
      dylibs = [ "/usr/lib/libz.dylib" "/usr/lib/libSystem.B.dylib" ];
    };
  })'

expect_eval_failure \
  "duplicate Mach-O dylib" \
  "descriptor.runtime.dylibs entries must be unique" \
  'contract.descriptorDigest (validMachO // {
    runtime = validMachO.runtime // {
      dylibs = [ "/usr/lib/libSystem.B.dylib" "/usr/lib/libSystem.B.dylib" ];
    };
  })'

expect_eval_failure \
  "Mach-O dylib control character" \
  "descriptor.runtime.dylibs entries must not contain control characters" \
  'contract.descriptorDigest (validMachO // {
    runtime = validMachO.runtime // { dylibs = [ "/usr/lib/libSystem.B.dylib\n" ]; };
  })'

expect_eval_failure \
  "Mach-O RPATH policy mismatch" \
  "descriptor.runtime.rpathPolicy must be empty/v1" \
  'contract.descriptorDigest (validMachO // {
    runtime = validMachO.runtime // { rpathPolicy = "declared/v1"; };
  })'

expect_eval_failure \
  "Mach-O signing policy mismatch" \
  "descriptor.runtime.signingPolicy must be adhoc/v1" \
  'contract.descriptorDigest (validMachO // {
    runtime = validMachO.runtime // { signingPolicy = "unsigned/v1"; };
  })'

expect_eval_failure \
  "missing ELF inspection contract" \
  "descriptor.runtime is missing fields: inspectionContract" \
  'contract.descriptorDigest (valid // {
    runtime = {
      kind = "elf-dynamic";
      elfClass = "ELF64";
      machine = "x86_64";
      interpreter = "/lib64/ld-linux-x86-64.so.2";
      neededLibraries = [ "libc.so.6" ];
      symbolVersionFloors = [ "GLIBC_2.39" ];
      rpathPolicy = "empty/v1";
    };
  })'

expect_eval_failure \
  "legacy ELF runtime field" \
  "descriptor.runtime has unknown fields: loaderClass" \
  'contract.descriptorDigest (valid // {
    runtime = {
      kind = "elf-dynamic";
      inspectionContract = "elf-dynamic/v1";
      elfClass = "ELF64";
      machine = "x86_64";
      interpreter = "/lib64/ld-linux-x86-64.so.2";
      neededLibraries = [ "libc.so.6" ];
      symbolVersionFloors = [ "GLIBC_2.39" ];
      rpathPolicy = "empty/v1";
      loaderClass = "glibc";
    };
  })'

expect_eval_failure \
  "ELF machine and platform architecture mismatch" \
  "descriptor.runtime.machine must match descriptor.platform.architecture" \
  'contract.descriptorDigest (valid // {
    platform = valid.platform // { abi = "glibc"; };
    runtime = {
      kind = "elf-dynamic";
      inspectionContract = "elf-dynamic/v1";
      elfClass = "ELF64";
      machine = "aarch64";
      interpreter = "/lib/ld-linux-aarch64.so.1";
      neededLibraries = [ "libc.so.6" ];
      symbolVersionFloors = [ "GLIBC_2.39" ];
      rpathPolicy = "empty/v1";
    };
  })'

expect_eval_failure \
  "static ELF machine and platform architecture mismatch" \
  "descriptor.runtime.machine must match descriptor.platform.architecture" \
  'contract.descriptorDigest (valid // {
    platform = valid.platform // { abi = "glibc"; };
    runtime = {
      kind = "elf-static";
      inspectionContract = "elf-static/v1";
      elfClass = "ELF64";
      machine = "aarch64";
    };
  })'

expect_eval_failure \
  "static ELF on a non-Linux platform" \
  "elf-static requires descriptor.platform.os = linux" \
  'contract.descriptorDigest (valid // {
    platform = { os = "darwin"; architecture = "x86_64"; abi = "glibc"; };
    runtime = {
      kind = "elf-static";
      inspectionContract = "elf-static/v1";
      elfClass = "ELF64";
      machine = "x86_64";
    };
  })'

expect_eval_failure \
  "dynamic ELF on a non-Linux platform" \
  "elf-dynamic requires descriptor.platform.os = linux" \
  'contract.descriptorDigest (valid // {
    platform = valid.platform // { os = "darwin"; abi = "glibc"; };
    runtime = {
      kind = "elf-dynamic";
      inspectionContract = "elf-dynamic/v1";
      elfClass = "ELF64";
      machine = "x86_64";
      interpreter = "/lib64/ld-linux-x86-64.so.2";
      neededLibraries = [ "libc.so.6" ];
      symbolVersionFloors = [ "GLIBC_2.39" ];
      rpathPolicy = "empty/v1";
    };
  })'

expect_eval_failure \
  "dynamic ELF ABI mismatch" \
  "currently requires descriptor.platform.abi = glibc" \
  'contract.descriptorDigest (valid // {
    runtime = {
      kind = "elf-dynamic";
      inspectionContract = "elf-dynamic/v1";
      elfClass = "ELF64";
      machine = "x86_64";
      interpreter = "/lib64/ld-linux-x86-64.so.2";
      neededLibraries = [ "libc.so.6" ];
      symbolVersionFloors = [ "GLIBC_2.39" ];
      rpathPolicy = "empty/v1";
    };
  })'

expect_eval_failure \
  "dynamic ELF loader and ABI mismatch" \
  "interpreter does not prove the declared glibc architecture" \
  'contract.descriptorDigest (valid // {
    platform = valid.platform // { abi = "glibc"; };
    runtime = {
      kind = "elf-dynamic";
      inspectionContract = "elf-dynamic/v1";
      elfClass = "ELF64";
      machine = "x86_64";
      interpreter = "/lib/ld-musl-x86_64.so.1";
      neededLibraries = [ "libc.so" ];
      symbolVersionFloors = [ ];
      rpathPolicy = "empty/v1";
    };
  })'

for field in neededLibraries symbolVersionFloors; do
  expect_eval_failure \
    "dynamic ELF $field control character" \
    "descriptor.runtime.$field entries must not contain control characters" \
    "contract.descriptorDigest (valid // {
      platform = valid.platform // { abi = \"glibc\"; };
      runtime = {
        kind = \"elf-dynamic\";
        inspectionContract = \"elf-dynamic/v1\";
        elfClass = \"ELF64\";
        machine = \"x86_64\";
        interpreter = \"/lib64/ld-linux-x86-64.so.2\";
        neededLibraries = if \"$field\" == \"neededLibraries\" then [ \"libone.so\\nlibtwo.so\" ] else [ \"libc.so.6\" ];
        symbolVersionFloors = if \"$field\" == \"symbolVersionFloors\" then [ \"GLIBC_2.34\\nGLIBC_2.35\" ] else [ \"GLIBC_2.39\" ];
        rpathPolicy = \"empty/v1\";
      };
    })"
done

echo "buck2-build-product-contract-test: PASS digest=$descriptor_digest"
