/**
 * LAYER 1 — Weaver foundation (dep-free): a direct, faithful, UNOPINIONATED typed model of
 * the OTel Weaver `groups:` registry, plus deterministic renderers.
 *
 * This is genie's `semantic-conventions` generator Layer 1 (GEN-R01): a complete, typed 1:1
 * model of Weaver's own vocabulary that projects deterministically to output. It is
 * STANDALONE (usable without Layer 2), and dependency-light: no `effect`, no `node:*`. It
 * reuses genie's own dep-free YAML stringifier (`../utils/yaml.ts`) rather than the `yaml`
 * npm package the feasibility prototype used, so it stays inside genie's runtime dep ban
 * (see `docs/spec.md` §runtime-vs-build).
 *
 * Layer 2 (`@overeng/otel-contract` `./registry`) projects DOWN to these types; the genie
 * engine renders one file per `.genie.ts` (manifest / attributes / signals / TS + Rust
 * constants). Provenance fingerprints are computed in the design-time layer (where
 * `node:crypto` is available) and passed in as strings — Layer 1 never hashes.
 */
import type { GenieOutput } from '../core.ts'
import { createGenieOutput } from '../core.ts'
import { stringify as yamlStringify } from '../utils/yaml.ts'
import type { GenieValidationIssue } from '../validation/mod.ts'

// ---------------------------------------------------------------------------
// Weaver vocabulary — plain typed data (the canonical model; Layer 2 mirrors these).
// ---------------------------------------------------------------------------

/** Weaver's maturity marker on an attribute or signal (`stable` graduates from `development`). */
export type Stability = 'stable' | 'development'
/** Policy annotation bounding an attribute's value cardinality (drives sampling/metric-label cost). */
export type Cardinality = 'low' | 'bounded' | 'high'
/** Policy annotation for how an attribute value is serialized (or dropped/redacted) at emit time. */
export type Encode = 'auto' | 'string' | 'number' | 'boolean' | 'json' | 'drop' | 'redacted'

/** One allowed value of an enum-typed attribute (weaver `type.members[]`). */
export type EnumMember = {
  readonly id: string
  readonly value: string | number
  readonly brief?: string
  readonly stability?: Stability
}

/** An attribute's `type:` — a primitive, an array, an enum (`{ members }`), or a `template[...]`. */
export type WeaverType =
  | 'string'
  | 'int'
  | 'double'
  | 'boolean'
  | 'string[]'
  | 'int[]'
  | 'boolean[]'
  | { readonly members: ReadonlyArray<EnumMember> }
  | `template[${string}]`

type DeprecationLifecycle = {
  readonly since?: string
  readonly remove_after?: string
}

/** weaver 0.23+ STRUCTURED deprecation (the string form was removed). */
export type Deprecated = DeprecationLifecycle &
  (
    | { readonly reason: 'renamed'; readonly renamed_to: string }
    | { readonly reason: 'obsoleted' | 'uncategorized'; readonly note: string }
  )

/** How strongly an attribute reference is required on a signal (weaver `requirement_level`). */
export type RequirementLevel =
  | 'required'
  | 'recommended'
  | 'opt_in'
  | { readonly conditionally_required: string }
  | { readonly recommended: string }

/**
 * The `bridge:` annotation (decision 0004) — an emission fact driving a central-collector OTTL
 * dual-emit config for a renamed metric label. Non-normative to Weaver; carried as an
 * annotation.
 */
export type Bridge = {
  readonly context: 'datapoint' | 'resource'
  readonly scope_metrics: ReadonlyArray<string>
}

