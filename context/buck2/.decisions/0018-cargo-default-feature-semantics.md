# 0018 Cargo Default-Feature Semantics

Status: accepted

Implementation: `rust/buck2-tools/core/cargo-buck2-package-projection.ts`.

## Context

Cargo dependency requests enable default features unless the authoritative
manifest disables them.

## Evidence and Argument

Requiring every repository operation to repeat the
complete feature set would create a second feature authority and make ordinary
Cargo changes easy to miss.

## Options

| Option                                                       | Result   | Tradeoff                                                                  |
| ------------------------------------------------------------ | -------- | ------------------------------------------------------------------------- |
| Inherit Cargo defaults and normalize the effective selection | Selected | Preserves Cargo authority while keeping feature-sensitive action identity |
| Require each operation to enumerate all active features      | Rejected | Makes operation overlays self-contained but duplicates manifest semantics |

## Decision

Operations inherit Cargo's default-feature semantics unless the authoritative
dependency request explicitly disables or replaces them. The resolver join
normalizes the effective feature selection into operation identity so changes
that affect compilation invalidate the operation without copying feature lists
into the repository overlay.

## Consequences

- The overlay references dependency declarations rather than restating Cargo
  defaults or complete feature sets.
- Resolver evidence must account for another edge re-enabling features.
- Raw authored feature lists are insufficient as action identity; the effective
  operation/platform selection is required.
