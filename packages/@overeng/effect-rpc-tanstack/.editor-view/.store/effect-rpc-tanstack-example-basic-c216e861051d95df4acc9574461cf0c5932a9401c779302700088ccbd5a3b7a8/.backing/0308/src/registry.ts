/**
 * LAYER 2 — opinionated Effect-Schema authoring for OTel semantic-convention registries,
 * built ON TOP of this package's runtime primitives (`./mod.ts`).
 *
 * This is the `@overeng/otel-contract` `./registry` subpath — the DESIGN-TIME projector home
 * (decision 0006). It is imported by `.genie.ts` design-time files AND by `*.contract.ts` seam
 * files; as of M3 a seam's DERIVED encoders (`SpanContract.encoder` / `OperationContract.operation`)
 * are re-pointed into product runtime code (SC-R13/R14 — the registry is the single SSOT for both
 * the projection and the runtime encoder), so `./registry` now transitively enters a consumer's
 * runtime graph via its seam file. It still stays OUT of otel-contract's own `.` runtime bundle
 * (verified by a tree-shaking test — `mod.ts` never imports `./registry`).
 * It depends on `effect` + `./mod.ts`; it must NEVER import `@overeng/genie` (genie depends on
 * this package — that would be a project-reference cycle). The plain Weaver data types below
 * therefore MIRROR `@overeng/genie` `src/runtime/weaver` Layer 1; the root aggregator's
 * typecheck is the drift guard.
 *
 * Authoring model (decision 0006):
 *   - attributes are annotated Effect Schemas carrying BOTH the otel runtime annotation
 *     (`OtelAttrAnnotationId`: key/cardinality/encode) AND a SEPARATE weaver annotation
 *     (`WeaverAttrAnnotationId`: brief/stability/examples/type/deprecated). Two symbols so
 *     design-time metadata never pollutes `OtelAttrMetadata` (decision 0001-R1).
 *   - `defineOtelContract({ signals, docOnlyAttributes? })` — the per-package seam (0005).
 *   - DERIVED namespace (first key segment; a stray own key is a hard error) + DERIVED catalog
 *     (referenced own attrs ∪ doc-only); foreign refs are opt-out marked (`refExternal`).
 *   - `fragment(contract)` projects to a Layer-1 registry fragment by reading AST annotations.
 *
 * Author-time failures raise `Schema.TaggedError`s (not plain `throw`, unlike the prototype).
 */
import { Schema } from 'effect'
import type * as AST from 'effect/SchemaAST'

import {
  OtelAttr,
  OtelAttrAnnotationId,
  OtelAttrs,
  OtelMetric,
  OtelOperation,
  type OtelMetricDefinition,
} from './mod.ts'

// ---------------------------------------------------------------------------
// Weaver vocabulary — MIRRORS @overeng/genie src/runtime/weaver Layer 1 (see file docstring).
// ---------------------------------------------------------------------------

/** Weaver attribute/signal stability level. */
export type Stability = 'stable' | 'development'
/** otel-contract cardinality tier (policy annotation). */
export type Cardinality = 'low' | 'bounded' | 'high'
/** otel-contract encode policy (policy annotation). */
export type Encode = 'auto' | 'string' | 'number' | 'boolean' | 'json' | 'drop' | 'redacted'

/** One member of a Weaver enum attribute type. */
export type EnumMember = {
  readonly id: string
  readonly value: string | number
  readonly brief?: string
  readonly stability?: Stability
}

/** A Weaver attribute type (primitive, array, enum members, or `template[...]`). */
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

/** Weaver structured deprecation (the pre-0.23 string form was removed). */
export type Deprecated = DeprecationLifecycle &
  (
    | { readonly reason: 'renamed'; readonly renamed_to: string }
    | { readonly reason: 'obsoleted' | 'uncategorized'; readonly note: string }
  )

/** Weaver attribute-ref requirement level (incl. the object forms). */
export type RequirementLevel =
  | 'required'
  | 'recommended'
  | 'opt_in'
  | { readonly conditionally_required: string }
  | { readonly recommended: string }