/** A registry attribute DEFINITION (the canonical declaration living under an attribute group). */
export type AttrDef = {
  readonly id: string
  readonly type: WeaverType
  readonly brief: string
  readonly stability: Stability
  readonly examples?: ReadonlyArray<string | number | boolean>
  readonly note?: string
  readonly deprecated?: Deprecated
  /** machine-readable policy annotations (non-normative to upstream weaver). */
  readonly policy?: { readonly cardinality?: Cardinality; readonly encode?: Encode }
  readonly bridge?: Bridge
  /**
   * Per-entry catalog metadata carried through composition for downstream consumers (telemetry
   * mirror elimination). All additive/optional and NON-NORMATIVE to weaver — the renderers pick
   * emitted fields explicitly, so these never enter the generated YAML/TS/Rust. `owner`
   * (accountable team/person), `source` (originating file/system), `constName` (override for the
   * derived generated const name). Mirrored by `@overeng/otel-contract` `./registry` Layer 2.
   */
  readonly owner?: string
  readonly source?: string
  readonly constName?: string
}

/** A signal's REFERENCE to an attribute defined elsewhere, refining its requirement level. */
export type AttrRef = {
  readonly ref: string
  readonly requirement_level?: RequirementLevel
  readonly note?: string
  readonly sampling_relevant?: boolean
}

/** OTel span kind for a `span` signal (weaver `span_kind`). */
export type SpanKind = 'internal' | 'client' | 'server' | 'producer' | 'consumer'
/** OTel metric instrument for a `metric` signal (weaver `instrument`). */
export type Instrument = 'counter' | 'updowncounter' | 'gauge' | 'histogram'

/**
 * Per-entry signal metadata carried through composition for downstream consumers (telemetry mirror
 * elimination). All additive/optional and NON-NORMATIVE to weaver (renderers ignore them, so they
 * never enter generated output). Mirrored by `@overeng/otel-contract` `./registry` Layer 2.
 */
type SignalMeta = {
  readonly owner?: string
  readonly source?: string
  readonly constName?: string
}

/** A `span` or `metric` signal definition (a weaver group carrying attribute references). */
export type SignalDef =
  | ({
      readonly kind: 'span'
      readonly id: string
      /**
       * The runtime span name (e.g. `genie/command`), distinct from the weaver group `id`
       * (e.g. `span.genie.command`). Carried so Rust producer consts emit the name real telemetry
       * uses. Absent for plain spans that define no runtime name (Rust falls back to `id`).
       */
      readonly span_name?: string
      readonly span_kind: SpanKind
      readonly brief: string
      readonly stability: Stability
      readonly deprecated?: Deprecated
      readonly attributes: ReadonlyArray<AttrRef>
    } & SignalMeta)
  | ({
      readonly kind: 'metric'
      readonly id: string
      readonly metric_name: string
      readonly instrument: Instrument
      readonly unit: string
      readonly brief: string
      readonly stability: Stability
      readonly deprecated?: Deprecated
      readonly attributes: ReadonlyArray<AttrRef>
    } & SignalMeta)

/** A namespaced cluster of attribute definitions (weaver `attribute_group`). */
export type AttributeGroup = {
  readonly namespace: string
  readonly displayName: string
  readonly attributes: ReadonlyArray<AttrDef>
}

/** A declared upstream registry this one depends on (weaver `imports`/`dependencies`). */
export type Dependency = {
  readonly name: string
  readonly registry_path: string
  readonly schema_url: string
}

/** The whole authored registry: metadata, upstream dependencies, attribute groups, and signals. */
export type Registry = {
  readonly name: string
  readonly description: string
  readonly schemaUrl: string
  readonly dependencies: ReadonlyArray<Dependency>
  readonly groups: ReadonlyArray<AttributeGroup>
  readonly signals: ReadonlyArray<SignalDef>
}

/**
 * One member's slice, produced by Layer 2's projector (`@overeng/otel-contract` `./registry`).
 * Layer 2 re-declares a structurally-identical type (it cannot import genie — that would be a
 * project-reference cycle since genie depends on otel-contract); the root aggregator's
 * typecheck is the drift guard.
 */
export type RegistryFragment = {
  readonly namespace: string
  readonly memberPath: string
  readonly displayName: string
  readonly attributes: ReadonlyArray<AttrDef>
  /** refs to OTHER namespaces (cross-member / upstream) — carried for aggregation integrity. */
  readonly foreignRefs: ReadonlyArray<string>
  readonly signals: ReadonlyArray<SignalDef>
}

