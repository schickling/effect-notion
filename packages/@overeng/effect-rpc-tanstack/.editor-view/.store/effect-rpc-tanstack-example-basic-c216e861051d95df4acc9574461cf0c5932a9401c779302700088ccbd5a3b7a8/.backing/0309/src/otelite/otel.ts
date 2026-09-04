import { Effect, Schema } from 'effect'

import type { Signal } from './Otelite.ts'

type OtelAttributeValue = string | number | boolean

type OtelAttributeMap = Readonly<Record<string, OtelAttributeValue>>

const OteliteLabelAttrs = Schema.Struct({
  label: Schema.NonEmptyString,
})

const OteliteExecAttrs = Schema.Struct({
  label: Schema.NonEmptyString,
  argv: Schema.Array(Schema.String),
})

const OteliteSignalAttrs = Schema.Struct({
  label: Schema.NonEmptyString,
  signal: Schema.Literals(['traces', 'metrics', 'logs']),
})

const encodeLabelAttrs = Schema.decodeSync(OteliteLabelAttrs)
const encodeExecAttrs = Schema.decodeSync(OteliteExecAttrs)
const encodeSignalAttrs = Schema.decodeSync(OteliteSignalAttrs)

const withSpan =
  ({
    name,
    attributes,
    root,
  }: {
    readonly name: string
    readonly attributes: OtelAttributeMap
    readonly root?: boolean
  }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(Effect.withSpan(name, { attributes, ...(root === undefined ? {} : { root }) }))

/** Wraps a child-process exec in an `otelite.exec` span; `span.label` is the binary, `otelite.argv` is the JSON-encoded argv. */
export const withOteliteExecSpan = (argv: ReadonlyArray<string>) =>
  withSpan({
    name: 'otelite.exec',
    attributes: (() => {
      const value = encodeExecAttrs({ label: argv[0] ?? 'exec', argv })
      return {
        'span.label': value.label,
        'otelite.argv': JSON.stringify(value.argv),
      }
    })(),
  })

/** Wraps an effect in a named span whose `span.label` defaults to the name minus its `otelite.` prefix. */
export const withOteliteLabelSpan = (name: string, label: string = name.replace('otelite.', '')) =>
  withSpan({
    name,
    attributes: (() => {
      const value = encodeLabelAttrs({ label })
      return { 'span.label': value.label }
    })(),
  })

/** Spans an `otelite inspect --summary` call; carries the signal both as `span.label` and a `signal` attribute. */
export const withOteliteInspectSummarySpan = (signal: Signal) =>
  withSpan({
    name: 'otelite.inspect.summary',
    attributes: (() => {
      const value = encodeSignalAttrs({ label: signal, signal })
      return { 'span.label': value.label, signal: value.signal }
    })(),
  })

/** Spans a row-level `otelite inspect` call (vs. the `--summary` variant); carries the signal as `span.label` and a `signal` attribute. */
export const withOteliteInspectSpan = (signal: Signal) =>
  withSpan({
    name: 'otelite.inspect',
    attributes: (() => {
      const value = encodeSignalAttrs({ label: signal, signal })
      return { 'span.label': value.label, signal: value.signal }
    })(),
  })

/** Like {@link withOteliteLabelSpan} but forces `root: true`, starting a fresh trace instead of joining the caller's. */
export const withOteliteRootSpan =
  ({ name, label }: { readonly name: string; readonly label: string }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      withSpan({
        name,
        root: true,
        attributes: (() => {
          const value = encodeLabelAttrs({ label })
          return { 'span.label': value.label }
        })(),
      }),
    )
