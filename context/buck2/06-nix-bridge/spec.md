# BuildProduct and Nix Import Spec

This document specifies `buck-build-product/v1` and independent Nix import. It
builds on [requirements.md](./requirements.md).

## Status

Draft.

## Scope

**Defines:** portable descriptor identity, payload checks, runtime inspection,
and the Nix store import result.

**Does not define:** transport, retention, publication, deployment, activation,
rollback, or health.

## Boundary

```text
Buck action
  -> artifact.tar + buck-build-product/v1 descriptor
       -> independent expected descriptor digest + platform
            -> strict Nix validation and runtime inspection
                 -> immutable Nix store result
```

Transport is an input mechanism only. Import accepts a declared local artifact
path or fetched bytes with the same expected digest; transport identity grants
no product authority.

## Descriptor

```json
{
  "schema": "buck-build-product/v1",
  "name": "fixture-tool",
  "entrypoints": ["bin/fixture-tool"],
  "payload": {
    "file": "artifact.tar",
    "format": "tar",
    "sizeBytes": 123,
    "digest": { "algorithm": "sha256", "sri": "sha256-...=" }
  },
  "platform": { "os": "linux", "architecture": "x86_64", "abi": "musl" },
  "runtime": { "kind": "self-contained", "inspectionContract": "elf-static/v1" },
  "semanticProvenance": {
    "target": "//fixtures:tool",
    "recipe": "fixture-tool/v1",
    "toolchain": "rust-linux-musl/v1"
  }
}
```

Every object uses exact fields. Descriptor identity is SHA-256 over canonical
JSON. Entry points and payload paths are normalized safe relative paths.
Runtime is a tagged union whose fields and inspection contract depend on
`kind`; acceptance of a descriptor kind does not imply an importer exists for
it.

## Strict JavaScript Specialization

`effect-utils/javascript-product/v2` is the strict platform-invariant
JavaScript specialization of this boundary. It carries one bundled module
instead of a tar payload. Its exact fields are:

```json
{
  "schema": "effect-utils/javascript-product/v2",
  "productName": "fixture-tool",
  "productKind": "cli",
  "modulePath": "fixture-tool.js",
  "sizeBytes": 123,
  "integrity": "sha256-...=",
  "platform": { "os": "any", "architecture": "any", "abi": "any" },
  "runtimeKind": "node",
  "runtimeContract": "javascript-esm",
  "runtimeContractVersion": "v1",
  "externalModules": [],
  "externalCapabilities": [],
  "target": "//fixtures:fixture-tool-candidate",
  "provenance": {
    "configuredTarget": "...",
    "dependencyClosureIdentity": "...",
    "module": "..."
  }
}
```

The `any` platform tuple is a positive claim of platform invariance. Acceptance
requires the same module and descriptor SHA-256 digests from Linux x86_64,
Linux ARM64, and Darwin ARM64 builds. A real Buck
`javascript_portable` target platform selects this tuple; the producer does not
substitute the host platform or omit platform configuration.

The independently tracked import expectation contains the descriptor SHA-256,
module SHA-256, product name, product kind, runtime contract, runtime contract
version, and exact external module and capability sets. Nix verifies all of
these fields, module size, module integrity, and a safe relative module path
before it produces the store result. Producer store paths and configured-target
hashes are provenance only and do not authorize import.

The producer leaves a platform-gated native package external. Nix grafts a
native package only when its package name and capability are present in both
the descriptor and the consumer's independent exact expectation. The importer
never invokes Buck or falls back to repository source.

The JavaScript module is copied read-only into the Nix result. The wrapper uses
only the declared runtime, exact native package links, explicit environment,
and explicit `PATH` packages.

## Import Sequence

1. Validate the exact descriptor schema and canonical descriptor digest.
2. Compare descriptor platform with the independently declared expected
   platform.
3. Obtain payload bytes from exactly one declared path or URL-backed Nix input.
4. Verify payload byte size and SHA-256 SRI digest.
5. Reject unsafe tar entries before extraction.
6. Extract without preserving archive ownership or permissions.
7. Reject unsafe extracted tree content.
8. Dispatch to the exact runtime inspector for the tagged runtime contract.
9. Make the imported tree read-only and expose descriptor identity as Nix
   passthrough metadata.

Every failed step terminates import. No step invokes Buck or a package manager.

## Conformance

The contract suite must include successful canonicalization/import and negative
mutations for unknown and missing fields, alternate digest encodings, unsafe
paths and archives, byte-size and digest mismatch, platform mismatch, runtime
descriptor mismatch, unsupported runtime kind, and inspector failure.

The JavaScript specialization additionally proves checkout- and scratch-path
independence, target-aware runtime builtins, realpath-closed hardlink
materialization, exact external module and capability sets, hostile module
paths, descriptor and module digest mismatch, size and integrity mismatch,
portable-platform enforcement, native-package exclusion, and byte identity on
all three supported platform triples.