// ---------------------------------------------------------------------------
// Structured (JS object) projection — the intermediate the YAML encoder serializes.
// Building plain objects (not strings) is what avoids the nesting bugs the prototype hit.
// ---------------------------------------------------------------------------

const POLICY_ANNOTATION_NS = 'overeng_policy'

const deprecatedToNormativeObject = (deprecated: Deprecated): Record<string, unknown> =>
  deprecated.reason === 'renamed'
    ? { reason: deprecated.reason, renamed_to: deprecated.renamed_to }
    : { reason: deprecated.reason, note: deprecated.note }

const deprecatedToLifecycleAnnotation = (
  deprecated: Deprecated,
): Record<string, unknown> | undefined => {
  const annotation = {
    ...(deprecated.since !== undefined ? { since: deprecated.since } : {}),
    ...(deprecated.remove_after !== undefined ? { remove_after: deprecated.remove_after } : {}),
  }
  return Object.keys(annotation).length > 0 ? annotation : undefined
}

const addPolicyAnnotation = ({
  annotations,
  fields,
}: {
  annotations: Record<string, unknown>
  fields: Record<string, unknown>
}): void => {
  const existing = annotations[POLICY_ANNOTATION_NS] as Record<string, unknown> | undefined
  annotations[POLICY_ANNOTATION_NS] = existing === undefined ? fields : { ...existing, ...fields }
}

const addDeprecatedToObject = ({
  out,
  annotations,
  deprecated,
}: {
  out: Record<string, unknown>
  annotations: Record<string, unknown>
  deprecated: Deprecated
}): void => {
  out['deprecated'] = deprecatedToNormativeObject(deprecated)
  const lifecycle = deprecatedToLifecycleAnnotation(deprecated)
  if (lifecycle !== undefined) {
    addPolicyAnnotation({ annotations, fields: { deprecated: lifecycle } })
  }
}

const attrDefToObject = (a: AttrDef): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    id: a.id,
    type:
      typeof a.type === 'object'
        ? {
            members: a.type.members.map((m) => ({
              id: m.id,
              value: m.value,
              ...(m.brief !== undefined ? { brief: m.brief } : {}),
              // weaver 0.24.2 REQUIRES `stability` on every enum member; default to the attr's.
              stability: m.stability ?? a.stability,
            })),
          }
        : a.type,
    stability: a.stability,
    brief: a.brief,
  }
  if (a.note !== undefined) out['note'] = a.note
  if (a.examples !== undefined && a.examples.length > 0) out['examples'] = [...a.examples]
  const annotations: Record<string, unknown> = {}
  if (a.deprecated !== undefined) {
    addDeprecatedToObject({ out, annotations, deprecated: a.deprecated })
  }
  if (a.policy?.cardinality !== undefined || a.policy?.encode !== undefined) {
    addPolicyAnnotation({
      annotations,
      fields: {
        ...(a.policy.cardinality !== undefined ? { cardinality: a.policy.cardinality } : {}),
        ...(a.policy.encode !== undefined ? { encode: a.policy.encode } : {}),
      },
    })
  }
  if (a.bridge !== undefined) {
    annotations['bridge'] = {
      context: a.bridge.context,
      scope_metrics: [...a.bridge.scope_metrics],
    }
  }
  if (Object.keys(annotations).length > 0) out['annotations'] = annotations
  return out
}

const attrRefToObject = (r: AttrRef): Record<string, unknown> => {
  const out: Record<string, unknown> = { ref: r.ref }
  if (r.requirement_level !== undefined) {
    out['requirement_level'] =
      typeof r.requirement_level === 'string' ? r.requirement_level : { ...r.requirement_level }
  }
  if (r.sampling_relevant !== undefined) out['sampling_relevant'] = r.sampling_relevant
  if (r.note !== undefined) out['note'] = r.note
  return out
}

