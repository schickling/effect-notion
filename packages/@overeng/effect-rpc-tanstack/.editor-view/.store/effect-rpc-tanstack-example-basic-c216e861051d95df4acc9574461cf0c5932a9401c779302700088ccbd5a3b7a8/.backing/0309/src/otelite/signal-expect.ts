import { Exit, Schema } from 'effect'

import type { LogRow, MetricRow } from './schema.ts'

/** Literal attribute expectation for metric/log rows; `null` matches the literal string `'null'` (rows are flat strings). */
export type TelemetryAttrPrimitive = string | number | boolean | null

/** Custom matcher run against an attribute's raw string value plus its owning metric or log row. */
export type TelemetryAttrPredicate<Row> = (actual: string, row: Row) => boolean

/** Row-generic counterpart to the trace `AttrMatcher`: primitive, `RegExp`, presence, predicate, or schema decode. */
export type TelemetryAttrMatcher<Row> =
  | TelemetryAttrPrimitive
  | RegExp
  | {
      readonly _tag: 'Present'
    }
  | {
      readonly _tag: 'Predicate'
      readonly description: string
      readonly predicate: TelemetryAttrPredicate<Row>
    }
  | {
      readonly _tag: 'Schema'
      readonly description: string
      readonly matches: (actual: string) => boolean
    }

type StructuredTelemetryAttrMatcher<Row> = Exclude<
  TelemetryAttrMatcher<Row>,
  TelemetryAttrPrimitive | RegExp
>

/** Map of attribute key to matcher; every entry must match (and its key be present) for a row to pass. */
export type TelemetryAttrExpectations<Row> = Readonly<Record<string, TelemetryAttrMatcher<Row>>>

/** Assertion over a metric's numeric `value`: exact number, presence-only, or a custom predicate. */
export type MetricValueMatcher =
  | number
  | {
      readonly _tag: 'Present'
    }
  | {
      readonly _tag: 'Predicate'
      readonly description: string
      readonly predicate: (actual: number, row: MetricRow) => boolean
    }

/** Metric filter predicate; set fields narrow, and `value` matches the numeric data point rather than an attribute. */
export interface MetricSelector {
  readonly name?: string
  readonly service?: string
  readonly type?: string
  readonly unit?: string
  readonly attrs?: TelemetryAttrExpectations<MetricRow>
  readonly value?: MetricValueMatcher
}

/** Log-record filter predicate; `body` accepts a string or `RegExp`, and `scope`/`traceId`/`spanId` may be `null` to match unset. */
export interface LogSelector {
  readonly service?: string
  readonly scope?: string | null
  readonly body?: string | RegExp
  readonly severityText?: string
  readonly severityNumber?: number
  readonly attrs?: TelemetryAttrExpectations<LogRow>
  readonly traceId?: string | null
  readonly spanId?: string | null
}

/** Structural view of schema-backed metric labels, before OtelMetric exists. */
export interface OtelMetricLabelsContract<A> {
  readonly unsafeEncode: (value: A) => Readonly<Record<string, string | number | boolean>>
}

/** Selector that derives a metric's name, unit, type, and label matchers from a compiled schema-backed contract. */
export interface ContractMetricSelector<A> {
  readonly metric: {
    readonly name: string
    readonly labels?: OtelMetricLabelsContract<A>
    readonly unit?: string
    readonly type?: string
  }
  readonly match?: A
  readonly selector?: Omit<MetricSelector, 'name' | 'attrs' | 'unit' | 'type'>
}

/** Thrown by every failing `MetricExpect`/`LogExpect` assertion; the message names the accumulated selector chain. */
export class TelemetryExpectError extends Error {
  readonly _tag = 'TelemetryExpectError'
}