/** The `bridge:` annotation driving a collector OTTL dual-emit (decision 0004). */
export type Bridge = {
  readonly context: 'datapoint' | 'resource'
  readonly scope_metrics: ReadonlyArray<string>
}

/** A DEFINE-once catalog attribute (Layer-1 shape). */
export type AttrDef = {
  readonly id: string
  readonly type: WeaverType
  readonly brief: string
  readonly stability: Stability
  readonly examples?: ReadonlyArray<string | number | boolean>
  readonly note?: string
  readonly deprecated?: Deprecated
  readonly policy?: { readonly cardinality?: Cardinality; readonly encode?: Encode }
  readonly bridge?: Bridge
  /**
   * Per-entry catalog metadata carried for downstream consumers (mirror-elimination). All
   * additive/optional: `owner` (team/person accountable), `source` (originating file/system),
   * `constName` (override for the derived generated const name — genie otherwise derives
   * `pascal(id)`; supply only to override that default).
   */
  readonly owner?: string
  readonly source?: string
  readonly constName?: string
}

/** A signal reference to a catalog attribute + its requirement level. */
export type AttrRef = {
  readonly ref: string
  readonly requirement_level?: RequirementLevel
  readonly note?: string
  readonly sampling_relevant?: boolean
}

/** OpenTelemetry span kind. */
export type SpanKind = 'internal' | 'client' | 'server' | 'producer' | 'consumer'
/** OpenTelemetry metric instrument kind. */
export type Instrument = 'counter' | 'updowncounter' | 'gauge' | 'histogram'

/**
 * Per-entry signal metadata carried for downstream consumers (mirror-elimination). All
 * additive/optional: `owner` (team/person accountable), `source` (originating file/system),
 * `constName` (override for the derived generated const name — genie otherwise derives
 * `SPAN_${namePascal(name)}` / `METRIC_${namePascal(name)}`; supply only to override).
 */
type SignalMeta = {
  readonly owner?: string
  readonly source?: string
  readonly constName?: string
}

/** A span or metric signal group (references the catalog). */
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

/** One member’s registry slice (mirrors genie Layer-1 `RegistryFragment`). */
export type RegistryFragment = {
  readonly namespace: string
  readonly memberPath: string
  readonly displayName: string
  readonly attributes: ReadonlyArray<AttrDef>
  readonly foreignRefs: ReadonlyArray<string>
  readonly signals: ReadonlyArray<SignalDef>
}

// ---------------------------------------------------------------------------
// Author-time tagged errors (SC-R05 §Effect-Schema conventions).
// ---------------------------------------------------------------------------

/** An attribute Schema is missing the otel key annotation and/or the weaver metadata. */
export class WeaverMissingAnnotationError extends Schema.TaggedError<WeaverMissingAnnotationError>()(
  'WeaverMissingAnnotationError',
  { key: Schema.optional(Schema.String), missing: Schema.Literals(['otelKey', 'weaverMeta']) },
) {}

/**
 * An own (non-`refExternal`) attribute key does not share the derived namespace. Because foreign
 * refs are opt-out marked, this is EITHER a typo OR a cross-member/upstream ref that should have
 * been `refExternal(...)` — i.e. this covers both the "stray-namespace-key" and the
 * "unmarked-foreign" cases (they are indistinguishable at derivation; decision 0006).
 */
export class WeaverStrayNamespaceKeyError extends Schema.TaggedError<WeaverStrayNamespaceKeyError>()(
  'WeaverStrayNamespaceKeyError',
  { key: Schema.String, derivedNamespace: Schema.String },
) {}

/** A contract has no own attributes, so a namespace cannot be derived. */
export class WeaverEmptyContractError extends Schema.TaggedError<WeaverEmptyContractError>()(
  'WeaverEmptyContractError',
  { memberPath: Schema.String },
) {}

/**
 * A metric was authored with an instrument the runtime cannot build. `OtelMetric` has no
 * `updowncounter` constructor, so mapping it to `gauge` would make runtime emission disagree with
 * the semconv registry (which still reports `updowncounter`). Rejected at author time instead.
 */