const byId = <T extends { id: string }>(xs: ReadonlyArray<T>): ReadonlyArray<T> =>
  xs.toSorted((a, b) => a.id.localeCompare(b.id))

const attributeGroupToObject = (g: AttributeGroup): Record<string, unknown> => ({
  id: `registry.${g.namespace}`,
  type: 'attribute_group',
  display_name: g.displayName,
  brief: `Attributes for the ${g.namespace} namespace.`,
  attributes: byId(g.attributes).map(attrDefToObject),
})

const signalToObject = (sig: SignalDef): Record<string, unknown> => {
  const base: Record<string, unknown> = { id: sig.id, type: sig.kind }
  if (sig.kind === 'span') base['span_kind'] = sig.span_kind
  if (sig.kind === 'metric') {
    base['metric_name'] = sig.metric_name
    base['instrument'] = sig.instrument
    base['unit'] = sig.unit
  }
  base['stability'] = sig.stability
  base['brief'] = sig.brief
  const annotations: Record<string, unknown> = {}
  if (sig.deprecated !== undefined) {
    addDeprecatedToObject({ out: base, annotations, deprecated: sig.deprecated })
  }
  if (Object.keys(annotations).length > 0) base['annotations'] = annotations
  base['attributes'] = sig.attributes.map(attrRefToObject)
  return base
}

// ---------------------------------------------------------------------------
// Provenance (GEN-R07). The engine adds the `# Generated / # Source:` banner; we add the
// semantic source, input fingerprint, and canonical regeneration command below it. The
// fingerprint is computed in the design-time layer and passed in (Layer 1 stays node-free — no
// `node:crypto`).
// ---------------------------------------------------------------------------

const REGENERATION_COMMAND = 'devenv tasks run genie:run'

/** The source path + input fingerprint stamped into a generated file's provenance banner. */
export type Provenance = {
  /** repo-relative path to the authored registry source (the aggregator module). */
  readonly source: string
  /** `sha256:<hex>` over ALL semantic inputs relevant to THIS output (see fingerprint split). */
  readonly fingerprint: string
}

const provenanceComment = ({
  provenance,
  prefix,
}: {
  provenance: Provenance
  prefix: '#' | '//'
}): string =>
  [
    `${prefix} registry-source: ${provenance.source}`,
    `${prefix} fingerprint: ${provenance.fingerprint}`,
    `${prefix} regen: ${REGENERATION_COMMAND}`,
    '',
  ].join('\n')

// ---------------------------------------------------------------------------
// Renderers (deterministic, pure): one function per target file. Each takes the model plus the
// per-output {@link Provenance} (object args per the repo's named-args convention).
// ---------------------------------------------------------------------------

/** Weaver registry `manifest.yaml` (name/description/schema_url/dependencies). */
export const renderManifest = ({
  registry,
  provenance,
}: {
  registry: Registry
  provenance: Provenance
}): string =>
  provenanceComment({ provenance, prefix: '#' }) +
  yamlStringify({
    name: registry.name,
    description: registry.description,
    schema_url: registry.schemaUrl,
    ...(registry.dependencies.length > 0
      ? {
          dependencies: registry.dependencies
            .toSorted((a, b) => a.name.localeCompare(b.name))
            .map((d) => ({
              name: d.name,
              registry_path: d.registry_path,
              schema_url: d.schema_url,
            })),
        }
      : {}),
  })

/** `<ns>.attributes.yaml` for one namespace's DEFINE-once catalog. */
export const renderAttributeGroup = ({
  group,
  provenance,
}: {
  group: AttributeGroup
  provenance: Provenance
}): string =>
  provenanceComment({ provenance, prefix: '#' }) +
  yamlStringify({ groups: [attributeGroupToObject(group)] })

/**
 * `attributes.yaml` — ALL namespaces' DEFINE-once catalogs collapsed into ONE file. Weaver
 * accepts multiple `attribute_group` entries per file (as `signals.yaml` already relies on for
 * multiple signal groups), so a single emitter replaces the former per-namespace sprawl: adding
 * a namespace needs NO new `.genie.ts`. Groups are namespace-sorted for determinism (each
 * group's attributes are sorted by id inside {@link attributeGroupToObject}).
 */