/** Row-generic matcher constructors for {@link TelemetryAttrExpectations}; `boolean`/`int` stringify (rows store attrs as strings). */
export const telemetryAttr = {
  present: <Row>(): TelemetryAttrMatcher<Row> => ({ _tag: 'Present' }),
  boolean: <Row>(expected: boolean): TelemetryAttrMatcher<Row> => String(expected),
  int: <Row>(expected: number): TelemetryAttrMatcher<Row> => String(expected),
  predicate: <Row>(
    description: string,
    predicate: TelemetryAttrPredicate<Row>,
  ): TelemetryAttrMatcher<Row> => ({
    _tag: 'Predicate',
    description,
    predicate,
  }),
  schema: <Row, S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    description = String(schema.ast.annotations?.identifier ?? 'schema'),
  ): TelemetryAttrMatcher<Row> => ({
    _tag: 'Schema',
    description,
    matches: (actual) => Exit.isSuccess(Schema.decodeUnknownExit(schema)(actual)),
  }),
  json: <Row, S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    description = String(schema.ast.annotations?.identifier ?? 'json schema'),
  ): TelemetryAttrMatcher<Row> => ({
    _tag: 'Schema',
    description,
    matches: (actual) =>
      Exit.isSuccess(Schema.decodeUnknownExit(Schema.fromJsonString(schema))(actual)),
  }),
} as const

/** Constructors for {@link MetricValueMatcher} (presence or predicate); pass a bare number for an exact-value match. */
export const metricValue = {
  present: (): MetricValueMatcher => ({ _tag: 'Present' }),
  predicate: (
    description: string,
    predicate: (actual: number, row: MetricRow) => boolean,
  ): MetricValueMatcher => ({
    _tag: 'Predicate',
    description,
    predicate,
  }),
} as const

/** Entry point: lift captured metric rows into a chainable {@link MetricExpect}. */
export const expectMetrics = (metrics: readonly MetricRow[]) => MetricExpect.from(metrics)

/** Entry point: lift captured log rows into a chainable {@link LogExpect}. */
export const expectLogs = (logs: readonly LogRow[]) => LogExpect.from(logs)

/** Immutable, chainable assertion builder over captured metric rows; each filter step returns a narrowed copy. */
export class MetricExpect {
  static from(metrics: readonly MetricRow[]): MetricExpect {
    return new MetricExpect(metrics, [])
  }

  private constructor(
    readonly metrics: readonly MetricRow[],
    private readonly filters: readonly string[],
  ) {}

  metric(name: string): MetricExpect {
    return this.filter({ name })
  }

  service(service: string): MetricExpect {
    return this.filter({ service })
  }

  attrs(attrs: TelemetryAttrExpectations<MetricRow>): MetricExpect {
    return this.filter({ attrs })
  }

  filter(selector: MetricSelector): MetricExpect {
    return new MetricExpect(
      this.metrics.filter((metric) => matchesMetricSelector(metric, selector)),
      [...this.filters, describeMetricSelector(selector)],
    )
  }

  expectSome(selector: MetricSelector = {}): readonly MetricRow[] {
    const matches = this.filter(selector).metrics
    if (matches.length === 0) {
      throw new TelemetryExpectError(
        `Expected at least one metric matching ${this.describe(selector)}`,
      )
    }
    return matches
  }

  expectOne(selector: MetricSelector = {}): MetricRow {
    const matches = this.filter(selector).metrics
    if (matches.length !== 1) {
      throw new TelemetryExpectError(
        `Expected exactly one metric matching ${this.describe(selector)}, found ${matches.length}`,
      )
    }
    return matches[0]!
  }

  expectMetric<A>(selector: ContractMetricSelector<A>): MetricRow {
    const contractSelector: MetricSelector = {
      ...selector.selector,
      name: selector.metric.name,
      ...(selector.metric.unit === undefined ? {} : { unit: selector.metric.unit }),
      ...(selector.metric.type === undefined ? {} : { type: selector.metric.type }),
      ...(selector.metric.labels !== undefined && selector.match !== undefined
        ? { attrs: contractAttrs(selector.metric.labels, selector.match) }
        : {}),
    }
    return this.expectOne(contractSelector)
  }