export class WeaverUnsupportedInstrumentError extends Schema.TaggedError<WeaverUnsupportedInstrumentError>()(
  'WeaverUnsupportedInstrumentError',
  { metricName: Schema.String, instrument: Schema.String },
) {
  override get message(): string {
    return `${this.instrument} is not yet supported by OtelMetric; use counter/histogram/gauge (metric "${this.metricName}")`
  }
}

// ---------------------------------------------------------------------------
// The weaver annotation — a separate symbol from OtelAttrAnnotationId (decision 0001-R1).
// ---------------------------------------------------------------------------

/** Private annotation key carrying design-time (weaver) metadata, kept OFF `OtelAttrMetadata`. */
export const WeaverAttrAnnotationId: unique symbol = Symbol.for('@overeng/genie/weaver/Attr')

/** Design-time weaver metadata carried on an attribute Schema annotation. */
export type WeaverAttrMeta = {
  readonly brief: string
  readonly stability: Stability
  readonly weaverType: WeaverType
  readonly examples?: ReadonlyArray<string | number | boolean>
  readonly note?: string
  readonly deprecated?: Deprecated
  readonly bridge?: Bridge
  /** Per-entry catalog metadata (see {@link AttrDef}); additive/optional. */
  readonly owner?: string
  readonly source?: string
  readonly constName?: string
}

/**
 * Builder-facing shape: the same fields, but optionals explicitly allow `undefined` so the
 * `attr.*` builders can pass through `o.note` / `o.examples` etc. directly under
 * `exactOptionalPropertyTypes`. Stored annotation is read back as {@link WeaverAttrMeta}.
 */
type WeaverAttrMetaInput = {
  readonly brief: string
  readonly stability: Stability
  readonly weaverType: WeaverType
  readonly examples?: ReadonlyArray<string | number | boolean> | undefined
  readonly note?: string | undefined
  readonly deprecated?: Deprecated | undefined
  readonly bridge?: Bridge | undefined
  readonly owner?: string | undefined
  readonly source?: string | undefined
  readonly constName?: string | undefined
}

/** deep annotation read (mirrors otel-contract's own walk through encoding links and unions). */
const getDeep = <T>({ id, ast }: { id: symbol; ast: AST.AST }): T | undefined => {
  const here = (ast.annotations as Record<symbol, unknown> | undefined)?.[id] as T | undefined
  if (here !== undefined) return here
  switch (ast._tag) {
    case 'Union':
      return ast.types.map((t) => getDeep<T>({ id, ast: t })).find((x) => x !== undefined)
    default:
      return ast.encoding !== undefined && ast.encoding.length > 0
        ? getDeep<T>({ id, ast: ast.encoding[0].to })
        : undefined
  }
}

const annotateWeaver = <S extends Schema.Codec<any>>({
  schema,
  meta,
}: {
  schema: S
  meta: WeaverAttrMetaInput
}): S => schema.annotate({ [WeaverAttrAnnotationId]: meta }) as S

/** An attribute is an annotated Effect Schema (otel + weaver metadata carried on its AST). */
export type Attribute = Schema.Codec<any>

const keyOf = (schema: Attribute): string => {
  const otel = getDeep<{ key?: string }>({ id: OtelAttrAnnotationId, ast: schema.ast })
  if (otel?.key === undefined) throw new WeaverMissingAnnotationError({ missing: 'otelKey' })
  return otel.key
}

// ---------------------------------------------------------------------------
// attr.* — attribute builders. Return REAL annotated Effect Schemas.
// ---------------------------------------------------------------------------

/**
 * Per-entry metadata accepted by every `attr.*` / signal builder. All optional/additive:
 * `owner`/`source`/`constName` (see {@link AttrDef}). Contract-level `owner`/`source` defaults
 * (via `defineOtelContract`) fill entries that omit them.
 */
export type EntryMetaInput = {
  readonly owner?: string
  readonly source?: string
  readonly constName?: string
}

/**
 * Thread the optional per-entry metadata onto a weaver meta record. The return allows explicit
 * `| undefined` (mirroring {@link WeaverAttrMetaInput}) so it composes under
 * `exactOptionalPropertyTypes`; `toAttrDef` strips the undefineds when projecting.
 */