export const renderAttributes = ({
  registry,
  provenance,
}: {
  registry: Registry
  provenance: Provenance
}): string =>
  provenanceComment({ provenance, prefix: '#' }) +
  yamlStringify({
    groups: registry.groups
      .toSorted((a, b) => a.namespace.localeCompare(b.namespace))
      .map(attributeGroupToObject),
  })

/** `signals.yaml` — all spans + metrics (which only REF the catalog). */
export const renderSignals = ({
  signals,
  provenance,
}: {
  signals: ReadonlyArray<SignalDef>
  provenance: Provenance
}): string =>
  provenanceComment({ provenance, prefix: '#' }) +
  yamlStringify({
    groups: byId(signals as ReadonlyArray<{ id: string }>).map((s) =>
      signalToObject(s as SignalDef),
    ),
  })

// --- TS / Rust name constants (GEN-R06 multi-language targets) ---

const pascal = (key: string): string =>
  key
    .split(/[.\-:]/)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join('')

const namePascal = (key: string): string =>
  key
    .split(/[._\-:/]/)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join('')

const screamingSnake = (key: string): string => key.replace(/[.\-:/]/g, '_').toUpperCase()

/** Single-quoted string literal (matches the repo's oxfmt style, so no reformat is needed). */
const sq = (k: string): string => `'${k}'`

const tsConstDeclaration = ({ identifier, value }: { identifier: string; value: string }) => {
  const declaration = `export const ${identifier} = ${sq(value)} as const`
  return declaration.length <= 100
    ? [declaration]
    : [`export const ${identifier} =`, `  ${sq(value)} as const`]
}

const ownKeys = (r: Registry): ReadonlyArray<string> =>
  byId(r.groups.flatMap((g) => g.attributes)).map((a) => a.id)

/** Runtime span names and metric names emitted by TS/Rust producer constants. */
export const signalNames = (
  registry: Registry,
): {
  readonly spanNames: ReadonlyArray<string>
  readonly metricNames: ReadonlyArray<string>
} => ({
  spanNames: registry.signals
    .filter((s): s is Extract<SignalDef, { kind: 'span' }> => s.kind === 'span')
    // Emit the RUNTIME span name (what producers actually name spans), not the weaver group id.
    // Plain spans carry no runtime name, so fall back to the id.
    .map((s) => s.span_name ?? s.id)
    .toSorted((a, b) => a.localeCompare(b)),
  metricNames: registry.signals
    .filter((s): s is Extract<SignalDef, { kind: 'metric' }> => s.kind === 'metric')
    .map((s) => s.metric_name)
    .toSorted((a, b) => a.localeCompare(b)),
})

const assertUniqueIdentifiers = ({
  target,
  kind,
  names,
  identifier,
  valid,
}: {
  target: string
  kind: string
  names: ReadonlyArray<string>
  identifier: (name: string) => string
  valid: RegExp
}): void => {
  const seen = new Map<string, string>()
  for (const name of names) {
    const id = identifier(name)
    if (valid.test(id) === false) {
      throw new Error(
        `weaver ${target} constants ${kind}: generated identifier ${JSON.stringify(id)} for ${JSON.stringify(name)} is invalid`,
      )
    }
    const previous = seen.get(id)
    if (previous !== undefined) {
      throw new Error(
        `weaver ${target} constants ${kind}: identifier collision ${JSON.stringify(id)} for ${JSON.stringify(previous)} and ${JSON.stringify(name)}`,
      )
    }
    seen.set(id, name)
  }
}

