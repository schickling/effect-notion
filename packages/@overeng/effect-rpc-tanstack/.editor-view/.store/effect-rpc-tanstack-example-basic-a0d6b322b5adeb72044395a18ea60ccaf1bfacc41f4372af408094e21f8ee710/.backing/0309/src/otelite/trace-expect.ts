import { Exit, Schema } from 'effect'

import type { SpanRow } from './schema.ts'

/** Literal expectation for an attribute; `null` matches the literal string `'null'` since otelite rows are flat strings. */
export type AttrPrimitive = string | number | boolean | null

/** Custom matcher run against an attribute's raw string value plus its owning span. */
export type AttrPredicate = (actual: string, span: SpanRow) => boolean

/** All ways to assert one attribute: a primitive, a `RegExp`, presence-only, a predicate, or a schema decode. */
export type AttrMatcher =
  | AttrPrimitive
  | RegExp
  | {
      readonly _tag: 'Present'
    }
  | {
      readonly _tag: 'Predicate'
      readonly description: string
      readonly predicate: AttrPredicate
    }
  | {
      readonly _tag: 'Schema'
      readonly description: string
      readonly matches: (actual: string) => boolean
    }

type StructuredAttrMatcher = Exclude<AttrMatcher, AttrPrimitive | RegExp>

/** Map of attribute key to matcher; every entry must match (the key must be present) for a span to pass. */
export type AttrExpectations = Readonly<Record<string, AttrMatcher>>

/** Span filter predicate; each set field narrows, and `requireLabel` additionally gates on a present `span.label`. */
export interface SpanSelector {
  readonly name?: string
  readonly service?: string
  readonly attrs?: AttrExpectations
  readonly traceId?: string | null
  readonly requireLabel?: boolean
}

/** Structural view of a compiled schema-backed OTEL attribute contract. */
export interface OtelAttrsContract<A> {
  readonly unsafeEncode: (value: A) => Readonly<Record<string, string | number | boolean>>
}

/** Structural view of a named schema-backed OTEL span contract. */
export interface OtelSpanContract<A> {
  readonly name: string
  readonly attributes: OtelAttrsContract<A>
}

/** Selector that derives otelite row matchers from a compiled attribute contract. */
export interface ContractAttributesSelector<A> {
  readonly attributes: OtelAttrsContract<A>
  readonly match: A
  readonly selector?: Omit<SpanSelector, 'attrs'>
}

/** Selector that derives name, label policy, and attributes from a compiled span contract. */
export interface ContractSpanSelector<A> {
  readonly span: OtelSpanContract<A>
  readonly match: A
  readonly selector?: Omit<SpanSelector, 'name' | 'attrs' | 'requireLabel'>
}

/** Thrown by every failing `TraceExpect` assertion; the message names the accumulated selector chain. */
export class TraceExpectError extends Error {
  readonly _tag = 'TraceExpectError'
}

/** Matcher constructors for {@link AttrExpectations}; `boolean`/`int` stringify since otelite rows store all attrs as strings. */
export const attr = {
  present: (): AttrMatcher => ({ _tag: 'Present' }),
  boolean: (expected: boolean): AttrMatcher => String(expected),
  int: (expected: number): AttrMatcher => String(expected),
  predicate: (description: string, predicate: AttrPredicate): AttrMatcher => ({
    _tag: 'Predicate',
    description,
    predicate,
  }),
  schema: <S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    description = String(schema.ast.annotations?.identifier ?? 'schema'),
  ): AttrMatcher => ({
    _tag: 'Schema',
    description,
    matches: (actual) => Exit.isSuccess(Schema.decodeUnknownExit(schema)(actual)),
  }),
  json: <S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    description = String(schema.ast.annotations?.identifier ?? 'json schema'),
  ): AttrMatcher => ({
    _tag: 'Schema',
    description,
    matches: (actual) =>
      Exit.isSuccess(Schema.decodeUnknownExit(Schema.fromJsonString(schema))(actual)),
  }),
} as const

/** Shorthand for an `AttrExpectations` over the `span.label` key; defaults to presence-only. */
export const spanLabel = (matcher: AttrMatcher = attr.present()): AttrExpectations => ({
  'span.label': matcher,
})

/** Entry point: lift captured spans into a chainable {@link TraceExpect}. */
export const expectTrace = (spans: readonly SpanRow[]) => TraceExpect.from(spans)

/** Immutable, chainable assertion builder over captured spans; each `filter`/`span`/`service` returns a narrowed copy. */
export class TraceExpect {
  static from(spans: readonly SpanRow[]): TraceExpect {
    return new TraceExpect(spans, [])
  }

  private constructor(
    readonly spans: readonly SpanRow[],
    private readonly filters: readonly string[],
  ) {}

  findByName(name: string): readonly SpanRow[] {
    return this.filter({ name }).spans
  }

  span(name: string): TraceExpect {
    return this.filter({ name })
  }

  service(service: string): TraceExpect {
    return this.filter({ service })
  }

  attrs(attrs: AttrExpectations): TraceExpect {
    return this.filter({ attrs })
  }

  requireLabel(): TraceExpect {
    return this.filter({ requireLabel: true })
  }

  filter(selector: SpanSelector): TraceExpect {
    return new TraceExpect(
      this.spans.filter((span) => matchesSelector(span, selector)),
      [...this.filters, describeSelector(selector)],
    )
  }

  expectSome(selector: SpanSelector = {}): readonly SpanRow[] {
    const matches = this.filter(selector).spans
    if (matches.length === 0) {
      throw new TraceExpectError(`Expected at least one span matching ${this.describe(selector)}`)
    }
    return matches
  }

