# Nix Bridge Requirements

This subsystem owns the only shared Buck-to-system boundary: a portable
`BuildProduct` and independent Nix import. It refines BUCK-R03 and BUCK-R10.
(Formerly 04-artifact-system-bridge; content carried forward.)

## Assumptions

- **BRIDGE-A01 Buck product authority:** Buck produces normalized payload bytes
  and the descriptor that binds them.
- **BRIDGE-A02 Nix expectation authority:** The Nix consumer supplies the
  expected descriptor digest and target-platform constraints independently.
- **BRIDGE-A03 Portable JavaScript meaning:** The platform tuple
  `{ os = "any"; architecture = "any"; abi = "any"; }` means that the exact
  JavaScript module bytes are verified across every supported platform. It does
  not mean that platform compatibility is unknown.

## Acceptable Tradeoffs

- **BRIDGE-T01 Narrow runtime admission:** Import may support fewer tagged
  runtime contracts than the descriptor vocabulary; unknown or uninspected
  runtime kinds fail closed.

## Requirements

### Must define a portable product

- **BRIDGE-R01 Exact descriptor:** The descriptor uses a versioned, exact-field
  schema and canonical encoding.
- **BRIDGE-R02 Byte binding:** An archive descriptor binds payload digest,
  size, format, and safe relative entrypoints. A strict JavaScript descriptor
  binds module SHA-256 integrity, size, safe relative module path, and tagged
  module runtime contract.
- **BRIDGE-R03 Compatibility binding:** A platform-bound archive descriptor
  binds target OS, architecture, ABI, tagged runtime contract, toolchain,
  recipe, and Buck target. A strict platform-invariant JavaScript descriptor
  binds the portable `any` tuple defined by BRIDGE-A03, runtime kind, runtime
  contract, configured Buck target, module target, and dependency-closure
  provenance.
- **BRIDGE-R04 No live state:** The descriptor contains no registry,
  deployment, activation, rollback, health, fleet, or secret state.

### Must import independently

- **BRIDGE-R05 Independent expectation:** Import requires an expected
  descriptor digest and expected platform contract not obtained by trusting the
  payload. The strict JavaScript specialization also requires the expected
  module digest and exact external module and capability sets.
- **BRIDGE-R06 Strict validation:** Import rejects unknown fields, missing
  fields, unsafe paths, unsupported runtime contracts, digest or size mismatch,
  platform-contract mismatch, undeclared or surplus external dependencies, and
  unsafe archive contents.
- **BRIDGE-R07 Runtime inspection:** Import inspects the extracted runtime
  against the descriptor before producing a Nix store result.
- **BRIDGE-R08 No source fallback:** Import failure must not invoke Buck or
  rebuild repository sources.
- **BRIDGE-R09 Immutable result:** Successful import produces a read-only Nix
  store result containing only verified product content.
- **BRIDGE-R10 Strict JavaScript payload:** A portable JavaScript product is one
  bundled module with an exact runtime kind, runtime contract, product kind,
  product name, entry path, byte size, SHA-256 integrity, external module set,
  and external capability set.
- **BRIDGE-R11 Native dependency boundary:** Platform-gated native packages stay
  external to a portable JavaScript module. The Nix consumer grafts only the
  exact independently declared external modules and capabilities.
- **BRIDGE-R12 Cross-platform proof:** Acceptance of a portable JavaScript
  product requires byte-identical module and descriptor output on Linux
  x86_64, Linux ARM64, and Darwin ARM64.