const assertUniqueTsConstIdentifiers = ({
  attributeKeys,
  spanNames,
  metricNames,
}: {
  attributeKeys: ReadonlyArray<string>
  spanNames: ReadonlyArray<string>
  metricNames: ReadonlyArray<string>
}): void => {
  const entries = [
    ...attributeKeys.map((name) => ({
      source: `attribute key ${JSON.stringify(name)}`,
      identifier: pascal(name),
    })),
    ...spanNames.map((name) => ({
      source: `span name ${JSON.stringify(name)}`,
      identifier: `SPAN_${namePascal(name)}`,
    })),
    ...metricNames.map((name) => ({
      source: `metric name ${JSON.stringify(name)}`,
      identifier: `METRIC_${namePascal(name)}`,
    })),
  ]
  const seen = new Map<string, string>()
  for (const { source, identifier } of entries) {
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(identifier) === false) {
      throw new Error(
        `weaver TS constants: generated identifier ${JSON.stringify(identifier)} for ${source} is invalid`,
      )
    }
    const previous = seen.get(identifier)
    if (previous !== undefined) {
      throw new Error(
        `weaver TS constants: identifier collision ${JSON.stringify(identifier)} for ${previous} and ${source}`,
      )
    }
    seen.set(identifier, source)
  }
}

const tsConstLines = ({
  prefix,
  names,
}: {
  prefix: 'METRIC' | 'SPAN'
  names: ReadonlyArray<string>
}): ReadonlyArray<string> => {
  return names.flatMap((name) =>
    tsConstDeclaration({ identifier: `${prefix}_${namePascal(name)}`, value: name }),
  )
}

const unionLines = ({
  typeName,
  names,
}: {
  typeName: string
  names: ReadonlyArray<string>
}): ReadonlyArray<string> =>
  names.length === 0
    ? [`export type ${typeName} = never`]
    : [`export type ${typeName} =`, ...names.map((k) => `  | ${sq(k)}`)]

/**
 * TS name constants + a key union (own-namespace keys only — upstream-referenced keys come
 * from upstream's own generated constants, per spec.md §TS-constants scope).
 */
export const renderTsConstants = ({
  registry,
  provenance,
}: {
  registry: Registry
  provenance: Provenance
}): string => {
  const attributeKeys = ownKeys(registry)
  const { spanNames, metricNames } = signalNames(registry)
  assertUniqueTsConstIdentifiers({ attributeKeys, spanNames, metricNames })
  const lines: string[] = [provenanceComment({ provenance, prefix: '//' }).trimEnd(), '']
  for (const k of attributeKeys) {
    lines.push(...tsConstDeclaration({ identifier: pascal(k), value: k }))
  }
  lines.push(...tsConstLines({ prefix: 'SPAN', names: spanNames }))
  lines.push(...tsConstLines({ prefix: 'METRIC', names: metricNames }))
  lines.push(
    '',
    ...unionLines({ typeName: 'AttributeKey', names: attributeKeys }),
    '',
    ...unionLines({ typeName: 'SpanName', names: spanNames }),
    '',
    ...unionLines({ typeName: 'MetricName', names: metricNames }),
    '',
  )
  return lines.join('\n')
}

/** Rust string literal (double-quoted, escaped) — matches rustfmt's canonical form. */
const rustStr = (k: string): string => JSON.stringify(k)

/**
 * A `pub const ALL: &[&str] = ...;` slice line(s), formatted the way rustfmt would: inline when
 * the array literal is short (rustfmt's `array_width`, default 60), else one element per line
 * with a trailing comma. `indent` is the module-body indent (4 spaces).
 */
const rustAllSlice = ({
  indent,
  keys,
}: {
  indent: string
  keys: ReadonlyArray<string>
}): ReadonlyArray<string> => {
  const inner = `[${keys.map(rustStr).join(', ')}]`
  if (inner.length <= 60) return [`${indent}pub const ALL: &[&str] = &${inner};`]
  return [
    `${indent}pub const ALL: &[&str] = &[`,
    ...keys.map((k) => `${indent}    ${rustStr(k)},`),
    `${indent}];`,
  ]
}

