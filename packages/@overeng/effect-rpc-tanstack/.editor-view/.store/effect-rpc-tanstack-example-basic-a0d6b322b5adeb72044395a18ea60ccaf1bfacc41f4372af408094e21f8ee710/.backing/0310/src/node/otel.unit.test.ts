import { Effect, Option, Schema } from 'effect'
import { expect } from 'vitest'

import { ServiceIdentity } from '@overeng/otel-contract'
import { Vitest } from '@overeng/utils-dev/node-vitest'

import { makeOtelCliLayer, OtelConfig, parentSpanFromTraceparent } from './otel.ts'

const testIdentity = Schema.decodeSync(ServiceIdentity)({
  name: 'test-cli',
  namespace: 'overeng',
  version: '0.0.0',
})

Vitest.describe('otel-cli', () => {
  Vitest.describe('parentSpanFromTraceparent', () => {
    Vitest.it.effect(
      'returns undefined when TRACEPARENT is not set',
      Effect.fnUntraced(function* () {
        delete process.env.TRACEPARENT

        const result = yield* parentSpanFromTraceparent
        expect(result).toBeUndefined()
      }),
    )

    Vitest.it.effect(
      'returns undefined for invalid TRACEPARENT format (too few parts)',
      Effect.fnUntraced(function* () {
        process.env.TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331'

        const result = yield* parentSpanFromTraceparent
        expect(result).toBeUndefined()
      }),
    )

    Vitest.it.effect(
      'returns undefined for invalid TRACEPARENT format (too many parts)',
      Effect.fnUntraced(function* () {
        process.env.TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01-extra'

        const result = yield* parentSpanFromTraceparent
        expect(result).toBeUndefined()
      }),
    )

    Vitest.it.effect(
      'returns undefined for invalid version (not 00)',
      Effect.fnUntraced(function* () {
        process.env.TRACEPARENT = '01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

        const result = yield* parentSpanFromTraceparent
        expect(result).toBeUndefined()
      }),
    )

    Vitest.it.effect(
      'returns undefined for invalid traceId length (too short)',
      Effect.fnUntraced(function* () {
        process.env.TRACEPARENT = '00-0af7651916cd43dd8448eb211c8031-b7ad6b7169203331-01'

        const result = yield* parentSpanFromTraceparent
        expect(result).toBeUndefined()
      }),
    )

    Vitest.it.effect(
      'returns undefined for invalid traceId length (too long)',
      Effect.fnUntraced(function* () {
        process.env.TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c9c-b7ad6b7169203331-01'

        const result = yield* parentSpanFromTraceparent
        expect(result).toBeUndefined()
      }),
    )

    Vitest.it.effect(
      'returns undefined for invalid spanId length (too short)',
      Effect.fnUntraced(function* () {
        process.env.TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b716920331-01'

        const result = yield* parentSpanFromTraceparent
        expect(result).toBeUndefined()
      }),
    )

    Vitest.it.effect(
      'returns undefined for invalid spanId length (too long)',
      Effect.fnUntraced(function* () {
        process.env.TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b71692033311-01'

        const result = yield* parentSpanFromTraceparent
        expect(result).toBeUndefined()
      }),
    )

    Vitest.it.effect(
      'returns ExternalSpan for valid TRACEPARENT',
      Effect.fnUntraced(function* () {
        process.env.TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

        const result = yield* parentSpanFromTraceparent
        expect(result).toBeDefined()
        expect(result?._tag).toBe('ExternalSpan')
        expect(result?.traceId).toBe('0af7651916cd43dd8448eb211c80319c')
        expect(result?.spanId).toBe('b7ad6b7169203331')
      }),
    )

    Vitest.it.effect(
      'returns ExternalSpan with different trace flags',
      Effect.fnUntraced(function* () {
        // Test with trace flags = 00 (not sampled)
        process.env.TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00'

        const result = yield* parentSpanFromTraceparent
        expect(result).toBeDefined()
        expect(result?._tag).toBe('ExternalSpan')
      }),
    )
  })

  Vitest.describe('makeOtelCliLayer', () => {
    Vitest.it.effect(
      'provides OtelConfig with endpoint None when env var is not set',
      Effect.fnUntraced(function* () {
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        delete process.env.TRACEPARENT

        const layer = makeOtelCliLayer({ identity: testIdentity })

        const cfg = yield* OtelConfig.pipe(Effect.provide(layer))
        expect(Option.isNone(cfg.endpoint)).toBe(true)
      }),
    )

    Vitest.it.effect(
      'provides OtelConfig with endpoint None when custom endpoint env var is not set',
      Effect.fnUntraced(function* () {
        delete process.env.CUSTOM_OTEL_ENDPOINT
        delete process.env.TRACEPARENT

        const layer = makeOtelCliLayer({
          identity: testIdentity,
          endpointEnvVar: 'CUSTOM_OTEL_ENDPOINT',
        })

        const cfg = yield* OtelConfig.pipe(Effect.provide(layer))
        expect(Option.isNone(cfg.endpoint)).toBe(true)
      }),
    )

    Vitest.it.effect(
      'explicit endpoint None disables export without reading process.env',
      Effect.fnUntraced(function* () {
        // Env IS set, but the explicit None must win (pure: no env read).
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:1/should-be-ignored'
        delete process.env.TRACEPARENT

        const layer = makeOtelCliLayer({
          identity: testIdentity,
          endpoint: Option.none(),
        })

        const cfg = yield* OtelConfig.pipe(Effect.provide(layer))
        expect(Option.isNone(cfg.endpoint)).toBe(true)

        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      }),
    )

    // The explicit-`Some` path (which stands up the REAL OTLP exporter) is proven
    // end-to-end against a live otelite receiver in
    // `megarepo/src/cli/store-gc-otel.integration.test.ts`; building the exporter
    // here (no receiver, no scoped teardown of its periodic reader fibers) would
    // hang. The unit test stays on the pure, exporter-free branches above.
  })
})
