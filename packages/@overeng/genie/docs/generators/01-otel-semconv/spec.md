# Semantic Conventions — Specification

This document specifies the semantic-conventions subsystem of `@overeng/genie`. It
builds on [requirements.md](./requirements.md).

## Status

Active — implemented and landed. The registry (`genie/weaver-registry/`), the Layer-2
`weaver` builder family, the composition aggregator, and the Weaver gate are in the tree;
~14 first-party namespaces are migrated onto the derived catalog. Weaver is pinned via the
from-source flake `nix/weaver-flake/` (**v0.24.2**, the version of record; behaviour was also
exercised on `nixpkgs#weaver` 0.23.0 — 0.24.2 additionally requires `stability` on every enum
member). Non-normative validation evidence is in
[.experiments/](./.experiments/2026-07-01-weaver-feasibility.md) (dated feasibility + e2e
slices, kept as the historical trail).

## Scope

Defines: the TS registry DSL (catalog + signals), the composition model, the Weaver
`groups:` YAML projection, the three-layer validation model, the Weaver gate wiring, and
the otel-contract conformance mechanism.

Does not define: the _semantic contract_ (attribute meaning, privacy/metric-label
policy, a consumer's own vendor namespace) — owned separately by each downstream consumer
(private). The runtime encoder internals — owned by `@overeng/otel-contract`. Dashboard /
trace query surfaces — owned by the consumer's observability stack.

## Architecture

Full SSOT chain, layering (Layer-2 home), and composition hierarchy:
[.decisions/0006](./.decisions/0006-ssot-chain-and-layering.md). Summary:

```
 AUTHORED (only facts):  attribute = annotated Effect Schema (otel + weaver meta)
                         signal    = attribute refs + per-ref requirement level
        │
 DERIVED:  ├─ runtime encoder / product APIs   (otel-contract `.`, OtelAttrs.define)   [runtime]
           └─ registry fragment                (otel-contract `./registry` projector)  [design-time]
                 └─ genie L1 (dep-free) ──► Weaver YAML → check/diff/live-check (additive gate)
                                        ──► TS constants / Rust bindings
                 └─ bridge OTTL (from `bridge:` annotation, 0004)

 namespace + catalog are DERIVED (from key prefix / signal refs), not authored (0006).
```

Layers, each depending only downward: **L2** `@overeng/otel-contract` `.` (runtime authoring
SSOT) + `./registry` (design-time projector); **L1** `@overeng/genie` `src/runtime/weaver`
(dep-free render); composed by per-package `*.contract.ts` seam files + the root aggregator
`genie/weaver-registry/registry.ts` (which the sibling `*.genie.ts` emitters import). The
runtime seam is _derived_, not separately authored (SC-R13/R14); upstream OTel semconv is a
manifest `dependency` first-party signals `ref` (SC-R06). Weaver's Jinja codegen is available
but non-load-bearing (SC-T01) — genie L1 renders bindings directly.

## Effect-Schema conventions — Layer 2

Layer 2 is Effect-Schema-based, so it follows our Effect conventions; Layer 1 is deliberately
effect-free (genie's dep-free runtime), so it uses plain typed data (below), not Schema.

- **Rich schema types, not primitives:** `attr.enum` → `Schema.Literal(...)`; `attr.template`
  → `Schema.TemplateLiteral(...)`; attribute keys use otel-contract's branded
  `OtelAttributeKey`/`OtelMetricName`/`OtelSpanName`; sensitive attrs `Schema.Redacted`.
- **Hierarchical `identifier` annotations** on every attribute Schema (the `Otel.*`
  convention otel-contract already uses), alongside the otel + weaver metadata annotations.
- **Author-time validation raises `Schema.TaggedError`s with context** — not plain `throw`:
  stray-namespace-key, dangling-ref, duplicate-namespace, missing-annotation, unmarked-foreign
  ref each get a tagged error; genuinely-impossible states use `Effect.die` (defects).
- **Type extraction** via `typeof X.Type`; decode any untrusted input through the Schema.

## Registry data model — Layer 1 (SC-R01, SC-R02, SC-R03)

Layer 1 mirrors Weaver's define-once/ref split as plain typed data (effect-free). A
**fragment** is one member's slice.

```ts
type RegistryFragment = {
  namespace: string // "restate" → registry.restate group
  memberPath: string // provenance (meta.workspace.memberPath)
  displayName: string
  attributes: AttrDef[] // DEFINE-once catalog (registry.<ns>)
  signals: SignalDef[] // spans/metrics/events that REF the catalog
}

type AttrDef = {
  id: string // must start with `${namespace}.`
  type: AttrType // 'string'|'int'|'double'|'boolean'|'string[]'
  //   | { members: EnumMember[] } | `template[${string}]`
  brief: string
  stability: 'stable' | 'development' // NOTE: 'deprecated' is NOT a stability
  examples?: (string | number | boolean)[] // REQUIRED for string attrs (weaver --future)
  note?: string
  deprecated?: Deprecated // orthogonal to stability (see below)
  // otel-contract policy, carried as weaver annotations (SC-R13):
  cardinality?: 'low' | 'bounded' | 'high'
  encode?: 'auto' | 'string' | 'number' | 'boolean' | 'json' | 'drop' | 'redacted'
}

type Deprecated =
  // weaver 0.23 STRUCTURED form (string removed)
  | { reason: 'renamed'; renamed_to: string }
  | { reason: 'obsoleted' | 'uncategorized'; note: string }

type AttrRef = {
  // signals reference, never inline-define
  ref: string
  requirement_level?:
    | 'required'
    | 'recommended'
    | 'opt_in'
    | { conditionally_required: string }
    | { recommended: string }
  sampling_relevant?: boolean
  note?: string
}
```

**Weaver-vocabulary fidelity (see [.decisions/0001](./.decisions/0001-ts-first-weaver-additive.md)):**

| Concept                   | Weaver 0.23 shape                                       | Note                                                          |
| ------------------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| enum                      | `type: { members: [{id,value,brief,stability}] }`       | **each member requires `stability` in 0.24.2** (0.23 did not) |
| template                  | `type: template[string[]]`                              | dynamic-key attrs                                             |
| requirement (conditional) | `requirement_level: { conditionally_required: <text> }` | object form                                                   |
| deprecation               | `deprecated: { reason, renamed_to \| note }`            | **string form removed**                                       |
| stability                 | `stable` \| `development`                               | `deprecated` **removed** from enum                            |
| string examples           | `examples: [...]`                                       | **required** under `--future`                                 |

Limitation: an attribute has exactly ONE `type`; **multi-type attributes are not supported**
(weaver is one-type-per-attr) — noted, not a blocker (revisit if a real need appears).

**otel-contract policy → Weaver annotations.** `cardinality`/`encode` are emitted under a
namespaced `annotations.<policy>.{cardinality,encode}` block — non-normative to upstream
Weaver, machine-readable for the conformance + metric-label gates. Richer policy enums a
consumer may layer on (finer cardinality tiers, privacy classes, metric-label policy) map
the same way, without forking Weaver's schema.

## Genie builder & emit (SC-R05)

Emit is a Layer-2 `weaver` builder family over one composed bundle. The design-time
aggregator (`genie/weaver-registry/registry.ts`) imports every member seam, projects each to
a Layer-1 fragment, composes them via `@overeng/genie` `./composition` into a
`WeaverRegistryBundle` (the resolved `Registry`, the three split provenance fingerprints, and
the whole-registry integrity issues), and exports it as `weaver`. Each output `.genie.ts` is a
one-liner over that bundle:

```ts
// manifest.yaml.genie.ts   — also surfaces namespace-collision / dangling-ref issues via validate
export default weaverManifest(weaver)
// attributes.yaml.genie.ts — ALL namespaces' DEFINE-once catalogs collapsed into ONE file
export default weaverAttributes(weaver)
// signals.yaml.genie.ts
export default weaverSignals(weaver)
// constants.ts.genie.ts / constants.rs.genie.ts
export default weaverTsConstants(weaver) // and weaverRustConstants(weaver)
```

The family — `weaverManifest` / `weaverAttributes` / `weaverSignals` / `weaverTsConstants` /
`weaverRustConstants` — lives in `@overeng/genie` `src/runtime/weaver`. Each emitter serializes
structured objects through a real YAML encoder (sorted keys, structural serialization — never
hand-built indented strings), following the `github-workflow` builder's structured-YAML
pattern. Output layout under `genie/weaver-registry/`: `manifest.yaml`, a **single collapsed
`attributes.yaml`** (Weaver accepts multiple `attribute_group` entries per file, so every
namespace's catalog lives in one file — adding a namespace needs NO new `.genie.ts`),
`signals.yaml`, `constants.ts`, `constants.rs`.

## Composition (SC-R07, SC-R08, SC-R09)

Mirrors `package.json.aggregateFromPackages` / `workspace-graph.ts`:

```ts
// root genie/weaver-registry/registry.ts
import restateContract from '<pkg>/restate.contract.ts'
import notionMdContract from '<pkg>/notion-md.contract.ts'
const members = [restateContract, notionMdContract /* … */] as const // direct-import seam graph
export const weaver = registryFromMembers({ members, name: 'acme-effect-utils' /* + provenance */ })
```

Each member seam is a `defineOtelContract({ signals, docOnlyAttributes? })`;
`registryFromMembers` projects each to a fragment (via otel-contract's `./registry`) and is a
`@overeng/genie/composition`-style, filesystem-free projector:

1. collect fragments, sort by namespace (deterministic).
2. **namespace uniqueness** — reject two members claiming `registry.<ns>` (SC-R09).
3. **global ref integrity** — every first-party signal `ref` must resolve to a defined
   attribute across ALL fragments; dangling refs fail (SC-R09). This catches a cross-member
   dangling ref the per-member check cannot. Upstream (`http.*`) refs resolve later, at
   `weaver registry check`, against the pinned semconv FOD (SC-A03).
4. emit the registry dir deterministically.

Public members declare generic namespaces; a private downstream consumer declares its own
vendor namespace. Aggregation spans the megarepo boundary (the downstream registry composes
the public fragments), following the megarepo alignment propagation order.

## Three-layer validation model

```
1. per-member author-time  (fast, PARTIAL)   namespacing, local well-formedness,
   assertFragmentWellFormed                    string-needs-examples. CANNOT check
                                               cross-member refs.
2. aggregation             (whole-registry)   ref integrity, namespace uniqueness.
   registryFromMembers                         Catches dangling cross-member refs.
3. weaver                  (AUTHORITATIVE)     schema, Rego policy, diff compat,
   check/diff/live-check                        live-check. Non-load-bearing gate.
```

## Weaver gate wiring (SC-R10, SC-R11, SC-R12)

- **check (SC-R10):** devenv task `weaver:check` → `weaver registry check -r <dir> --future`,
  wired into `check:all` and CI. Weaver is pinned via the from-source flake `nix/weaver-flake/`
  (v0.24.2), NOT `nixpkgs#weaver`; the upstream semconv is pinned to a Weaver-compatible
  `@vX.Y.Z[model]` tag (v1.37.0 clean under `--future` with 0.23/0.24; ≤v1.36 fail on their own
  unstructured-deprecated). The gate resolves the upstream dependency **hermetically** against a
  local Nix FOD (`nix/weaver-flake#semconv-model`): it copies the emitted YAML to a scratch dir
  and rewrites the committed portable git-URL `registry_path` to the local FOD path, so check is
  offline/deterministic (SC-A03). **Block-vs-degrade contract:** a weaver _validation_ failure
  (check/diff/live-check exits nonzero) blocks; weaver _unavailability_ (flake build/eval
  failure, binary missing) degrades to a warning in a separate lane and must NOT wedge unrelated
  work (GEN-R09) — the flake build is lane-separated from the validation.
- **Fidelity coverage:** the gate runs against the _actually emitted_ registry (not a separate
  fixture) and exercises each fidelity delta with a dedicated attribute
  (`deprecated:{reason:renamed}`, a multi-member enum with per-member `stability`, a
  `template[...]`, a conditionally-required ref), so the pinned Weaver version is checked against
  the real emitted shape.
- **diff (SC-R11):** on PRs, `weaver registry diff --baseline-registry <merge-base registry>
--format json` gates telemetry evolution. `weaver registry diff` **exits 0 even for breaking
  changes**, so the gate is JSON-payload based: it blocks on `changes.*[].type == "removed"`
  (plus a separate block on diff exit-nonzero — a removed-but-still-referenced attribute trips an
  unresolved-ref). A rename recorded weaver-native — old key retained + `deprecated:
{ reason: renamed, renamed_to }` — surfaces as `type: "renamed"` and passes; that
  representation is why the gate needs no custom rename logic
  ([.decisions/0009](./.decisions/0009-weaver-native-rename-representation.md)). The baseline is
  the `origin/main`..`HEAD` merge-base (not tip-of-main), materialized offline via git with the
  upstream held constant, so the diff reflects only first-party change; it degrades (exit 0) when
  git/ref/merge-base is absent or the registry did not exist on the baseline. Richer Rego
  evolution policies (stability regressions, requirement-level tightening) are a follow-up.
- **live-check (SC-R12):** in e2e tests, capture emitted OTLP and feed `weaver registry
live-check --input-source <file|otlp>`; validates types/units/enum/required/coverage
  against the registry. Any OTLP exporter (incl. the test-capture harness) suffices. In the
  fleet, telemetry flows OTLP → a central OTel Collector → the metrics/traces backends; that
  Collector is also where the metric-label migration bridge runs, when used
  ([.decisions/0004](./.decisions/0004-metric-label-migration.md)). `weaver registry resolve`
  is deprecated in 0.23/0.24 — prefer `generate`/`package`.

## Runtime derivation: the catalog atop otel-contract (SC-R13, SC-R14)

The catalog is authored once and the runtime encoder is DERIVED from it. A catalog entry
wraps a real `@overeng/otel-contract` primitive (so encode/brand/decode-at-edge is
otel-contract's own code), plus design-time metadata for weaver:

```ts
const RestateService = attr.string({
  key: 'restate.service',
  cardinality: 'bounded',
  brief,
  stability,
  examples,
}) // .schema IS OtelAttr.string(...)

const RestateAttempt = span({
  id: 'span.restate.attempt',
  kind,
  brief,
  stability,
  attributes: {
    service: required(RestateService),
    objectKey: conditionally({ attr: RestateObjectKey, text: '…' }),
  },
})
// → RestateAttempt.encoder = OtelAttrs.defineSync(structOf(refs))   // runtime, unchanged
// → RestateAttempt.signal() → weaver signal group                   // design-time projection
```

The `restate.*` migration proves this: the derived product surface (`.encodeSync` over the
boundary attribute bundles and the dynamic-name `restateOperation` span) produces byte-identical
attribute maps to an independent, hand-authored `OtelAttrs.defineSync` / `OtelOperation.define`
baseline, over `Schema` arbitraries exercising the optional-present / optional-absent branches and
the derived span label — a **property-based** equivalence through the real `OtelOperation` product
path (`*.observability.equivalence.unit.test.ts`; feasibility trail in
[.experiments](./.experiments/2026-07-01-weaver-feasibility.md)). Product APIs
(`OtelOperation`/`OtelMetric`/span.label/trusted-increment) are re-pointed at catalog entries but
keep otel-contract internals.

**Migration bridge (transitional, not the end state).** While legacy inline
`OtelAttr.string({key})` sites still exist, a conformance check runs as a bridge:

```
for each legacy runtime attr (key, cardinality?, encode?):
    def = catalog.byId[key]
    if missing / cardinality mismatch / encode mismatch → violation
```

This bridge is removed per namespace as sites migrate to catalog references (SC-DQ5). Its
completeness precondition is closed by the registered seam of
[.decisions/0005](./.decisions/0005-contract-registration-convention.md): the load-bearing
**no-orphan-seam aggregator check** (globs every `*.contract.ts` and asserts each is imported by
the root aggregator) plus the seam-file lint make contracts discoverable by construction, so the
sweep cannot silently miss a site.

## Generated-file contract (GEN-R07)

Each generated binding (TS constants, Rust consts, YAML) carries a provenance header:
generated + do-not-edit, the regeneration task, the `source:` path, and a `fingerprint:
sha256:<…>` over ALL semantic inputs — the registry source, the generator, the **pinned
Weaver version**, and the **pinned upstream semconv version** (all change the output). Any
`last generated` timestamp is fingerprint-guarded (no timestamp-only churn). Outputs are
read-only (genie's existing chmod); `genie:check` (same locally + CI) regenerates + diffs;
Nix eval reads only tracked, freshness-gated files, and the pinned upstream is a FOD input
(`nix/weaver-flake#semconv-model`) the gate resolves hermetically (SC-A03). **Fingerprint
granularity:** the fingerprint is split three ways (doc / identity / rust provenance) so a
doc-only annotation edit (`brief`/`stability`/`examples`) re-hashes only the doc-carrying
outputs, not the name/Rust-const targets that encode no doc content — a prose edit does not churn
bindings that didn't change.

## Remaining mechanism choices (settled)

- **Provenance = per-file `source` + input `fingerprint`** (Q9=A), mirroring otel-scrape's
  `REGISTRY_INPUT_FINGERPRINT`; hash is of the semantic inputs (above), not the emitted bytes
  (genie's read-only + byte-compare already catches hand edits).
- **`span.label` / operation label path:** the derived encoder uses the direct
  `OtelAttrs.defineSync` path; `span.label` stays runtime-only and is filtered
  from the registry projection (SC-T03) — `OtelSpan.define` is not used for derivation since it
  mandates a non-namespaced `span.label` attribute.
- **TS-constants scope:** own-namespace keys only; upstream-referenced keys
  (`http.request.method`) come from upstream's own generated constants, not ours.
- **Policy annotations:** emitted under `annotations.overeng_policy.{cardinality,encode}`
  (weaver-ignored, machine-readable for our gates).

## Design Questions

- **SC-DQ1 Conformance completeness — RESOLVED:** registered seam + lint + a
  **no-orphan-seam aggregator check** (the lint enforces "contract only in a seam file"; the
  aggregator check globs seam files and asserts each is imported — the part the lint
  structurally cannot provide). Completeness is structural. Staged warn → per-namespace ERROR
  → repo-wide. See [.decisions/0005](./.decisions/0005-contract-registration-convention.md).
- **SC-DQ2 Fold depth — RESOLVED:** registry-derives-runtime (SC-R13), via "catalog atop
  otel-contract primitives" ([.decisions/0002](./.decisions/0002-catalog-atop-otel-contract.md)).
  The migrations settle the two sub-questions: the product APIs keep a thin authoring surface —
  the `span` / `metric` / `operation` builders in otel-contract's `./registry`, which DERIVE
  the runtime encoder from catalog references (not codegen'd files); and the legacy inline
  `OtelAttr.string({key})` form is kept as a private building block behind the `attr.*` catalog
  factory, not retired.
- **SC-DQ3 Metric-label / privacy enforcement — RESOLVED:** the mechanism enforces the HARD
  invariants and the consumer's contract owns the richer policy
  ([.decisions/0008](./.decisions/0008-metric-label-privacy-enforcement.md); evidence in
  [.experiments/2026-07-03-metric-label-enforcement.md](./.experiments/2026-07-03-metric-label-enforcement.md)).
  `@overeng/otel-contract`'s author-time `assertMetricLabels` rejects high-cardinality and
  `drop` labels — an active-series (RAM) invariant aligned with the fleet's bounded-only
  metric-label contract (ids/versions/paths stay trace/log attributes). No `redacted`-label
  rule is added: `redacted` encodes to the constant mask `'<redacted>'`, so a redacted label
  emits no secret and is low-cardinality — the leak such a rule would guard is void. Finer
  policy (which bounded attrs are labels per metric, privacy classes) stays the downstream
  consumer's semantic contract.
- **SC-DQ5 Bootstrap & authority flip — RESOLVED:** the staged per-namespace live migration
  from the ~240 pre-existing otel-contract sites is past its resolving bar — the registry was
  seeded from existing `OtelAttrs.define` schemas, the conformance gate stages warn→block per
  namespace, and ~14 first-party namespaces are migrated green (genie, notion_md, megarepo,
  restate, notion, notion-react, notion_datasource, pw, cmd, pty, ci_tools, semaphore, cli, git,
  nix). The paired metric-label + bare-key renames (megarepo, restate, notion_datasource) landed
  retention-first ([.decisions/0004](./.decisions/0004-metric-label-migration.md)); attrs-only
  members (restate/cli/git/nix) reach the catalog via `docOnlyAttributes` for their dynamic-name
  bridge spans. Ongoing repo-wide sweep completeness remains SC-DQ1's concern, not this one.
- **SC-DQ4 Weaver version churn — RESOLVED:** the update cadence / compatibility matrix
  between pinned Weaver, pinned upstream semconv, and the emitted schema is governed by the
  [version-bump runbook](./version-bump-runbook.md) plus the `weaver:version-smoke` CI gate
  (wired into `check:all`), which asserts the Weaver and semconv pins stay consistent across
  `flake.nix` and `registry.ts`. weaver 0.24.2 `--future` is clean with semconv v1.37.0;
  ≤v1.36 fail on their own unstructured-`deprecated`.
- **SC-DQ6 Metric-label key projection — RESOLVED:** one namespaced key per concept on every
  signal (registry key dotted, metric wire renders underscore by default); existing metrics
  migrate retention-first, with a central collector OTTL bridge only for long-window metrics. See
  [.decisions/0003](./.decisions/0003-unified-full-dotted-keys.md) +
  [0004](./.decisions/0004-metric-label-migration.md).
