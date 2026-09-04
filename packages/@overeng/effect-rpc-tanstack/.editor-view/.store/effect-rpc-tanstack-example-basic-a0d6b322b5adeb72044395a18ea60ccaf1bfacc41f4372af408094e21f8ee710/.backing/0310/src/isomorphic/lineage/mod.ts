/**
 * Lineage annotation namespace for Effect Schema.
 *
 * A standardized vocabulary for the *epistemic* status of a field — is it the
 * source of truth, a projection, a cache, a derivation, etc. — designed to be
 * read by the inspector (and other downstream tools) to surface badges and
 * tooltips without authors having to hand-roll prose in `description`.
 *
 * Design follows the hybrid recommended in the issue: one fat `Lineage`
 * tagged union for the core epistemic kind, plus small focused companion
 * annotations (`Authority`, `Freshness`, `Reference`) for orthogonal concerns
 * that compose freely with any `Lineage` value.
 *
 * @see https://github.com/overengineeringstudio/effect-utils/issues/687
 */

import { Option, Schema, type SchemaAST } from 'effect'

/* --------------------------------------------------------------------------
 * Schemas
 * -------------------------------------------------------------------------- */

/** A reference to another field, schema, or external system. */
export const LineageRef = Schema.Union([
  /** Path relative to the root schema, e.g. `$.foo.bar` (same syntax as `SchemaContext`). */
  Schema.TaggedStruct('Field', { path: Schema.String }),
  /** Reference by schema identifier (the `identifier` annotation). */
  Schema.TaggedStruct('Schema', { identifier: Schema.String }),
  /** Foreign-system reference (e.g. `{ system: 'stripe', ref: 'cus_123' }`). */
  Schema.TaggedStruct('External', { system: Schema.String, ref: Schema.String }),
])
export type LineageRef = typeof LineageRef.Type

/** How a `Derived` field is computed from its inputs. */
export const DerivationKind = Schema.Union([
  Schema.TaggedStruct('Pure', {}),
  Schema.TaggedStruct('Aggregation', {
    op: Schema.Literals(['sum', 'count', 'min', 'max', 'avg', 'custom']),
  }),
  Schema.TaggedStruct('Reduction', { description: Schema.String }),
  Schema.TaggedStruct('External', { service: Schema.String }),
])
export type DerivationKind = typeof DerivationKind.Type

/**
 * The lineage kind for a single field — exactly one variant per annotation.
 *
 * @see https://github.com/overengineeringstudio/effect-utils/issues/687
 */
