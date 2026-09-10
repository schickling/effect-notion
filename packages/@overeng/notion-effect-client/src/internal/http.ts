import { Cause, Context, Duration, Effect, Layer, Option, Redacted, Schedule, Schema } from 'effect'
import { HttpClient, TracerHeaderFilter } from 'effect/unstable/http/HttpClient'
import type { HttpClientError } from 'effect/unstable/http/HttpClientError'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import type { HttpClientResponse } from 'effect/unstable/http/HttpClientResponse'

import { NOTION_API_BASE_URL, NOTION_API_VERSION, NotionConfig } from '../config.ts'
import { NotionApiError, NotionErrorResponse } from '../error.ts'
import { NotionRateLimitMetricBridges } from './metrics.ts'
import { annotateNotionHttpRateLimitSpan, withNotionHttpSpan } from './otel.ts'
import { NotionThrottle } from './throttle.ts'

/** Rate limit info extracted from response headers */
export interface RateLimitInfo {
  /** Requests remaining in current window */
  readonly remaining: number
  /** Seconds until rate limit resets */
  readonly resetAfterSeconds: number
}

/** Sanitized route metadata used for request tracing, progress, and quota accounting. */
export interface NotionHttpRouteInfo {
  readonly route: string
  readonly operation: string
  readonly spanLabel: string
}

/** Structured HTTP event emitted after every Notion API response and retry decision. */
export type NotionHttpTelemetryEvent =
  | {
      readonly _tag: 'response'
      readonly method: BuildRequestOptions['method']
      readonly route: string
      readonly operation: string
      readonly status: number
      readonly attempt: number
      readonly quotaCost: number
      readonly rateLimit: Option.Option<RateLimitInfo>
    }
  | {
      readonly _tag: 'retry'
      readonly method: BuildRequestOptions['method']
      readonly route: string
      readonly operation: string
      readonly status: number
      readonly attempt: number
      readonly nextAttempt: number
      readonly delayMs: number
      readonly rateLimit: Option.Option<RateLimitInfo>
    }

/** Optional reporter for live Notion HTTP quota/progress consumers such as CLIs. */
export type NotionHttpTelemetryReporter = {
  readonly report: (event: NotionHttpTelemetryEvent) => Effect.Effect<void>
}

/** Optional Effect service used by callers that want realtime HTTP/rate-limit visibility.
 * Defaults lazily to a no-op reporter when not explicitly provided; an explicit
 * `Effect.provideService` always wins. */
export const NotionHttpTelemetry: Context.Reference<NotionHttpTelemetryReporter> =
  Context.Reference<NotionHttpTelemetryReporter>(
    '@overeng/notion-effect-client/NotionHttpTelemetry',
    { defaultValue: () => ({ report: () => Effect.void }) },
  )

/**
 * Case-insensitive span-header allowlist for Notion client spans, expressed
 * as the upstream-native `HttpClient.TracerHeaderFilter` (replaces a retired
 * v3-era platform patch). Only these header names
 * become `http.{request,response}.header.*` attributes on Notion client
 * spans; transmission headers are untouched — this filters telemetry only.
 */
const tracerHeaderAllowlist: Record<string, true> = {
  'content-type': true,
  'content-length': true,
  date: true,
  'x-request-id': true,
  'x-notion-request-id': true,
  'retry-after': true,
  'x-ratelimit-remaining': true,
}

/**
 * `HttpClient.TracerHeaderFilter` predicate admitting exactly the allowlisted
 * Notion span headers (one set for both request and response phases, matching
 * the v3 patch).
 */
// oxlint-disable-next-line overeng/named-args -- matches the upstream HttpClient.TracerHeaderFilter positional signature
export const notionTracerHeaderFilter = (
  headerName: string,
  _phase: 'request' | 'response',
): boolean => tracerHeaderAllowlist[headerName.toLowerCase()] === true

