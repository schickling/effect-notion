/**
 * vitest ↔ otelite capture bridge.
 *
 * Wires an in-process {@link Otelite.capture} receiver to a vitest test's OTLP
 * trace exporter, so spans emitted IN-PROCESS through the normal OTEL layer
 * (`@effect/opentelemetry` `OtlpTracer`) land in a capture the test can then
 * assert over via the typed {@link CaptureHandle}.
 *
 * Lifecycle is PER-FILE by default (decision 0015): the receiver is acquired
 * once per test file (a shared scoped `Layer`, used with `@effect/vitest`'s
 * `it.layer`), and tests disambiguate by a unique `service.name` / span name per
 * test. Per-suite/global is infeasible across vitest's forked workers, so it is
 * not offered. Per-test is available by giving each `it.layer` its own
 * {@link makeOteliteCaptureLayer} instance.
 *
 * Silent-failure guard: the WHOLE point of the bridge is that a misrouted
 * exporter (the `/v1/traces` suffix bug — see `otlpTracesUrl`) must FAIL the
 * test rather than pass vacuously. A test asserts non-zero `counts.spans` /
 * a non-empty `inspect` result; if the exporter self-disabled, those are 0 and
 * the test fails loudly.
 *
 * @module
 */

import { Context, Effect, Layer } from 'effect'

import { makeOtelVitestLayer } from '../node-vitest/Vitest.ts'
import type { OteliteCliError, OteliteDecodeError, OteliteSpawnError } from './errors.ts'
import { Otelite } from './Otelite.ts'
import type { CaptureHandle, CaptureOptions } from './Otelite.ts'

/**
 * The live otelite {@link CaptureHandle} for the current test file, exposed to
 * the test body. A test does:
 *
 * ```ts
 * const cap = yield* OteliteCapture
 * // …emit spans in-process through the OTEL layer…
 * const spans = yield* cap.inspect({ signal: 'traces', name: mySpanName })
 * ```
 */
export class OteliteCapture extends Context.Service<OteliteCapture, CaptureHandle>()(
  '@overeng/utils-dev/otelite/OteliteCapture',
) {}

/** Options for {@link makeOteliteCaptureLayer}. */
export interface OteliteCaptureLayerOptions extends CaptureOptions {
  /**
   * Tracer export interval in milliseconds. Kept small so a test sees its span
   * after a single force-flush. @default 250
   */
  readonly exportInterval?: number
}

/**
 * A scoped `Layer` that boots ONE in-process {@link Otelite.capture} receiver,
 * exposes its {@link CaptureHandle} via {@link OteliteCapture}, AND provides the
 * OTLP trace exporter pointed at `${handle.endpoints.http}/v1/traces` (the
 * suffix the `OtlpTracer` needs verbatim — see `otlpTracesUrl`).
 *
 * Use it with `@effect/vitest`'s `it.layer(...)` so the receiver is acquired
 * ONCE per test file (per-file lifecycle) and shared across that file's tests.
 * The capture's scope is the layer's scope: the receiver stops, drains, and
 * resolves its summary when the shared layer scope closes (after the file).
 *
 * Resolving `OteliteCapture` yields the handle; spans emitted through the
 * provided tracer (any `Effect.withSpan` / `Layer.span` in the test) export to
 * the captured receiver.
 *
 * Requires `Otelite` + a `CommandExecutor`/`FileSystem` (e.g.
 * {@link NodeContext.layer}) in context, both of which it provides internally
 * via {@link Otelite.Default} so the returned layer is self-contained.
 */
export const makeOteliteCaptureLayer = (
  options: OteliteCaptureLayerOptions = {},
): Layer.Layer<OteliteCapture, OteliteSpawnError | OteliteCliError | OteliteDecodeError> => {
  const { exportInterval = 250, ...captureOptions } = options

  // Boot the receiver once; the scoped capture's lifetime is this layer's scope.
  // v4 `Layer.effect` scopes the build effect itself, so the capture finalizers
  // (stop receiver, drain, resolve summary) release with the layer scope.
  const handleLayer: Layer.Layer<
    OteliteCapture,
    OteliteSpawnError | OteliteCliError | OteliteDecodeError
  > = Layer.effect(
    OteliteCapture,
    Effect.gen(function* () {
      const otelite = yield* Otelite
      return yield* otelite.capture(captureOptions)
    }),
  ).pipe(Layer.provide(Otelite.layer))

  // Point the OTLP trace exporter at the captured receiver. Built from the
  // handle so the URL is the captured endpoint + the locked `/v1/traces` suffix.
  // Depends on `OteliteCapture`; `provideMerge(handleLayer)` below both
  // satisfies that dependency (booting the receiver ONCE — same layer reference,
  // so it is memoized within the build) and re-exports the tag to the test.
  const exporterLayer: Layer.Layer<never, never, OteliteCapture> = Layer.unwrap(
    OteliteCapture.pipe(
      Effect.map((handle) =>
        makeOtelVitestLayer({
          // `rootSpanName` here is the file-level span; per-test root spans come
          // from `withTestCtx`'s own `makeOtelVitestLayer` (or `Layer.span`).
          rootSpanName: 'otelite-capture-file',
          endpoint: handle.endpoints.http,
          serviceName: 'otelite-capture-bridge',
          exportInterval,
        }),
      ),
    ),
  )

  return exporterLayer.pipe(Layer.provideMerge(handleLayer))
}

/**
 * Force-flush the exporter's pending spans so a just-emitted span is durable in
 * the capture before {@link CaptureHandle.inspect}. Flushing is the EMITTER's
 * job — the receiver writes each export straight to its sink before acking, so
 * once the export POST returns the span is immediately inspectable.
 *
 * `OtlpTracer` has no public flush handle, so we yield long enough for the
 * batch interval to elapse + the POST to round-trip. Pair this with the small
 * `exportInterval` the bridge defaults to, and the handle's `inspect` bounded
 * short-poll retry, for a flake-free read.
 */
export const flushCaptureSpans = (
  options: { readonly exportInterval?: number } = {},
): Effect.Effect<void> =>
  // One export interval + a small margin for the POST + sink write.
  Effect.sleep(`${(options.exportInterval ?? 250) + 100} millis`)
