/**
 * Proves {@link makeOtelVitestLayer} flushes pending spans on scope close.
 *
 * The layer uses `Layer.suspend` (matching prod `otel.ts`). To make the
 * scope-close flush the ONLY way a span can reach the receiver, `exportInterval`
 * is set far longer than the test runs: the pre-close read sees zero spans (no
 * interval could have ticked), and they only appear AFTER the layer scope
 * closes. That `pre=0 / post>0` delta is the shutdown-flush guarantee — a fast
 * layer-scoped program never silently drops its last span batch.
 */

import { NodeServices } from '@effect/platform-node'
import { Effect, Exit, Layer, Scope } from 'effect'
import { describe, expect, it } from 'vitest'

import { Otelite } from '../otelite/mod.ts'
import { makeOtelVitestLayer } from './Vitest.ts'

const SERVICE = 'vitest-flush-cli'
const SPAN = 'vitest-flush-span'

// Far longer than the test runs, so nothing exports on an interval tick — only
// the scope-close shutdown flush can carry the span.
const EXPORT_INTERVAL = 60_000

const workload = Effect.annotateCurrentSpan('span.label', 'flush').pipe(Effect.withSpan(SPAN))

describe('makeOtelVitestLayer — flush on shutdown', () => {
  it('flushes pending spans when the layer scope closes', async () => {
    const program = Effect.gen(function* () {
      const otelite = yield* Otelite
      const cap = yield* otelite.capture({})

      const layer = makeOtelVitestLayer({
        rootSpanName: 'vitest-flush-file',
        endpoint: cap.endpoints.http,
        serviceName: SERVICE,
        exportInterval: EXPORT_INTERVAL,
      })

      // Build the exporter into a scope we control so we can read BEFORE closing.
      const layerScope = yield* Scope.make()
      const ctx = yield* Layer.buildWithScope(layer, layerScope)
      yield* workload.pipe(Effect.provide(ctx))

      // Pre-close: no interval could have ticked, so nothing flushed yet.
      const pre = yield* cap
        .inspect({ signal: 'traces', service: SERVICE, name: SPAN })
        .pipe(Effect.orElseSucceed(() => []))

      // Close the layer scope → the exporter's flush finalizer runs here.
      yield* Scope.close(layerScope, Exit.succeed(undefined))

      const post = yield* cap.inspect({ signal: 'traces', service: SERVICE, name: SPAN })

      return { pre: pre.length, post: post.length }
    }).pipe(Effect.scoped, Effect.provide(Layer.provideMerge(Otelite.layer, NodeServices.layer)))

    const { pre, post } = await Effect.runPromise(program)
    expect(pre).toBe(0)
    expect(post).toBeGreaterThan(0)
  }, 30_000)
})