/**
 * Opt-in layer binding `HttpClient.TracerHeaderFilter` to
 * {@link notionTracerHeaderFilter}, keeping verbose Notion traffic spans
 * (header attributes) controllable without core patches. Default behavior —
 * every header name emitted as a span attribute, with value redaction intact —
 * is unchanged unless this layer (or an explicit
 * `Effect.provideService(HttpClient.TracerHeaderFilter, ...)`) is provided.
 */
export const NotionTracerHeaderFilterLive: Layer.Layer<never> = Layer.succeed(
  TracerHeaderFilter,
  notionTracerHeaderFilter,
)

/** Options for building a Notion API request */
export interface BuildRequestOptions {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  readonly path: string
  readonly body?: unknown
}

/** Options for executing a Notion API request */
export interface ExecuteRequestOptions<A, I, R> {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  readonly path: string
  readonly responseSchema: Schema.Codec<A, I, R>
  readonly body?: unknown
}

const parseNonNegativeInt = (input: string | undefined): number => {
  if (input === undefined) {
    return 0
  }
  const value = Number.parseInt(input, 10)
  return Number.isNaN(value) === true ? 0 : Math.max(0, value)
}

const parseRetryAfterSeconds = (input: string | undefined): number => {
  if (input === undefined) {
    return 0
  }
  const seconds = Number.parseInt(input, 10)
  if (Number.isNaN(seconds) === false) {
    return Math.max(0, seconds)
  }

  const resetAt = Date.parse(input)
  if (Number.isNaN(resetAt) === true) {
    return 0
  }

  return Math.max(0, Math.ceil((resetAt - Date.now()) / 1000))
}

const routeTokenForPreviousSegment = (previous: string | undefined): string => {
  switch (previous) {
    case 'blocks':
      return '{block_id}'
    case 'data_sources':
      return '{data_source_id}'
    case 'databases':
      return '{database_id}'
    case 'pages':
      return '{page_id}'
    case 'properties':
      return '{property_id}'
    case 'users':
      return '{user_id}'
    case 'views':
      return '{view_id}'
    default:
      return '{id}'
  }
}

const isLikelyIdentifierSegment = (segment: string): boolean =>
  /^[0-9a-f]{32}$/i.test(segment) ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ||
  (segment.length >= 16 && /^[A-Za-z0-9_-]+$/.test(segment))

const operationForRoute = (route: string): string => {
  switch (route) {
    case '/blocks/{block_id}':
      return 'blocks.retrieve'
    case '/blocks/{block_id}/children':
      return 'blocks.children'
    case '/comments':
      return 'comments.create'
    case '/custom_emojis':
      return 'custom_emojis.list'
    case '/data_sources':
      return 'data_sources.create'
    case '/data_sources/{data_source_id}':
      return 'data_sources.object'
    case '/data_sources/{data_source_id}/query':
      return 'data_sources.query'
    case '/databases':
      return 'databases.create'
    case '/databases/{database_id}':
      return 'databases.object'
    case '/pages':
      return 'pages.create'
    case '/pages/{page_id}':
      return 'pages.object'
    case '/pages/{page_id}/markdown':
      return 'pages.markdown'
    case '/pages/{page_id}/move':
      return 'pages.move'
    case '/pages/{page_id}/properties/{property_id}':
      return 'pages.property'
    case '/search':
      return 'search'
    case '/users/me':
      return 'users.me'
    case '/users/{user_id}':
      return 'users.retrieve'
    case '/views':
      return 'views.collection'
    case '/views/{view_id}':
      return 'views.object'
    default:
      return route.replace(/^\//, '').replaceAll('/', '.')
  }
}

const shouldTemplateSegment = ({
  segment,
  previous,
}: {
  readonly segment: string
  readonly previous: string | undefined
}): boolean =>
  previous !== undefined &&
  (previous !== 'users' || segment !== 'me') &&
  (routeTokenForPreviousSegment(previous) !== '{id}' || isLikelyIdentifierSegment(segment))

/** Converts a concrete Notion API path into a stable, non-sensitive route key. */
export const notionHttpRouteInfo = ({
  method,
  path,
}: {
  readonly method: BuildRequestOptions['method']
  readonly path: string
}): NotionHttpRouteInfo => {
  const pathname = path.split('?')[0] ?? '/'
  const segments = pathname
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment, index, all) => {
      const previous = all[index - 1]
      return shouldTemplateSegment({ segment, previous }) === true
        ? routeTokenForPreviousSegment(previous)
        : segment
    })
  const route = `/${segments.join('/')}`
  const operation = operationForRoute(route)
  return {
    route,
    operation,
    spanLabel: `${method} ${operation}`.slice(0, 39),
  }
}