  private describe(selector: MetricSelector): string {
    const parts = [...this.filters, describeMetricSelector(selector)].filter((part) => part !== '*')
    return parts.length === 0 ? '*' : parts.join(' + ')
  }
}

/** Immutable, chainable assertion builder over captured log rows; each filter step returns a narrowed copy. */
export class LogExpect {
  static from(logs: readonly LogRow[]): LogExpect {
    return new LogExpect(logs, [])
  }

  private constructor(
    readonly logs: readonly LogRow[],
    private readonly filters: readonly string[],
  ) {}

  service(service: string): LogExpect {
    return this.filter({ service })
  }

  severity(severityText: string): LogExpect {
    return this.filter({ severityText })
  }

  attrs(attrs: TelemetryAttrExpectations<LogRow>): LogExpect {
    return this.filter({ attrs })
  }

  filter(selector: LogSelector): LogExpect {
    return new LogExpect(
      this.logs.filter((log) => matchesLogSelector(log, selector)),
      [...this.filters, describeLogSelector(selector)],
    )
  }

  expectSome(selector: LogSelector = {}): readonly LogRow[] {
    const matches = this.filter(selector).logs
    if (matches.length === 0) {
      throw new TelemetryExpectError(
        `Expected at least one log matching ${this.describe(selector)}`,
      )
    }
    return matches
  }

  expectOne(selector: LogSelector = {}): LogRow {
    const matches = this.filter(selector).logs
    if (matches.length !== 1) {
      throw new TelemetryExpectError(
        `Expected exactly one log matching ${this.describe(selector)}, found ${matches.length}`,
      )
    }
    return matches[0]!
  }

  private describe(selector: LogSelector): string {
    const parts = [...this.filters, describeLogSelector(selector)].filter((part) => part !== '*')
    return parts.length === 0 ? '*' : parts.join(' + ')
  }
}

const matchesMetricSelector = (metric: MetricRow, selector: MetricSelector): boolean => {
  if (selector.name !== undefined && metric.name !== selector.name) return false
  if (selector.service !== undefined && metric.service !== selector.service) return false
  if (selector.type !== undefined && metric.type !== selector.type) return false
  if (selector.unit !== undefined && metric.unit !== selector.unit) return false
  if (selector.value !== undefined && matchesMetricValue(metric, selector.value) === false)
    return false
  if (selector.attrs !== undefined && matchesAttrs(metric, selector.attrs) === false) return false
  return true
}

const matchesLogSelector = (log: LogRow, selector: LogSelector): boolean => {
  if (selector.service !== undefined && log.service !== selector.service) return false
  if (selector.scope !== undefined && log.scope !== selector.scope) return false
  if (selector.severityText !== undefined && log.severity_text !== selector.severityText) {
    return false
  }
  if (selector.severityNumber !== undefined && log.severity_number !== selector.severityNumber) {
    return false
  }
  if (selector.traceId !== undefined && log.trace_id !== selector.traceId) return false
  if (selector.spanId !== undefined && log.span_id !== selector.spanId) return false
  if (selector.body !== undefined) {
    const bodyMatches =
      selector.body instanceof RegExp ? selector.body.test(log.body) : log.body === selector.body
    if (bodyMatches === false) return false
  }
  if (selector.attrs !== undefined && matchesAttrs(log, selector.attrs) === false) return false
  return true
}

const matchesMetricValue = (metric: MetricRow, matcher: MetricValueMatcher): boolean => {
  if (metric.value === undefined) return false
  if (typeof matcher === 'number') return metric.value === matcher
  switch (matcher._tag) {
    case 'Present':
      return true
    case 'Predicate':
      return matcher.predicate(metric.value, metric)
  }
}