  expectOne(selector: SpanSelector = {}): SpanRow {
    const matches = this.filter(selector).spans
    if (matches.length !== 1) {
      throw new TraceExpectError(
        `Expected exactly one span matching ${this.describe(selector)}, found ${matches.length}`,
      )
    }
    return matches[0]!
  }

  sameTrace(selector: SpanSelector = {}): string {
    const matches = this.expectSome(selector)
    const traceIds = new Set(matches.map((span) => span.trace_id).filter((id) => id !== null))
    if (traceIds.size !== 1) {
      throw new TraceExpectError(
        `Expected spans matching ${this.describe(selector)} to share one non-null trace_id, found ${traceIds.size}`,
      )
    }
    return Array.from(traceIds)[0]!
  }

  expectSpanLabels(selector: SpanSelector = {}): readonly SpanRow[] {
    const matches = this.expectSome(selector)
    const missingLabels = matches.filter((span) => span.attrs['span.label'] === undefined)
    if (missingLabels.length > 0) {
      throw new TraceExpectError(
        `Expected every span matching ${this.describe(selector)} to include span.label, ${missingLabels.length} missing`,
      )
    }
    return matches
  }

  expectAttributes<A>(selector: ContractAttributesSelector<A>): readonly SpanRow[] {
    return this.expectSome({
      ...selector.selector,
      attrs: contractAttrs(selector.attributes, selector.match),
    })
  }

  expectSpan<A>(selector: ContractSpanSelector<A>): SpanRow {
    return this.expectOne({
      ...selector.selector,
      name: selector.span.name,
      attrs: contractAttrs(selector.span.attributes, selector.match),
      requireLabel: true,
    })
  }

  expectSameTrace(selectors: readonly SpanSelector[]): string {
    const spans = selectors.map((selector) => this.expectOne(selector))
    const traceIds = new Set(spans.map((span) => span.trace_id).filter((id) => id !== null))
    if (traceIds.size !== 1) {
      throw new TraceExpectError(
        `Expected ${selectors.length} selected spans to share one non-null trace_id, found ${traceIds.size}`,
      )
    }
    return Array.from(traceIds)[0]!
  }

  private describe(selector: SpanSelector): string {
    const parts = [...this.filters, describeSelector(selector)].filter((part) => part !== '*')
    return parts.length === 0 ? '*' : parts.join(' + ')
  }
}

const matchesSelector = (span: SpanRow, selector: SpanSelector): boolean => {
  if (selector.name !== undefined && span.name !== selector.name) return false
  if (selector.service !== undefined && span.service !== selector.service) return false
  if (selector.traceId !== undefined && span.trace_id !== selector.traceId) return false
  if (selector.requireLabel === true && span.attrs['span.label'] === undefined) return false
  if (selector.attrs !== undefined && matchesAttrs(span, selector.attrs) === false) return false
  return true
}

const matchesAttrs = (span: SpanRow, attrs: AttrExpectations): boolean =>
  Object.entries(attrs).every(([key, matcher]) => {
    const actual = span.attrs[key]
    if (actual === undefined) return false
    return matchesAttr(actual, matcher, span)
  })

const matchesAttr = (actual: string, matcher: AttrMatcher, span: SpanRow): boolean => {
  if (matcher instanceof RegExp) return matcher.test(actual)
  if (isStructuredAttrMatcher(matcher) === true) {
    switch (matcher._tag) {
      case 'Present':
        return true
      case 'Predicate':
        return matcher.predicate(actual, span)
      case 'Schema':
        return matcher.matches(actual)
    }
  }
  return actual === normalizeAttrPrimitive(matcher)
}

const contractAttrs = <A>(attributes: OtelAttrsContract<A>, match: A): AttrExpectations =>
  Object.fromEntries(
    Object.entries(attributes.unsafeEncode(match)).map(([key, value]) => {
      if (Array.isArray(value) === true) {
        throw new TraceExpectError(
          `Cannot match array-valued OTEL attribute ${key} against otelite flat rows`,
        )
      }
      return [key, value]
    }),
  )

const isStructuredAttrMatcher = (matcher: AttrMatcher): matcher is StructuredAttrMatcher =>
  typeof matcher === 'object' &&
  matcher !== null &&
  !(matcher instanceof RegExp) &&
  '_tag' in matcher

const normalizeAttrPrimitive = (value: AttrPrimitive): string => {
  if (value === null) return 'null'
  return String(value)
}

const describeSelector = (selector: SpanSelector): string => {
  const parts = [
    selector.name === undefined ? undefined : `name=${selector.name}`,
    selector.service === undefined ? undefined : `service=${selector.service}`,
    selector.traceId === undefined ? undefined : `trace_id=${selector.traceId}`,
    selector.requireLabel === true ? 'span.label present' : undefined,
    selector.attrs === undefined ? undefined : `attrs=${describeAttrs(selector.attrs)}`,
  ].filter((part) => part !== undefined)
  return parts.length === 0 ? '*' : parts.join(',')
}

const describeAttrs = (attrs: AttrExpectations): string =>
  Object.entries(attrs)
    .map(([key, matcher]) => `${key}:${describeMatcher(matcher)}`)
    .join(',')

const describeMatcher = (matcher: AttrMatcher): string => {
  if (matcher instanceof RegExp) return matcher.toString()
  if (isStructuredAttrMatcher(matcher) === true) {
    switch (matcher._tag) {
      case 'Present':
        return 'present'
      case 'Predicate':
        return matcher.description
      case 'Schema':
        return matcher.description
    }
  }
  return normalizeAttrPrimitive(matcher)
}