/** Options for POST request */
export interface PostRequestOptions<A, I, R> {
  readonly path: string
  readonly body: unknown
  readonly responseSchema: Schema.Codec<A, I, R>
}

/** Options for PATCH request */
export interface PatchRequestOptions<A, I, R> {
  readonly path: string
  readonly body: unknown
  readonly responseSchema: Schema.Codec<A, I, R>
}

/**
 * Parse rate limit headers from Notion API response.
 */
export const parseRateLimitHeaders = (
  headers: Headers | Record<string, string | undefined>,
): Option.Option<RateLimitInfo> => {
  const getHeader = (name: string): string | undefined => {
    if (headers instanceof Headers === true) {
      return headers.get(name) ?? undefined
    }

    return headers[name.toLowerCase()] ?? headers[name]
  }

  const remainingRaw = getHeader('x-ratelimit-remaining')
  const retryAfterRaw = getHeader('retry-after')
  if (remainingRaw === undefined && retryAfterRaw === undefined) {
    return Option.none()
  }

  const remaining = parseNonNegativeInt(remainingRaw)
  const resetAfterSeconds = parseRetryAfterSeconds(retryAfterRaw)

  return Option.some({
    remaining,
    resetAfterSeconds,
  })
}

const annotateRateLimitSpan = (input: {
  readonly method: BuildRequestOptions['method']
  readonly route: NotionHttpRouteInfo
  readonly status?: number
  readonly attempt: number
  readonly attempts: number
  readonly retryDelayMs?: number
  readonly rateLimit: Option.Option<RateLimitInfo>
}): Effect.Effect<void> => annotateNotionHttpRateLimitSpan(input)

const reportHttpTelemetry = (event: NotionHttpTelemetryEvent): Effect.Effect<void> =>
  Effect.flatMap(NotionHttpTelemetry, (telemetry) => telemetry.report(event))

/**
 * Build a Notion API request with proper headers.
 */
export const buildRequest = ({
  method,
  path,
  body,
}: BuildRequestOptions): Effect.Effect<
  HttpClientRequest.HttpClientRequest,
  NotionApiError,
  NotionConfig
> =>
  Effect.gen(function* () {
    const config = yield* NotionConfig
    const requestUrl = `${NOTION_API_BASE_URL}${path}`

    const baseRequest = HttpClientRequest.make(method)(requestUrl).pipe(
      HttpClientRequest.setHeader('Authorization', `Bearer ${Redacted.value(config.authToken)}`),
      HttpClientRequest.setHeader('Notion-Version', NOTION_API_VERSION),
      HttpClientRequest.setHeader('Content-Type', 'application/json'),
    )

    if (body !== undefined) {
      return yield* HttpClientRequest.bodyJson(body)(baseRequest).pipe(
        Effect.mapError(
          (cause) =>
            new NotionApiError({
              status: 0,
              code: 'invalid_request',
              message: `Failed to encode request body: ${String(cause)}`,
              retryAfterSeconds: Option.none(),
              requestId: Option.none(),
              url: Option.some(requestUrl),
              method: Option.some(method),
            }),
        ),
      )
    }

    return baseRequest
  })
/* No operation span here: request construction is a trivial synchronous
     shape (header mapping + body encoding) and the generated span was noise
     — 85 zero-signal spans per `pixeltrail sync` run. Method/path are
     already carried on the surrounding `NotionHttp.<METHOD>` span. */