const entryMeta = (
  o: EntryMetaInput,
): {
  readonly owner?: string | undefined
  readonly source?: string | undefined
  readonly constName?: string | undefined
} => ({ owner: o.owner, source: o.source, constName: o.constName })

/** Attribute builders. Each returns a REAL annotated Effect Schema (otel + weaver metadata). */
export const attr = {
  string: (
    o: {
      key: string
      cardinality: Cardinality
      brief: string
      stability: Stability
      examples: ReadonlyArray<string>
      note?: string
      deprecated?: Deprecated
    } & EntryMetaInput,
  ) =>
    annotateWeaver({
      schema: OtelAttr.string({ key: o.key, metadata: { cardinality: o.cardinality } }),
      meta: {
        brief: o.brief,
        stability: o.stability,
        weaverType: 'string',
        examples: o.examples,
        note: o.note,
        deprecated: o.deprecated,
        ...entryMeta(o),
      },
    }),

  number: (
    o: {
      key: string
      weaverType?: 'int' | 'double'
      cardinality?: Cardinality
      brief: string
      stability: Stability
      examples?: ReadonlyArray<number>
      note?: string
    } & EntryMetaInput,
  ) =>
    annotateWeaver({
      schema: OtelAttr.number({
        key: o.key,
        metadata: o.cardinality !== undefined ? { cardinality: o.cardinality } : {},
      }),
      meta: {
        brief: o.brief,
        stability: o.stability,
        weaverType: o.weaverType ?? 'double',
        examples: o.examples,
        note: o.note,
        ...entryMeta(o),
      },
    }),

  boolean: (
    o: { key: string; brief: string; stability: Stability; note?: string } & EntryMetaInput,
  ) =>
    annotateWeaver({
      schema: OtelAttr.boolean({ key: o.key }),
      meta: {
        brief: o.brief,
        stability: o.stability,
        weaverType: 'boolean',
        note: o.note,
        ...entryMeta(o),
      },
    }),

  enum: <const V extends readonly [string, ...string[]]>(
    o: {
      key: string
      values: V
      briefs: Record<V[number], string>
      brief: string
      stability: Stability
      note?: string
      deprecated?: Deprecated
    } & EntryMetaInput,
  ) =>
    annotateWeaver({
      schema: OtelAttr.literal(o.key, ...o.values) as unknown as Schema.Codec<any>,
      meta: {
        brief: o.brief,
        stability: o.stability,
        // weaver 0.24.2 REQUIRES a stability field on every enum member; default to the attr's.
        weaverType: {
          members: o.values.map((v) => ({
            id: v,
            value: v,
            brief: o.briefs[v as V[number]],
            stability: o.stability,
          })),
        },
        note: o.note,
        deprecated: o.deprecated,
        ...entryMeta(o),
      },
    }),

  /**
   * template[...] attribute — a dynamic-key attribute (weaver `template[string]` etc.). The
   * schema underneath is a plain string; the weaver type is carried explicitly because it cannot
   * be reconstructed from the AST.
   */
  template: (
    o: {
      key: string
      templateType: 'string' | 'string[]' | 'int' | 'boolean'
      cardinality: Cardinality
      brief: string
      stability: Stability
      examples?: ReadonlyArray<string>
      note?: string
    } & EntryMetaInput,
  ) =>
    annotateWeaver({
      schema: OtelAttr.string({ key: o.key, metadata: { cardinality: o.cardinality } }),
      meta: {
        brief: o.brief,
        stability: o.stability,
        weaverType: `template[${o.templateType}]` as WeaverType,
        examples: o.examples,
        note: o.note,
        ...entryMeta(o),
      },
    }),
} as const

// ---------------------------------------------------------------------------
// requirement_level (registry axis) mapped to Schema optionality (encoder axis).
// required ⇒ non-optional; recommended / conditionally_required / opt_in ⇒ optional.
// ---------------------------------------------------------------------------

/** A catalog attribute refined with its per-signal requirement level + foreign-ref flag. */
export type Refined = {
  readonly schema: Attribute
  readonly requirement: RequirementLevel
  readonly external: boolean
}
type FieldSpec = Refined | { readonly optional: Refined }