export const Lineage = Schema.Union([
  Schema.TaggedStruct('SourceOfTruth', {
    owner: Schema.optional(Schema.String),
    system: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct('Derived', {
    from: Schema.Array(LineageRef),
    how: DerivationKind,
    pure: Schema.optional(Schema.Boolean),
  }),
  Schema.TaggedStruct('Projection', {
    of: LineageRef,
    stalenessMs: Schema.optional(Schema.Finite),
  }),
  Schema.TaggedStruct('Cache', {
    of: LineageRef,
    ttlMs: Schema.optional(Schema.Finite),
  }),
  Schema.TaggedStruct('Mirror', {
    of: LineageRef,
    system: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct('External', {
    system: Schema.String,
    ref: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct('Computed', {
    fn: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
  }),
])
export type Lineage = typeof Lineage.Type

/** Who can read/write this field. Composable with any `Lineage`. */
export const Authority = Schema.Struct({
  writers: Schema.Array(Schema.String),
  readers: Schema.optional(Schema.Array(Schema.String)),
})
export type Authority = typeof Authority.Type

/** Temporal freshness of a captured value. */
export const Freshness = Schema.Struct({
  capturedAt: Schema.optional(Schema.Literals(['now', 'event-time', 'snapshot'])),
  maxAgeMs: Schema.optional(Schema.Finite),
})
export type Freshness = typeof Freshness.Type

/** Cross-entity reference (foreign key). */
export const Reference = Schema.TaggedStruct('ForeignKey', {
  targetSchema: Schema.String,
  targetField: Schema.optional(Schema.String),
})
export type Reference = typeof Reference.Type

/* --------------------------------------------------------------------------
 * Annotation symbols
 * -------------------------------------------------------------------------- */

/** Annotation symbol for the `Lineage` annotation. */
export const LineageAnnotationId = Symbol.for('effect/annotation/Lineage')
/** Annotation symbol for the `Authority` annotation. */
export const AuthorityAnnotationId = Symbol.for('effect/annotation/Authority')
/** Annotation symbol for the `Freshness` annotation. */
export const FreshnessAnnotationId = Symbol.for('effect/annotation/Freshness')
/** Annotation symbol for the `Reference` annotation. */
export const ReferenceAnnotationId = Symbol.for('effect/annotation/Reference')

/* --------------------------------------------------------------------------
 * Extraction helpers
 * -------------------------------------------------------------------------- */

/*
 * Mirror of `unwrapAstForDisplay` from `effectSchema.tsx`, kept local so this
 * module has no cross-file coupling. Walks encoding links (v4 transformations),
 * suspended schemas, and trivial single-member Unions so annotations on either
 * the outer or inner layer are discoverable.
 */
const isNullishAst = (ast: SchemaAST.AST): boolean => {
  if (ast._tag === 'Undefined' || ast._tag === 'Void') return true
  return ast._tag === 'Literal' && ast.literal === null
}

const unwrapAst = (ast: SchemaAST.AST): SchemaAST.AST => {
  // v4: transformations are attached to nodes as encoding links; the linked
  // node is the counterpart layer (the v3 `Transformation.to` / `Refinement.from` walk).
  const firstLink = Array.isArray(ast.encoding) === true ? ast.encoding[0] : undefined
  if (firstLink !== undefined) return unwrapAst(firstLink.to)
  switch (ast._tag) {
    case 'Suspend':
      try {
        return unwrapAst(ast.thunk())
      } catch {
        return ast
      }
    case 'Union': {
      const nonNullish = ast.types.filter((m) => !isNullishAst(m))
      if (nonNullish.length === 1) {
        const [only] = nonNullish
        if (only !== undefined) return unwrapAst(only)
      }
      return ast
    }
    default:
      return ast
  }
}

/** v4 annotation records are string-keyed at the type level but hold symbol keys at runtime */
const readSymbolAnnotation = ({ ast, id }: { ast: SchemaAST.AST; id: symbol }): unknown => {
  const annotations = ast.annotations as Record<symbol, unknown> | undefined
  if (annotations === undefined) return undefined
  return annotations[id]
}

/*
 * Generic, fail-soft annotation reader. Tries the raw AST first (so wrapper
 * annotations win), then the unwrapped AST. Validates via the matching
 * schema decoder; a corrupt or unrecognized value yields `undefined` rather
 * than throwing — the inspector must never crash on bad annotations.
 */
const readAnnotation = <A>(args: {
  schema: Schema.Top
  id: symbol
  decoder: Schema.ConstraintDecoder<A>
}): A | undefined => {
  const { schema, id, decoder } = args
  const decode = Schema.decodeUnknownOption(decoder)
  const raw = readSymbolAnnotation({ ast: schema.ast, id })
  if (raw !== undefined) {
    const decoded = decode(raw)
    if (Option.isSome(decoded) === true) return decoded.value
  }
  const unwrapped = unwrapAst(schema.ast)
  if (unwrapped !== schema.ast) {
    const innerRaw = readSymbolAnnotation({ ast: unwrapped, id })
    if (innerRaw !== undefined) {
      const decoded = decode(innerRaw)
      if (Option.isSome(decoded) === true) return decoded.value
    }
  }
  return undefined
}

/** Read the `Lineage` annotation from a schema, if present. */
export const getLineage = (schema: Schema.Top): Lineage | undefined =>
  readAnnotation({ schema, id: LineageAnnotationId, decoder: Lineage })

/** Read the `Authority` annotation from a schema, if present. */
export const getAuthority = (schema: Schema.Top): Authority | undefined =>
  readAnnotation({ schema, id: AuthorityAnnotationId, decoder: Authority })

/** Read the `Freshness` annotation from a schema, if present. */
export const getFreshness = (schema: Schema.Top): Freshness | undefined =>
  readAnnotation({ schema, id: FreshnessAnnotationId, decoder: Freshness })

/** Read the `Reference` annotation from a schema, if present. */
export const getReference = (schema: Schema.Top): Reference | undefined =>
  readAnnotation({ schema, id: ReferenceAnnotationId, decoder: Reference })

/* --------------------------------------------------------------------------
 * Ergonomic constructors
 *
 * Each returns a `Schema -> Schema` function suitable for `.pipe(...)`, e.g.
 *   Schema.Number.pipe(derivedFrom({ from: ['subtotal', 'tax'] }))
 * -------------------------------------------------------------------------- */

const fieldRef = (path: string): LineageRef => ({
  _tag: 'Field',
  /* Normalize: bare names become root-relative paths, matching SchemaContext. */
  path: path.startsWith('$') === true ? path : `$.${path}`,
})

const coerceRef = (ref: string | LineageRef): LineageRef =>
  typeof ref === 'string' ? fieldRef(ref) : ref

const coerceDerivationKind = (
  how: DerivationKind | DerivationKind['_tag'] | undefined,
): DerivationKind => {
  if (how === undefined) return { _tag: 'Pure' }
  if (typeof how !== 'string') return how
  switch (how) {
    case 'Pure':
      return { _tag: 'Pure' }
    case 'Aggregation':
      return { _tag: 'Aggregation', op: 'custom' }
    case 'Reduction':
      return { _tag: 'Reduction', description: '' }
    case 'External':
      return { _tag: 'External', service: '' }
  }
}

const annotate =
  <V>(args: { id: symbol; value: V }) =>
  <S extends Schema.Top>(schema: S): S =>
    schema.annotate({ [args.id as unknown as string]: args.value }) as unknown as S

const lineageAnnotation =
  (value: Lineage) =>
  <S extends Schema.Top>(schema: S): S =>
    annotate({ id: LineageAnnotationId, value })(schema)

/** Mark a field as the authoritative source of truth. */
export const sourceOfTruth = (opts?: { owner?: string; system?: string }) =>
  lineageAnnotation({ _tag: 'SourceOfTruth', ...opts })

/** Mark a field as derived from one or more upstream fields. */
export const derivedFrom = (args: {
  from: ReadonlyArray<string | LineageRef>
  how?: DerivationKind | DerivationKind['_tag']
  pure?: boolean
}) =>
  lineageAnnotation({
    _tag: 'Derived',
    from: args.from.map(coerceRef),
    how: coerceDerivationKind(args.how),
    ...(args.pure !== undefined ? { pure: args.pure } : {}),
  })

/** Mark a field as a (possibly stale) projection of another field. */
export const projection = (args: { of: string | LineageRef; stalenessMs?: number }) =>
  lineageAnnotation({
    _tag: 'Projection',
    of: coerceRef(args.of),
    ...(args.stalenessMs !== undefined ? { stalenessMs: args.stalenessMs } : {}),
  })

/** Mark a field as a cached copy of another field, with optional TTL. */
export const cache = (args: { of: string | LineageRef; ttlMs?: number }) =>
  lineageAnnotation({
    _tag: 'Cache',
    of: coerceRef(args.of),
    ...(args.ttlMs !== undefined ? { ttlMs: args.ttlMs } : {}),
  })

/** Mark a field as a mirror of another field, optionally from a foreign system. */
export const mirror = (args: { of: string | LineageRef; system?: string }) =>
  lineageAnnotation({
    _tag: 'Mirror',
    of: coerceRef(args.of),
    ...(args.system !== undefined ? { system: args.system } : {}),
  })

/** Mark a field as an external reference (e.g. an opaque foreign-system id). */
export const external = (args: { system: string; ref?: string }) =>
  lineageAnnotation(
    args.ref !== undefined
      ? { _tag: 'External', system: args.system, ref: args.ref }
      : { _tag: 'External', system: args.system },
  )

/** Mark a field as computed at read time (not persisted). */
export const computed = (opts?: { fn?: string; description?: string }) =>
  lineageAnnotation({ _tag: 'Computed', ...opts })

/** Attach an `Authority` annotation describing readers/writers. */
export const authority = (a: Authority) => annotate({ id: AuthorityAnnotationId, value: a })
/** Attach a `Freshness` annotation describing temporal capture semantics. */
export const freshness = (f: Freshness) => annotate({ id: FreshnessAnnotationId, value: f })
/** Attach a `ForeignKey` reference annotation pointing at another schema. */
export const foreignKey = (args: { targetSchema: string; targetField?: string }) =>
  annotate({
    id: ReferenceAnnotationId,
    value:
      args.targetField !== undefined
        ? { _tag: 'ForeignKey', targetSchema: args.targetSchema, targetField: args.targetField }
        : { _tag: 'ForeignKey', targetSchema: args.targetSchema },
  })

/* --------------------------------------------------------------------------
 * Display-ready bundle
 * -------------------------------------------------------------------------- */

/** Pre-rendered strings the inspector can drop into a badge + tooltip. */
export interface LineageDisplay {
  /** Single-glyph badge to render inline with the field label. */
  badge: string
  /** Tooltip text for the badge alone (no kind label). */
  badgeTitle: string
  /** User-facing kind label, e.g. `"Source of truth"`, `"Derived"`. */
  kindLabel: string
  /** One-line summary for the tooltip body. */
  summary: string
  /** Optional extra `label: value` lines for the tooltip body. */
  details?: ReadonlyArray<{ label: string; value: string }>
}

const refToString = (ref: LineageRef): string => {
  switch (ref._tag) {
    case 'Field':
      return ref.path
    case 'Schema':
      return ref.identifier
    case 'External':
      return `${ref.system}:${ref.ref}`
  }
}

const derivationToString = (how: DerivationKind): string => {
  switch (how._tag) {
    case 'Pure':
      return 'pure'
    case 'Aggregation':
      return `aggregation (${how.op})`
    case 'Reduction':
      return how.description !== '' ? `reduction: ${how.description}` : 'reduction'
    case 'External':
      return how.service !== '' ? `external service: ${how.service}` : 'external service'
  }
}

type Detail = { label: string; value: string }

const withDetails = (args: {
  base: Omit<LineageDisplay, 'details'>
  details: ReadonlyArray<Detail>
}): LineageDisplay =>
  args.details.length > 0 ? { ...args.base, details: args.details } : args.base

/** Build a pre-rendered display bundle for a `Lineage` value. */
export const getLineageDisplay = (lineage: Lineage): LineageDisplay => {
  switch (lineage._tag) {
    case 'SourceOfTruth': {
      const parts: Detail[] = []
      if (lineage.owner !== undefined) parts.push({ label: 'owner', value: lineage.owner })
      if (lineage.system !== undefined) parts.push({ label: 'system', value: lineage.system })
      return withDetails({
        base: {
          badge: '⇆',
          badgeTitle: 'Source of truth',
          kindLabel: 'Source of truth',
          summary:
            lineage.system !== undefined ? `Owned by ${lineage.system}` : 'Authoritative value',
        },
        details: parts,
      })
    }
    case 'Derived': {
      const fromList = lineage.from.map(refToString).join(', ')
      const how = derivationToString(lineage.how)
      return withDetails({
        base: {
          badge: 'ƒ',
          badgeTitle: `Derived from ${fromList}`,
          kindLabel: 'Derived',
          summary: `${how} of ${fromList}`,
        },
        details: lineage.pure === true ? [{ label: 'pure', value: 'true' }] : [],
      })
    }
    case 'Projection': {
      const of = refToString(lineage.of)
      return withDetails({
        base: {
          badge: '≈',
          badgeTitle: `Projection of ${of}`,
          kindLabel: 'Projection',
          summary: `Projection of ${of}`,
        },
        details:
          lineage.stalenessMs !== undefined
            ? [{ label: 'staleness', value: `${lineage.stalenessMs}ms` }]
            : [],
      })
    }
    case 'Cache': {
      const of = refToString(lineage.of)
      return withDetails({
        base: {
          badge: '☷',
          badgeTitle: `Cache of ${of}`,
          kindLabel: 'Cache',
          summary: `Cached value of ${of}`,
        },
        details: lineage.ttlMs !== undefined ? [{ label: 'ttl', value: `${lineage.ttlMs}ms` }] : [],
      })
    }
    case 'Mirror': {
      const of = refToString(lineage.of)
      return withDetails({
        base: {
          badge: '↻',
          badgeTitle: `Mirror of ${of}`,
          kindLabel: 'Mirror',
          summary:
            lineage.system !== undefined
              ? `Mirror of ${of} from ${lineage.system}`
              : `Mirror of ${of}`,
        },
        details: lineage.system !== undefined ? [{ label: 'system', value: lineage.system }] : [],
      })
    }
    case 'External': {
      return {
        badge: '↗',
        badgeTitle: `External (${lineage.system})`,
        kindLabel: 'External',
        summary:
          lineage.ref !== undefined
            ? `External reference ${lineage.system}:${lineage.ref}`
            : `External reference in ${lineage.system}`,
        details: [{ label: 'system', value: lineage.system }],
      }
    }
    case 'Computed': {
      return withDetails({
        base: {
          badge: '⊙',
          badgeTitle: 'Computed (not persisted)',
          kindLabel: 'Computed',
          summary: lineage.description ?? lineage.fn ?? 'Computed at read time',
        },
        details: lineage.fn !== undefined ? [{ label: 'fn', value: lineage.fn }] : [],
      })
    }
  }
}