/** Parse error response from Notion API. */
const parseErrorResponse = (opts: {
  response: HttpClientResponse
  requestUrl: string
  requestMethod: string
}): Effect.Effect<NotionApiError> => {
  const { response, requestUrl, requestMethod } = opts
  return Effect.gen(function* () {
    const requestId = Option.fromUndefinedOr(response.headers['x-request-id'])
    const retryAfterSeconds =
      response.status === 429
        ? parseRateLimitHeaders(response.headers).pipe(
            Option.map((r) => r.resetAfterSeconds),
            Option.filter((s) => s > 0),
          )
        : Option.none<number>()

    const json = yield* response.json.pipe(
      Effect.orElseSucceed(() => ({
        object: 'error' as const,
        status: response.status,
        code: 'internal_server_error' as const,
        message: `HTTP ${response.status} error`,
      })),
    )

    const parsed = yield* Schema.decodeUnknownEffect(NotionErrorResponse)(json).pipe(
      Effect.orElseSucceed(() => ({
        object: 'error' as const,
        status: response.status,
        code: 'internal_server_error' as const,
        message:
          typeof json === 'object' && json !== null && 'message' in json
            ? String(json.message)
            : `HTTP ${response.status} error`,
      })),
    )

    return new NotionApiError({
      status: parsed.status,
      code: parsed.code,
      message: parsed.message,
      retryAfterSeconds,
      requestId,
      url: Option.some(requestUrl),
      method: Option.some(requestMethod),
    })
  })
}

/**
 * Map HttpClientError to NotionApiError.
 *
 * The persisted envelope stays byte-identical to the legacy mapping (status 0,
 * verbatim reason message): `NotionErrorCode` has no transport/timeout codes,
 * so the reason tag itself remains visible only through the verbatim `message`
 * ("Transport error (...)", "Encode error (...)", ...). The `code` carries the
 * retryability discrimination instead: deterministic request-construction
 * failures (encode/URL) map to non-retryable `invalid_request`, while
 * transport, decode, and status failures stay retryable `service_unavailable`
 * (connection drops and truncated bodies are transient).
 */
const mapHttpClientError = (opts: {
  error: HttpClientError
  path: string
  method: string
}): NotionApiError => {
  const deterministicRequestFailure =
    opts.error.reason._tag === 'EncodeError' || opts.error.reason._tag === 'InvalidUrlError'
  return new NotionApiError({
    status: 0,
    code: deterministicRequestFailure === true ? 'invalid_request' : 'service_unavailable',
    message: opts.error.message,
    retryAfterSeconds: Option.none(),
    requestId: Option.none(),
    url: Option.some(`${NOTION_API_BASE_URL}${opts.path}`),
    method: Option.some(opts.method),
  })
}

/* The rate-limit snapshot a retried 429 carries: only a server-advised
 * `Retry-After` gives a trustworthy reset window. */
const retryRateLimit = (error: NotionApiError): Option.Option<RateLimitInfo> =>
  error.status === 429 && Option.isSome(error.retryAfterSeconds) === true
    ? Option.some({ remaining: 0, resetAfterSeconds: error.retryAfterSeconds.value })
    : Option.none()

/**
 * Execute a Notion API request with error handling and automatic retry.
 *
 * Retry behavior:
 * - Retryable: rate_limited, internal_server_error, service_unavailable, gateway_timeout
 * - Non-retryable: invalid_request, unauthorized, object_not_found, etc.
 * - Uses exponential backoff, respecting retry-after header for rate limits
 */
export const executeRequest = <A, I, R>({
  method,
  path,
  responseSchema,
  body,
}: ExecuteRequestOptions<A, I, R>): Effect.Effect<
  A,
  NotionApiError,
  NotionConfig | HttpClient | R
