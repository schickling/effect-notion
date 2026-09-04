/**
 * A hand-instrumented Effect emitter, run as the child under `otelite run` by
 * the end-to-end test. It reads the receiver endpoint otelite injects and POSTs
 * a single known OTLP/JSON trace over the Effect `HttpClient` — no OTel
 * SDK, no new deps. The POST blocks until the receiver acks (otelite writes to
 * the capture sink before responding), so the span is durable by the time this
 * child exits; the normal in-flight drain on child-exit suffices (no
 * `--drain-idle`).
 *
 * The trace uses the default OTel-SDK JSON dialect the receiver decodes:
 * 32-hex `traceId`, 16-hex `spanId`, integer `kind`, string int64 nanos.
 */
import { Effect } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http'

/** Distinctive span name so the test's assertion is unambiguous. */
export const SPAN_NAME = 'otelite-effect-e2e-span'
/** Distinctive `service.name` so the test's assertion is unambiguous. */
export const SERVICE_NAME = 'otelite-effect-e2e-svc'

/** One span in the OTel-SDK JSON dialect (the only encoding the receiver accepts). */
const tracePayload = JSON.stringify({
  resourceSpans: [
    {
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: SERVICE_NAME } }],
      },
      scopeSpans: [
        {
          scope: { name: 'otelite-effect-e2e' },
          spans: [
            {
              traceId: 'abcdef0123456789abcdef0123456789',
              spanId: '0123456789abcdef',
              name: SPAN_NAME,
              kind: 2,
              startTimeUnixNano: '1000000000',
              endTimeUnixNano: '1007000000',
              attributes: [{ key: 'e2e.marker', value: { stringValue: 'ok' } }],
            },
          ],
        },
      ],
    },
  ],
})

const program = Effect.gen(function* () {
  // otelite injects the standard base endpoint; `OTELITE_HTTP_ENDPOINT` is its
  // convenience alias. Either points at the HTTP receiver root.
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? process.env.OTELITE_HTTP_ENDPOINT
  if (base === undefined) {
    return yield* Effect.die('no otelite endpoint injected (OTEL_EXPORTER_OTLP_ENDPOINT)')
  }

  const client = yield* HttpClient.HttpClient
  const request = HttpClientRequest.post(`${base.replace(/\/$/, '')}/v1/traces`).pipe(
    HttpClientRequest.bodyText(tracePayload, 'application/json'),
  )
  // Awaiting the response guarantees the span is captured before we exit.
  yield* client.execute(request)
}).pipe(Effect.provide(FetchHttpClient.layer))

// Only POST when run as a script (`bun emitter.ts`); the test merely imports
// the shared `SPAN_NAME` / `SERVICE_NAME` constants from this module.
if (import.meta.main) {
  Effect.runPromise(program).then(
    () => process.exit(0),
    (cause) => {
      console.error(cause)
      process.exit(1)
    },
  )
}
