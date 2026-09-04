/**
 * Builds the full OTLP/HTTP traces URL from a base endpoint.
 *
 * `OtlpTracer.layer({ url })` POSTs to `url` verbatim. A bare base endpoint
 * must get the `/v1/traces` suffix here, or the exporter POSTs to the receiver
 * root, 404s, and self-disables silently.
 */
export const otlpTracesUrl = (baseEndpoint: string): string =>
  `${baseEndpoint.replace(/\/$/, '')}/v1/traces`
