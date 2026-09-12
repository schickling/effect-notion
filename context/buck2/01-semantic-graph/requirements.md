# Semantic Graph Requirements

This subsystem owns how authored intent — genie-composed package models,
manifests, and lockfiles — becomes the projected Buck graph. It refines
BUCK-R01 and BUCK-R05. It absorbs the former authoring-bindings and
buck-projection sub-subsystems; language-specific binding detail lives in the
[spec](./spec.md).

## Assumptions

- **GRAPH-A01 Native metadata:** Ecosystem manifests and lockfiles remain
  authoritative for the facts their ecosystems own; bindings preserve them
  rather than re-resolve them.
- **GRAPH-A02 Genie lifecycle:** Discovery, read-only output modes, and
  freshness reporting satisfy Genie's root VRS.

## Acceptable Tradeoffs

- **GRAPH-T01 Generated projection:** Committed generated Buck configuration is
  acceptable when freshness and byte determinism are enforced.
- **GRAPH-T02 Fail-closed bindings:** A language binding may reject valid
  ecosystem features whose graph meaning is unproved, naming the unsupported
  fact rather than approximating it.

## Requirements

- **GRAPH-R01 Composed model authority:** Package, project, operation, test,
  artifact, and dependency intent is authored once in the typed composed model;
  projections consume it and never reconstruct facts from generated files
  ([decision 0002](../.decisions/0002-semantic-model-and-generated-shards.md)).
- **GRAPH-R02 Dependency roots:** Operations reference canonical dependency
  declarations through immutable field-qualified structural handles; role-wide
  selection and flat alias identity are insufficient
  ([decision 0005](../.decisions/0005-operation-dependency-roots.md)).
- **GRAPH-R03 Stable identity:** Package, operation, and dependency identities
  are stable across worktree locations, composition shapes, and adapter
  implementation languages.
- **GRAPH-R04 Deterministic locality:** Equal semantic input produces
  byte-identical projections; a local change rewrites only its owning
  package-local shard and invalidates only operations whose declared graph
  input changed.
- **GRAPH-R05 Freshness gate:** CI fails when generated projection bytes do not
  equal a clean regeneration from their declared sources; regeneration performs
  no compilation, installation, or tool discovery.
- **GRAPH-R06 Complete ownership:** Every source consumed by an admitted
  operation has one declared role and owner, validated by the stateless census
  ([decision 0004](../.decisions/0004-stateless-owned-file-assertion.md));
  overlaps and unowned sources fail.
- **GRAPH-R07 Composition projection:** The projection emits the synthesized
  composition root — cell declarations, canonical mounts, platform wiring —
  under the discipline of [05-composition](../05-composition/requirements.md).
- **GRAPH-R08 No private facts in shared schema:** Shared graph schemas and
  rule facades carry no physical tool paths, private topology, or
  repository-private labels (BUCK-R14).
  Horizontal authoring bindings keep those facts out of shared schemas
  ([decision 0006](../.decisions/0006-horizontal-authoring-bindings.md)).