/** Reference an attribute at `required` level (non-optional encoder field). */
export const required = (a: Attribute): Refined => ({
  schema: a,
  requirement: 'required',
  external: false,
})
/** Reference an attribute at `recommended` level (optional encoder field). */
export const recommended = (a: Attribute): { optional: Refined } => ({
  optional: { schema: a, requirement: 'recommended', external: false },
})
/** Reference an attribute at `opt_in` level (optional encoder field). */
export const optIn = (a: Attribute): { optional: Refined } => ({
  optional: { schema: a, requirement: 'opt_in', external: false },
})
/** Reference an attribute at `conditionally_required` level, carrying the condition text. */
export const conditionally = ({
  schema,
  when,
}: {
  schema: Attribute
  when: string
}): { optional: Refined } => ({
  optional: { schema, requirement: { conditionally_required: when }, external: false },
})

/**
 * Mark a ref as foreign (cross-member or upstream). This is what makes the derived-namespace
 * guard work without a listed catalog: own attributes are the UNMARKED refs + doc-only, and an
 * unmarked ref whose key does not share the derived namespace is a HARD ERROR (a typo) rather
 * than being silently reclassified as foreign (decision 0006).
 */
export const refExternal = ({
  schema,
  requirement = 'recommended',
}: {
  schema: Attribute
  requirement?: RequirementLevel
}): { optional: Refined } => ({
  optional: { schema, requirement, external: true },
})

/** Reference a foreign attribute at `required` level (cross-member / upstream). */
export const requiredExternal = (a: Attribute): Refined => ({
  schema: a,
  requirement: 'required',
  external: true,
})

const resolveField = (spec: FieldSpec): { refined: Refined; optional: boolean } =>
  'optional' in spec
    ? { refined: spec.optional, optional: true }
    : { refined: spec, optional: false }

type Ref = { schema: Attribute; requirement: RequirementLevel; external: boolean }

const buildFields = (
  entries: Record<string, FieldSpec>,
): { fields: Schema.Struct.Fields; refList: AttrRef[]; refs: Ref[] } => {
  const fields: Record<string, Schema.Constraint> = {}
  const refList: AttrRef[] = []
  const refs: Ref[] = []
  for (const [field, spec] of Object.entries(entries)) {
    const { refined, optional } = resolveField(spec)
    fields[field] = optional === true ? Schema.optional(refined.schema) : refined.schema
    refList.push({ ref: keyOf(refined.schema), requirement_level: refined.requirement })
    refs.push({
      schema: refined.schema,
      requirement: refined.requirement,
      external: refined.external,
    })
  }
  return { fields, refList, refs }
}

/**
 * Build a `Schema.Struct` from a dynamically-assembled field record. The record is typed with
 * `Schema.Struct.Fields` (so it accepts `Schema.optional(...)` PropertySignatures), which widens
 * the result's `Context` to `unknown`; every field here is a no-context otel attribute, so the
 * cast back to `AnyNoContext` is sound.
 */
const structOf = (fields: Schema.Struct.Fields): Schema.Codec<any> =>
  Schema.Struct(fields) as unknown as Schema.Codec<any>

// ---------------------------------------------------------------------------
// span / metric / operation — compose refs, derive the runtime encoder + weaver signal.
// ---------------------------------------------------------------------------

/** Conditional-spread the per-entry metadata onto a `SignalDef` (keeps `undefined` keys off). */
const signalMetaSpread = (o: EntryMetaInput): SignalMeta => ({
  ...(o.owner !== undefined ? { owner: o.owner } : {}),
  ...(o.source !== undefined ? { source: o.source } : {}),
  ...(o.constName !== undefined ? { constName: o.constName } : {}),
})

/** A span contract: derived encoder + weaver signal projection. */
export type SpanContract = {
  readonly kind: 'span'
  readonly id: string
  readonly encoder: OtelAttrs<Schema.Codec<any>>
  readonly refs: ReadonlyArray<Ref>
  readonly signal: () => SignalDef
}