> =>
  Effect.gen(function* () {
    const config = yield* NotionConfig
    const client = yield* HttpClient

    const retryEnabled = config.retryEnabled ?? true
    const maxRetries = config.maxRetries ?? 3
    const retryBaseDelay = config.retryBaseDelay ?? 1000
    const route = notionHttpRouteInfo({ method, path })

    /**
     * Single attempt. The zero-based attempt index is read from the retry
     * schedule's iteration metadata (`recurrence`), which the retry driver
     * increments after each retry decision. On the first run (and when retries
     * are disabled) the default metadata yields `recurrence === 0`, matching
     * the legacy loop's initial `attempt`.
     */
    const makeRequest = () =>
      Effect.gen(function* () {
        const attempt = (yield* Schedule.CurrentMetadata).attempt
        const request = yield* buildRequest({ method, path, body })
        /* HTTP-attempt PRESSURE counter (decision 0017 Half 2): incremented once
         * per INITIATED HTTP attempt — after the request is built, BEFORE the
         * call — so every wire attempt counts, including the initial try, each
         * retry, AND transport-level failures (which map to a retryable
         * status:0 / service_unavailable and would be invisible if counted only
         * on a received response). Body-encoding failures never reach here, so
         * they are correctly excluded. This diverges from the logical-request
         * budget ceiling exactly under retry/connection-drop pressure. */
        yield* NotionRateLimitMetricBridges.httpAttemptsTotal.trustedIncrement({
          method,
          operation: route.operation,
        })
        const response = yield* client
          .execute(request)
          .pipe(Effect.mapError((error) => mapHttpClientError({ error, path, method })))
        const rateLimit = parseRateLimitHeaders(response.headers)
        yield* annotateRateLimitSpan({
          method,
          route,
          status: response.status,
          attempt,
          attempts: attempt + 1,
          rateLimit,
        })
        yield* reportHttpTelemetry({
          _tag: 'response',
          method,
          route: route.route,
          operation: route.operation,
          status: response.status,
          attempt,
          quotaCost: 1,
          rateLimit,
        })

        if (response.status >= 400) {
          const error = yield* parseErrorResponse({
            response,
            requestUrl: `${NOTION_API_BASE_URL}${path}`,
            requestMethod: method,
          })
          return yield* error
        }

        const json = yield* response.json.pipe(
          Effect.mapError((error) => mapHttpClientError({ error, path, method })),
        )

        return yield* Schema.decodeUnknownEffect(responseSchema)(json).pipe(
          Effect.mapError(
            (parseError) =>
              new NotionApiError({
                status: response.status,
                code: 'invalid_request',
                message: `Failed to parse response: ${parseError.message}`,
                retryAfterSeconds: Option.none(),
                requestId: Option.fromUndefinedOr(response.headers['x-request-id']),
                url: Option.some(`${NOTION_API_BASE_URL}${path}`),
                method: Option.some(method),
              }),
          ),
        )
      })

    /**
     * Per-attempt delay matching the legacy loop: the exponential backoff for
     * this attempt index, floored by any server-advised `Retry-After`. The
     * `attempt` here is the zero-based index of the attempt that just failed
     * (equivalently, the number of retries already performed).
     */
    const retryDelayMs = (opts: { error: NotionApiError; attempt: number }): number => {
      const backoffMs = retryBaseDelay * 2 ** opts.attempt
      const retryAfterMs = Option.getOrElse(opts.error.retryAfterMillis, () => 0)
      return Math.max(backoffMs, retryAfterMs)
    }

    /**
     * Retry schedule whose input is the failing `NotionApiError`. Stock
     * combinators cannot express `max(backoff, Retry-After)` because the delay
     * depends on the error, so we build the schedule explicitly: each step
     * receives the attempt metadata (`attempt` is one-based; the zero-based
     * index of the failed attempt is `attempt - 1`), decides whether to
     * continue for retryable errors under the `maxRetries` bound, and produces
     * the floored backoff as both schedule output and step delay. Telemetry and
     * span annotation are emitted here — exactly once per retry decision with
     * the exact delay — preserving the legacy loop's observable behavior.
     */
    const retrySchedule = Schedule.fromStepWithMetadata<
      NotionApiError,
      number,
      never,
      never,
      never,
      never
    >(
      Effect.succeed((metadata) => {
        const attempt = metadata.attempt - 1
        const error = metadata.input
        if (error.isRetryable === false || attempt >= maxRetries) {
          return Cause.done(0)
        }

        const delayMs0 = retryDelayMs({ error, attempt })
        const rateLimit = retryRateLimit(error)

        /* Retry-After PRESSURE counters (decision 0017 Half 2): count + sum the
         * server-advised backpressure when this retry honors a `Retry-After`
         * header. `retryAfterMillis` is Some only when the server sent one. */
        const retryAfterMs = Option.getOrUndefined(error.retryAfterMillis)
        const emitRetryAfter =
          retryAfterMs === undefined
            ? Effect.void
            : Effect.andThen(
                NotionRateLimitMetricBridges.retryAfterTotal.trustedIncrement({
                  method,
                  operation: route.operation,
                }),
                NotionRateLimitMetricBridges.retryAfterMsTotal.trustedIncrementBy({
                  labels: { method, operation: route.operation },
                  amount: retryAfterMs,
                }),
              )

        return Effect.as(
          Effect.all(
            [
              emitRetryAfter,
              annotateRateLimitSpan({
                method,
                route,
                status: error.status,
                attempt,
                attempts: attempt + 1,
                retryDelayMs: delayMs0,
                rateLimit,
              }),
              reportHttpTelemetry({
                _tag: 'retry',
                method,
                route: route.route,
                operation: route.operation,
                status: error.status,
                attempt,
                nextAttempt: attempt + 1,
                delayMs: delayMs0,
                rateLimit,
              }),
            ],
            { discard: true },
          ),
          [delayMs0, Duration.millis(delayMs0)] as const,
        )
      }),
    )

    /**
     * One logical request: the retry-wrapped single attempt. Wrapped (when a
     * throttle is bound) so a single throttle token is consumed per logical
     * request rather than per retry attempt.
     */
    const runOnce =
      retryEnabled === false ? makeRequest() : Effect.retry(makeRequest(), retrySchedule)

    const throttle = yield* NotionThrottle
    return yield* throttle.apply(runOnce)
  }).pipe(withNotionHttpSpan({ method, route: notionHttpRouteInfo({ method, path }) }))

