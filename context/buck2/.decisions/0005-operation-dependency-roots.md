# 0005 Operation Dependency Roots

Status: accepted

## Context

Each build operation needs the direct dependency requests it can observe, but
package manifests and ecosystem resolvers already own dependency declarations
and selected topology. Role-wide selection over-invalidates operations, while
separate resolver manifests duplicate request authority.

The existing TypeScript Genie composition can expose exact declarations, but
its emitted dependency maps erase provenance and sometimes widen keys to
`string`. Genie may also evaluate imported generator modules more than once.

## Evidence and Argument

The retained TypeScript investigation
([evidence](../.experiments/2026-08-12-genie-dependency-ssot-prototypes.md))
compared operation references, named root sets, reverse applicability, typed
facet reuse, and structured-output extraction. Operation-to-handle references
preserved exact roots and same-role differences with one-declaration rename
locality; role-only selection over-selected, while reverse applicability
increased rename fanout. The typed-facet prototype passed strict TypeScript,
direct reuse, byte-stability, and package-local isolation controls, although
the initial disposable fixture was not retained as admission evidence.

Repository-scale probes found rootable-field alias collisions in 9 of 36
generated manifests, proving that a flat alias identity is insufficient. Type
scale remained bounded when normalization erased generic handle unions, while
leaking those unions produced a 37.9 MB declaration and used 1.54 GB. Lifecycle
probes also observed repeated Genie evaluation, ruling out object identity,
mutable registries, and import-time registration. Together these results
support immutable field-qualified structural handles carried by the existing
non-emitted metadata channel.

The Rust investigation
([evidence](../.experiments/2026-08-12-rust-dependency-ssot-investigation.md))
established only that authored `Cargo.toml` is the request authority and that
Cargo metadata can preserve relevant request facts. Workspace inheritance,
Reindeer aliases, features, platform conditions, and finer-than-Cargo target
precision remain unproved. The accepted decision is therefore normative for
the shared operation-reference direction and the TypeScript binding; it
explicitly defers the Rust binding mechanics.

## Options

| Dimension             | Option                                                 | Tradeoff                                                                     | Outcome                                                   |
| --------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| Use-edge direction    | Operations reference canonical dependency declarations | Exact and rename-local; repeats only the irreducible use edge                | Accepted                                                  |
| Use-edge direction    | Shared named root sets                                 | Less authoring repetition, but creates indirection and coupled supersets     | Rejected as authority; allowed only as pre-identity sugar |
| Use-edge direction    | Separate resolver manifests                            | Ecosystem-native, but duplicates dependency-request authority                | Rejected                                                  |
| TypeScript reuse seam | Typed semantic facet in existing Genie composition     | Preserves provenance and alias types without repeating dependency data       | Accepted                                                  |
| TypeScript reuse seam | Extract current structured output                      | Byte-compatible, but widened keys and lost provenance make it migration-only | Rejected as the long-term API                             |
| TypeScript reuse seam | Dependencies name consuming operations                 | Exact form increases rename fanout; role form is inexact                     | Rejected                                                  |

## Decision

Semantic operations reference canonical package dependency declarations. For
TypeScript, `catalog.compose` produces immutable, field-qualified, branded
handles in the existing non-emitted `GenieOutput.meta` channel before emitted
maps widen. `package.json.genie.ts` remains the dependency SSOT and default
manifest projection. `BUCK.genie.ts` owns operations and imports only that
narrow facet.

Handles use stable value identity and contain package scope, manifest field,
alias, external/workspace provenance, and logical first-party identity. They do
not contain selected versions, resolver contexts, paths, or private topology.
Operation normalization resolves each structural value against the owning
package's canonical declarations, sorts and deduplicates roots, and erases
generic types into stable semantic IR. Only dependency fields with defined
resolver-root semantics produce handles; peer dependencies do not. The brand
is compile-time authoring safety, not runtime identity or a security boundary.

## Consequences

- Dependency requests, versions, workspace identity, and resolver data remain
  authored once.
- An operation repeats only the irreducible edge to a dependency declaration.
- Field qualification prevents collisions between dependencies and
  devDependencies.
- Pure value semantics and one-way imports make repeated Genie evaluation
  observationally equivalent and avoid projection cycles.
- Named shared root sets may be syntax sugar only if expanded before semantic
  identity. Output-data extraction remains migration-only.
- Rust retains authored Cargo manifests as request authority. Buck/Reindeer now resolves and builds
  those requests without introducing a second dependency schema.
