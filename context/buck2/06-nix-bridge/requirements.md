# Nix Bridge Requirements

This subsystem owns the only shared Buck-to-system boundary: a portable
`BuildProduct` and independent Nix import. It refines BUCK-R03 and BUCK-R10.
(Formerly 04-artifact-system-bridge; content carried forward.)

## Assumptions

- **BRIDGE-A01 Buck product authority:** Buck produces normalized payload bytes
  and the descriptor that binds them.
- **BRIDGE-A02 Nix expectation authority:** The Nix consumer supplies the
  expected descriptor digest and target-platform constraints independently.

## Acceptable Tradeoffs

- **BRIDGE-T01 Narrow runtime admission:** Import may support fewer tagged
  runtime contracts than the descriptor vocabulary; unknown or uninspected
  runtime kinds fail closed.

## Requirements

### Must define a portable product

- **BRIDGE-R01 Exact descriptor:** The descriptor uses a versioned, exact-field
  schema and canonical encoding.
- **BRIDGE-R02 Byte binding:** The descriptor binds payload digest, size,
  format, and safe relative entrypoints.
- **BRIDGE-R03 Compatibility binding:** The descriptor binds target OS,
  architecture, ABI, tagged runtime contract, toolchain, recipe, and Buck
  target.
- **BRIDGE-R04 No live state:** The descriptor contains no registry,
  deployment, activation, rollback, health, fleet, or secret state
  ([decision 0008](../.decisions/0008-untrusted-oci-and-offline-nix-authority.md)).

### Must import independently

- **BRIDGE-R05 Independent expectation:** Import requires an expected
  descriptor digest and expected platform not obtained by trusting the payload.
- **BRIDGE-R06 Strict validation:** Import rejects unknown fields, missing
  fields, unsafe paths, unsupported runtime contracts, digest or size mismatch,
  platform mismatch, and unsafe archive contents.
- **BRIDGE-R07 Runtime inspection:** Import inspects the extracted runtime
  against the descriptor before producing a Nix store result.
- **BRIDGE-R08 No source fallback:** Import failure must not invoke Buck or
  rebuild repository sources.
- **BRIDGE-R09 Immutable result:** Successful import produces a read-only Nix
  store result containing only verified product content.