/**
 * A span. NOTE (SC-T03): `OtelSpan.define` REQUIRES a non-namespaced `span.label` attribute and
 * throws without one, which would pollute the registry. So the encoder is derived directly via
 * `OtelAttrs.defineSync` (the same field plan `OtelSpan.define` would compile) and `span.label`
 * stays runtime-only, filtered from the registry projection.
 */
export const span = (
  o: {
    id: string
    kind: SpanKind
    brief: string
    stability: Stability
    deprecated?: Deprecated
    attributes: Record<string, FieldSpec>
  } & EntryMetaInput,
): SpanContract => {
  const { fields, refList, refs } = buildFields(o.attributes)
  const encoder = OtelAttrs.defineSync(structOf(fields))
  return {
    kind: 'span',
    id: o.id,
    encoder,
    refs,
    signal: (): SignalDef => ({
      kind: 'span',
      id: o.id,
      span_kind: o.kind,
      brief: o.brief,
      stability: o.stability,
      ...(o.deprecated !== undefined ? { deprecated: o.deprecated } : {}),
      ...signalMetaSpread(o),
      attributes: refList,
    }),
  }
}

/** A metric contract: real `OtelMetric` + derived label encoder + weaver signal. */
export type MetricContract = {
  readonly kind: 'metric'
  readonly id: string
  readonly metric: OtelMetricDefinition<Schema.Codec<any>>
  readonly encoder: OtelAttrs<Schema.Codec<any>>
  readonly refs: ReadonlyArray<Ref>
  readonly signal: () => SignalDef
}

/**
 * A metric. Labels are the SAME catalog attributes the spans reference (decision 0003:
 * same-concept-same-key, namespaced). The metric label `restate.service` IS the catalog entry
 * `restate.service` — no short-key metric namespace.
 */
export const metric = (
  o: {
    id: string
    name: string
    instrument: Instrument
    unit: string
    brief: string
    stability: Stability
    deprecated?: Deprecated
    boundaries?: ReadonlyArray<number>
    labels: Record<string, FieldSpec>
  } & EntryMetaInput,
): MetricContract => {
  const { fields, refList, refs } = buildFields(o.labels)
  const labelStruct = structOf(fields)
  // `OtelMetric` has no `updowncounter` constructor. Reject at author time rather than silently
  // falling through to `gauge` (which would disagree with the `updowncounter` registry SignalDef).
  if (o.instrument === 'updowncounter') {
    throw new WeaverUnsupportedInstrumentError({ metricName: o.name, instrument: o.instrument })
  }
  const def: OtelMetricDefinition<Schema.Codec<any>> =
    o.instrument === 'counter'
      ? OtelMetric.counter({
          name: o.name,
          description: o.brief,
          unit: o.unit,
          labels: labelStruct,
        })
      : o.instrument === 'histogram'
        ? OtelMetric.histogram({
            name: o.name,
            description: o.brief,
            unit: o.unit,
            ...(o.boundaries !== undefined ? { boundaries: o.boundaries } : {}),
            labels: labelStruct,
          })
        : OtelMetric.gauge({
            name: o.name,
            description: o.brief,
            unit: o.unit,
            labels: labelStruct,
          })
  return {
    kind: 'metric',
    id: o.id,
    metric: def,
    encoder: def.labels.attributes,
    refs,
    signal: (): SignalDef => ({
      kind: 'metric',
      id: o.id,
      metric_name: o.name,
      instrument: o.instrument,
      unit: o.unit,
      brief: o.brief,
      stability: o.stability,
      ...(o.deprecated !== undefined ? { deprecated: o.deprecated } : {}),
      ...signalMetaSpread(o),
      attributes: refList,
    }),
  }
}

/** An operation contract: label-extractor span + weaver signal projection. */
export type OperationContract = {
  readonly kind: 'operation'
  readonly id: string
  readonly operation: ReturnType<typeof OtelOperation.define>
  readonly refs: ReadonlyArray<Ref>
  readonly signal: () => SignalDef
}

/**
 * An operation: a span whose `span.label` is derived by an extractor. Catalog-ref attributes go
 * in `attributes`; runtime-only drop/label-source fields go in `labelFields` and are excluded
 * from the registry (SC-T03). Emits a `span` signal group.
 */