/** Options for GET request */
export interface GetRequestOptions<A, I, R> {
  readonly path: string
  readonly responseSchema: Schema.Codec<A, I, R>
}

/** GET request helper. */
export const get = <A, I, R>({
  path,
  responseSchema,
}: GetRequestOptions<A, I, R>): Effect.Effect<A, NotionApiError, NotionConfig | HttpClient | R> =>
  executeRequest({ method: 'GET', path, responseSchema })

/**
 * POST request helper.
 */
export const post = <A, I, R>({
  path,
  body,
  responseSchema,
}: PostRequestOptions<A, I, R>): Effect.Effect<A, NotionApiError, NotionConfig | HttpClient | R> =>
  executeRequest({ method: 'POST', path, responseSchema, body })

/**
 * PATCH request helper.
 */
export const patch = <A, I, R>({
  path,
  body,
  responseSchema,
}: PatchRequestOptions<A, I, R>): Effect.Effect<A, NotionApiError, NotionConfig | HttpClient | R> =>
  executeRequest({ method: 'PATCH', path, responseSchema, body })

/** Options for DELETE request */
export interface DeleteRequestOptions<A, I, R> {
  readonly path: string
  readonly responseSchema: Schema.Codec<A, I, R>
}

/** DELETE request helper. */
export const del = <A, I, R>({
  path,
  responseSchema,
}: DeleteRequestOptions<A, I, R>): Effect.Effect<
  A,
  NotionApiError,
  NotionConfig | HttpClient | R
> => executeRequest({ method: 'DELETE', path, responseSchema })