/**
 * One `pub mod <name> { ... }` block: a `pub const <SCREAMING_SNAKE>: &str` per name plus an
 * `ALL` slice for iteration. Kinds live in SEPARATE modules so a shared final segment (e.g. an
 * attribute `x.duration` and a metric named `x.duration`) cannot collide into the same const.
 */
const rustModule = ({
  name,
  doc,
  keys,
}: {
  name: string
  doc: string
  keys: ReadonlyArray<string>
}): string => {
  const indent = '    '
  if (keys.length === 0) return [`/// ${doc}`, `pub mod ${name} {}`].join('\n')
  assertUniqueIdentifiers({
    target: 'Rust',
    kind: name,
    names: keys,
    identifier: screamingSnake,
    valid: /^[A-Z_][A-Z0-9_]*$/,
  })
  const lines = [`/// ${doc}`, `pub mod ${name} {`]
  for (const k of keys) lines.push(`${indent}pub const ${screamingSnake(k)}: &str = ${rustStr(k)};`)
  lines.push('', ...rustAllSlice({ indent, keys }), '}')
  return lines.join('\n')
}

/**
 * Rust const modules (GEN-R06 / decision 0007's Rust target) for a Rust telemetry *producer*:
 * one module each for own-namespace attribute keys, span names, and metric names — the names
 * such a consumer (e.g. otel-scrape) needs to emit conforming telemetry. Deterministic (every
 * kind sorted) and rustfmt-clean. Upstream-referenced keys are excluded (they come from
 * upstream's own generated bindings — see spec.md §TS-constants scope, which applies equally to
 * Rust). The provenance fingerprint must cover attribute keys + span ids + metric names (the
 * exact names emitted here), split from the doc fingerprint so a prose edit does not churn this
 * file (GEN-R07 §fingerprint granularity).
 */