export const operation = <
  F extends Record<string, FieldSpec>,
  L extends Record<string, Schema.Codec<any>>,
>(
  o: {
    id: string
    name: string
    brief: string
    stability: Stability
    span_kind?: SpanKind
    attributes: F
    labelFields?: L
    label: (value: never) => string
  } & EntryMetaInput,
): OperationContract => {
  const { fields, refList, refs } = buildFields(o.attributes)
  // runtime-only label-source fields — NOT catalog refs, absent from the registry.
  const mutableFields = fields as Record<string, Schema.Constraint>
  for (const [field, schema] of Object.entries(o.labelFields ?? {})) {
    mutableFields[field] = schema
  }
  const op = OtelOperation.define({
    name: o.name,
    schema: structOf(fields),
    label: o.label as (value: unknown) => string,
  })
  return {
    kind: 'operation',
    id: o.id,
    operation: op,
    refs,
    signal: (): SignalDef => ({
      kind: 'span',
      id: o.id,
      span_name: o.name,
      span_kind: o.span_kind ?? 'internal',
      brief: o.brief,
      stability: o.stability,
      ...signalMetaSpread(o),
      attributes: refList,
    }),
  }
}

/** Any authored signal contract (span | metric | operation). */
export type Signal = SpanContract | MetricContract | OperationContract

// ---------------------------------------------------------------------------
// defineOtelContract — the per-package seam (0005). Derives namespace + catalog (0006).
// ---------------------------------------------------------------------------

/** A per-package telemetry contract (the registered seam output). */
export type OtelContract = {
  readonly namespace: string
  readonly memberPath: string
  readonly displayName: string
  readonly signals: ReadonlyArray<Signal>
  readonly docOnlyAttributes: ReadonlyArray<Attribute>
  /**
   * Contract-level metadata defaults (mirror-elimination). `owner` is naturally contract-uniform
   * and `source` is often per-file; both are applied to every projected entry that does NOT carry
   * its own value (per-entry always wins). Additive/optional.
   */
  readonly defaultOwner?: string
  readonly defaultSource?: string
}

/** Project one annotated attribute Schema → Layer 1 `AttrDef` (reads AST annotations). */
export const toAttrDef = (schema: Attribute): AttrDef => {
  const otel = getDeep<{ key?: string; cardinality?: Cardinality; encode?: Encode }>({
    id: OtelAttrAnnotationId,
    ast: schema.ast,
  })
  const weaver = getDeep<WeaverAttrMeta>({ id: WeaverAttrAnnotationId, ast: schema.ast })
  if (otel?.key === undefined) throw new WeaverMissingAnnotationError({ missing: 'otelKey' })
  if (weaver === undefined) {
    throw new WeaverMissingAnnotationError({ key: otel.key, missing: 'weaverMeta' })
  }
  const policy: { cardinality?: Cardinality; encode?: Encode } = {}
  if (otel.cardinality !== undefined) policy.cardinality = otel.cardinality
  if (otel.encode !== undefined) policy.encode = otel.encode
  return {
    id: otel.key,
    type: weaver.weaverType,
    brief: weaver.brief,
    stability: weaver.stability,
    ...(weaver.examples !== undefined ? { examples: weaver.examples } : {}),
    ...(weaver.note !== undefined ? { note: weaver.note } : {}),
    ...(weaver.deprecated !== undefined ? { deprecated: weaver.deprecated } : {}),
    ...(weaver.bridge !== undefined ? { bridge: weaver.bridge } : {}),
    ...(weaver.owner !== undefined ? { owner: weaver.owner } : {}),
    ...(weaver.source !== undefined ? { source: weaver.source } : {}),
    ...(weaver.constName !== undefined ? { constName: weaver.constName } : {}),
    policy,
  }
}

const firstSeg = (k: string): string => k.split('.')[0]!

/**
 * Derive the namespace from the OWN keys (unmarked refs + doc-only) and HARD-ERROR on any that
 * diverge (decision 0006): because foreign refs are marked (`refExternal`), an own key whose
 * prefix differs is a typo — a tagged error, not silently reclassified as foreign.
 */