const matchesAttrs = <Row extends { readonly attrs: Readonly<Record<string, string>> }>(
  row: Row,
  attrs: TelemetryAttrExpectations<Row>,
): boolean =>
  Object.entries(attrs).every(([key, matcher]) => {
    const actual = row.attrs[key]
    if (actual === undefined) return false
    return matchesAttr(actual, matcher, row)
  })

const matchesAttr = <Row>(
  actual: string,
  matcher: TelemetryAttrMatcher<Row>,
  row: Row,
): boolean => {
  if (matcher instanceof RegExp) return matcher.test(actual)
  if (isStructuredAttrMatcher(matcher) === true) {
    switch (matcher._tag) {
      case 'Present':
        return true
      case 'Predicate':
        return matcher.predicate(actual, row)
      case 'Schema':
        return matcher.matches(actual)
    }
  }
  return actual === normalizeAttrPrimitive(matcher)
}

const contractAttrs = <A>(
  attributes: OtelMetricLabelsContract<A>,
  match: A,
): TelemetryAttrExpectations<MetricRow> =>
  Object.fromEntries(
    Object.entries(attributes.unsafeEncode(match)).map(([key, value]) => {
      if (Array.isArray(value) === true) {
        throw new TelemetryExpectError(
          `Cannot match array-valued OTEL metric label ${key} against otelite flat rows`,
        )
      }
      return [key, value]
    }),
  )

const isStructuredAttrMatcher = <Row>(
  matcher: TelemetryAttrMatcher<Row>,
): matcher is StructuredTelemetryAttrMatcher<Row> =>
  typeof matcher === 'object' &&
  matcher !== null &&
  !(matcher instanceof RegExp) &&
  '_tag' in matcher

const normalizeAttrPrimitive = (value: TelemetryAttrPrimitive): string => {
  if (value === null) return 'null'
  return String(value)
}

const describeMetricSelector = (selector: MetricSelector): string => {
  const parts = [
    selector.name === undefined ? undefined : `name=${selector.name}`,
    selector.service === undefined ? undefined : `service=${selector.service}`,
    selector.type === undefined ? undefined : `type=${selector.type}`,
    selector.unit === undefined ? undefined : `unit=${selector.unit}`,
    selector.value === undefined ? undefined : `value=${describeMetricValue(selector.value)}`,
    selector.attrs === undefined ? undefined : `attrs=${describeAttrs(selector.attrs)}`,
  ].filter((part) => part !== undefined)
  return parts.length === 0 ? '*' : parts.join(',')
}

const describeLogSelector = (selector: LogSelector): string => {
  const parts = [
    selector.service === undefined ? undefined : `service=${selector.service}`,
    selector.scope === undefined ? undefined : `scope=${selector.scope}`,
    selector.body === undefined ? undefined : `body=${String(selector.body)}`,
    selector.severityText === undefined ? undefined : `severity_text=${selector.severityText}`,
    selector.severityNumber === undefined
      ? undefined
      : `severity_number=${selector.severityNumber}`,
    selector.traceId === undefined ? undefined : `trace_id=${selector.traceId}`,
    selector.spanId === undefined ? undefined : `span_id=${selector.spanId}`,
    selector.attrs === undefined ? undefined : `attrs=${describeAttrs(selector.attrs)}`,
  ].filter((part) => part !== undefined)
  return parts.length === 0 ? '*' : parts.join(',')
}

const describeMetricValue = (matcher: MetricValueMatcher): string => {
  if (typeof matcher === 'number') return String(matcher)
  switch (matcher._tag) {
    case 'Present':
      return 'present'
    case 'Predicate':
      return matcher.description
  }
}

const describeAttrs = <Row>(attrs: TelemetryAttrExpectations<Row>): string =>
  Object.entries(attrs)
    .map(([key, matcher]) => `${key}:${describeMatcher(matcher)}`)
    .join(',')

const describeMatcher = <Row>(matcher: TelemetryAttrMatcher<Row>): string => {
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