export const renderRustConstants = ({
  registry,
  provenance,
}: {
  registry: Registry
  provenance: Provenance
}): string => {
  const attributeKeys = ownKeys(registry)
  const { spanNames, metricNames } = signalNames(registry)
  return [
    provenanceComment({ provenance, prefix: '//' }).trimEnd(),
    '',
    '//! Generated OpenTelemetry semantic-convention name constants.',
    '',
    rustModule({ name: 'attribute', doc: 'Attribute keys.', keys: attributeKeys }),
    '',
    rustModule({ name: 'span', doc: 'Span names.', keys: spanNames }),
    '',
    rustModule({ name: 'metric', doc: 'Metric names.', keys: metricNames }),
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Weaver registry builder family (genie-idiomatic, design A'). One builder per emitted target;
// each `.genie.ts` emitter is then a one-liner: `export default weaverSignals(weaver)`. The
// provenance fingerprints + composition issues are computed in the design-time aggregator (where
// `node:crypto` is available) and passed IN via the bundle — Layer 1 stays dep-free (no crypto).
// ---------------------------------------------------------------------------

/**
 * The complete design-time input for the builder family: the composed {@link Registry}, the split
 * provenance fingerprints (doc / identity — see GEN-R07 §fingerprint granularity), and the
 * whole-registry integrity {@link GenieValidationIssue}s. The aggregator constructs one of these
 * and every emitter consumes it.
 *
 * NOTE: `issues` is carried here (a deviation from a provenance-only bundle) so `weaverManifest`
 * can surface namespace-collision / dangling-ref blocking via `validate` while keeping every
 * emitter a true one-liner — this is the ONLY place whole-registry integrity gates `genie:check`.
 */
export type WeaverRegistryBundle = {
  readonly registry: Registry
  readonly docProvenance: Provenance
  readonly identityProvenance: Provenance
  readonly issues: readonly GenieValidationIssue[]
}

/** `manifest.yaml` builder; also surfaces whole-registry integrity issues via `validate`. */
export const weaverManifest = (w: WeaverRegistryBundle): GenieOutput<Registry> =>
  createGenieOutput({
    data: w.registry,
    stringify: () => renderManifest({ registry: w.registry, provenance: w.docProvenance }),
    validate: () => [...w.issues],
  })

/** `attributes.yaml` builder — ALL namespaces' catalogs in one file (the collapsed emitter). */
export const weaverAttributes = (
  w: WeaverRegistryBundle,
): GenieOutput<ReadonlyArray<AttributeGroup>> =>
  createGenieOutput({
    data: w.registry.groups,
    stringify: () => renderAttributes({ registry: w.registry, provenance: w.docProvenance }),
  })

/** `signals.yaml` builder — all spans + metrics. */
export const weaverSignals = (w: WeaverRegistryBundle): GenieOutput<ReadonlyArray<SignalDef>> =>
  createGenieOutput({
    data: w.registry.signals,
    stringify: () => renderSignals({ signals: w.registry.signals, provenance: w.docProvenance }),
  })

/** `constants.ts` builder — TS name constants (identity fingerprint). */
export const weaverTsConstants = (w: WeaverRegistryBundle): GenieOutput<Registry> =>
  createGenieOutput({
    data: w.registry,
    stringify: () => renderTsConstants({ registry: w.registry, provenance: w.identityProvenance }),
  })

/** `constants.rs` builder — Rust name constants (identity fingerprint). */
export const weaverRustConstants = (w: WeaverRegistryBundle): GenieOutput<Registry> =>
  createGenieOutput({
    data: w.registry,
    stringify: () =>
      renderRustConstants({ registry: w.registry, provenance: w.identityProvenance }),
  })

// ---------------------------------------------------------------------------
// Per-member author-time well-formedness (partial). Cross-member checks happen at
// aggregation (see `@overeng/genie/composition`), not here.
// ---------------------------------------------------------------------------

/** A per-fragment well-formedness problem, optionally scoped to the offending attribute. */
export type FragmentIssue = { readonly message: string; readonly attrId?: string }

/** Partial, per-fragment checks that do not need cross-member context. */
export const fragmentWellFormednessIssues = (f: RegistryFragment): ReadonlyArray<FragmentIssue> => {
  const issues: FragmentIssue[] = []
  for (const a of f.attributes) {
    if (a.type === 'string' && (a.examples === undefined || a.examples.length === 0)) {
      issues.push({
        attrId: a.id,
        message: `attr ${a.id}: string attributes require examples under weaver --future`,
      })
    }
    if (a.id.split('.')[0] !== f.namespace) {
      issues.push({
        attrId: a.id,
        message: `attr ${a.id}: own key does not share the fragment namespace ${JSON.stringify(f.namespace)}`,
      })
    }
  }
  return issues
}

// ---------------------------------------------------------------------------
// Genie builder — a member emits its RegistryFragment on the non-emitted `meta.registry`
// channel, plus an optional per-member slice on `data`/`stringify` (SC-R07).
// ---------------------------------------------------------------------------

/** Render a single member's fragment as a standalone (informational) YAML slice. */
export const renderMemberSlice = ({
  fragment,
  provenance,
}: {
  fragment: RegistryFragment
  provenance: Provenance
}): string =>
  provenanceComment({ provenance, prefix: '#' }) +
  yamlStringify({
    groups: [
      attributeGroupToObject({
        namespace: fragment.namespace,
        displayName: fragment.displayName,
        attributes: fragment.attributes,
      }),
      ...byId(fragment.signals as ReadonlyArray<{ id: string }>).map((s) =>
        signalToObject(s as SignalDef),
      ),
    ],
  })

/**
 * A member's `.genie.ts` returns this: the fragment rides `meta.registry` for the root
 * aggregator to compose (never re-derived from emitted files), and a slice is emitted as
 * `data`/`stringify`. Guard `fragment` with `Strict<>` at the call site if authored inline.
 */
export const registryFragment = ({
  fragment,
  provenance,
}: {
  fragment: RegistryFragment
  provenance: Provenance
}): GenieOutput<RegistryFragment, { registry: RegistryFragment }> =>
  createGenieOutput({
    data: fragment,
    stringify: () => renderMemberSlice({ fragment, provenance }),
    meta: { registry: fragment },
  })