const deriveNamespaceStrict = ({
  ownKeys,
  memberPath,
}: {
  ownKeys: ReadonlyArray<string>
  memberPath: string
}): string => {
  if (ownKeys.length === 0) throw new WeaverEmptyContractError({ memberPath })
  const ns = firstSeg(ownKeys[0]!)
  for (const k of ownKeys) {
    if (firstSeg(k) !== ns) {
      throw new WeaverStrayNamespaceKeyError({ key: k, derivedNamespace: ns })
    }
  }
  return ns
}

/**
 * defineOtelContract — you author signals (+ optional doc-only attrs); the namespace and catalog
 * are DERIVED. Own attributes = unmarked refs + doc-only; foreign refs are opt-out via
 * `refExternal(...)`.
 */
export const defineOtelContract = (o: {
  memberPath: string
  displayName: string
  signals: ReadonlyArray<Signal>
  docOnlyAttributes?: ReadonlyArray<Attribute>
  /** Contract-level metadata defaults; see {@link OtelContract}. Applied in {@link fragment}. */
  defaultOwner?: string
  defaultSource?: string
}): OtelContract => {
  const doc = o.docOnlyAttributes ?? []
  const ownKeys = new Set<string>()
  for (const s of o.signals) {
    for (const r of s.refs) if (r.external === false) ownKeys.add(keyOf(r.schema))
  }
  for (const a of doc) ownKeys.add(keyOf(a))
  const ns = deriveNamespaceStrict({ ownKeys: [...ownKeys], memberPath: o.memberPath })
  return {
    namespace: ns,
    memberPath: o.memberPath,
    displayName: o.displayName,
    signals: o.signals,
    docOnlyAttributes: doc,
    ...(o.defaultOwner !== undefined ? { defaultOwner: o.defaultOwner } : {}),
    ...(o.defaultSource !== undefined ? { defaultSource: o.defaultSource } : {}),
  }
}

// ---------------------------------------------------------------------------
// The projector (design-time): OtelContract → RegistryFragment.
// ---------------------------------------------------------------------------

/**
 * Fill contract-level `owner`/`source` defaults onto a projected entry that omits its own value
 * (per-entry always wins). Preserves the conditional-spread idiom so no `undefined` key leaks in.
 */
const applyMetaDefaults = <T extends { readonly owner?: string; readonly source?: string }>({
  entry,
  defaultOwner,
  defaultSource,
}: {
  entry: T
  defaultOwner: string | undefined
  defaultSource: string | undefined
}): T => {
  const owner = entry.owner ?? defaultOwner
  const source = entry.source ?? defaultSource
  return {
    ...entry,
    ...(owner !== undefined ? { owner } : {}),
    ...(source !== undefined ? { source } : {}),
  }
}

/** Project a contract to a Layer-1 registry fragment (reads annotations; derives catalog). */
export const fragment = (contract: OtelContract): RegistryFragment => {
  const ownByKey = new Map<string, Attribute>()
  const foreignRefs = new Set<string>()
  for (const s of contract.signals) {
    for (const r of s.refs) {
      const key = keyOf(r.schema)
      if (r.external === true) foreignRefs.add(key)
      else ownByKey.set(key, r.schema)
    }
  }
  for (const a of contract.docOnlyAttributes) ownByKey.set(keyOf(a), a)

  const defaults = { defaultOwner: contract.defaultOwner, defaultSource: contract.defaultSource }
  const ownCatalog = [...ownByKey.values()]
    .map(toAttrDef)
    .map((entry) => applyMetaDefaults({ entry, ...defaults }))
    .toSorted((a, b) => a.id.localeCompare(b.id))
  return {
    namespace: contract.namespace,
    memberPath: contract.memberPath,
    displayName: contract.displayName,
    attributes: ownCatalog,
    foreignRefs: [...foreignRefs].toSorted((a, b) => a.localeCompare(b)),
    signals: contract.signals.map((s) => applyMetaDefaults({ entry: s.signal(), ...defaults })),
  }
}
