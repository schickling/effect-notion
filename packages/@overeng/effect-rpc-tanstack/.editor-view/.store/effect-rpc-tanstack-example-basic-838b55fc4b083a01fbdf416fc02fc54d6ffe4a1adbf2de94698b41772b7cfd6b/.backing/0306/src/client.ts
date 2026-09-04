/**
 * Client-side utilities for Effect RPC with TanStack Start
 *
 * @since 0.1.0
 */

import { Data, Layer } from 'effect'
import * as Context from 'effect/Context'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import type * as HttpClient from 'effect/unstable/http/HttpClient'
import { type RpcMessage, RpcClient, RpcSerialization } from 'effect/unstable/rpc'

type SerializationService = Context.Service.Shape<typeof RpcSerialization.RpcSerialization>

type FetchLike = typeof globalThis.fetch

/** Configuration options for creating an RPC client layer */
export type ClientLayerOptions = {
  readonly url: string
  readonly transformClient?: <TError, TRuntime>(
    client: HttpClient.HttpClient.With<TError, TRuntime>,
  ) => HttpClient.HttpClient.With<TError, TRuntime>
  /**
   * Custom fetch implementation used when `httpClientLayer` is not provided.
   * Useful for SSR transports that need to route requests in-process.
   */
  readonly fetch?: FetchLike
  /**
   * Default fetch options used when `httpClientLayer` is not provided.
   */
  readonly requestInit?: globalThis.RequestInit
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient, never, never>
  readonly serializationLayer?: Layer.Layer<RpcSerialization.RpcSerialization, never, never>
}

/**
 * Adapts a web `Request -> Response` handler to a fetch-compatible function.
 */
export const fetchFromWebHandler = (
  handler: (request: Request) => Promise<Response>,
): FetchLike => {
  const fetch = (...args: [input: URL | RequestInfo, init?: RequestInit]): Promise<Response> => {
    const [input, init] = args
    return handler(
      input instanceof Request && init === undefined ? input : new Request(input, init),
    )
  }

  return fetch as FetchLike
}

/**
 * Typed error raised when an outgoing RPC request id violates the client id
 * policy (see `validateRequestId`).
 */
export class InvalidRequestIdError extends Data.TaggedError('InvalidRequestIdError')<{
  readonly id: unknown
}> {
  override get message(): string {
    return `Invalid RPC request id: ${String(this.id)}`
  }
}

/**
 * Client request-id policy. v3 required BigInt request ids; v4 accepts
 * string or numeric ids and echoes them back opaquely, so both shapes are
 * accepted for interop. Valid ids are non-empty strings and non-negative,
 * finite numbers or bigints; anything else raises `InvalidRequestIdError`
 * instead of reaching the wire.
 */
export const validateRequestId = (id: unknown): RpcMessage.RequestId => {
  if (
    (typeof id === 'string' && id.length > 0) ||
    (typeof id === 'number' && Number.isFinite(id) === true && id >= 0) ||
    (typeof id === 'bigint' && id >= 0)
  ) {
    return id as RpcMessage.RequestId
  }
  throw new InvalidRequestIdError({ id })
}

const isRequestEncoded = (
  message: unknown,
): message is { readonly _tag: 'Request'; readonly id: unknown } =>
  typeof message === 'object' && message !== null && '_tag' in message && message._tag === 'Request'

const withRequestIdPolicy = (serialization: SerializationService): SerializationService =>
  // `RpcSerialization.of` exists only in the rc.111 sources, not the compiled
  // package, so the wrapped plain object is asserted to the nominal Service
  // shape; its members are checked against the parameter above.
  ({
    contentType: serialization.contentType,
    includesFraming: serialization.includesFraming,
    makeUnsafe: () => {
      const parser = serialization.makeUnsafe()
      return {
        decode: parser.decode,
        encode: (message: unknown) => {
          if (isRequestEncoded(message) === true) {
            validateRequestId(message.id)
          }
          return parser.encode(message)
        },
      }
    },
  }) as unknown as SerializationService

const requestIdPolicyLayer = (
  base: Layer.Layer<RpcSerialization.RpcSerialization, never, never>,
): Layer.Layer<RpcSerialization.RpcSerialization, never, never> =>
  Layer.flatMap(base, (context) =>
    Layer.succeed(
      RpcSerialization.RpcSerialization,
      withRequestIdPolicy(Context.get(context, RpcSerialization.RpcSerialization)),
    ),
  )

/**
 * Creates an RpcClient.Protocol layer that uses the Effect HTTP RPC protocol.
 */
export const layerClient: (
  options: ClientLayerOptions,
) => Layer.Layer<RpcClient.Protocol, never, never> = (options) => {
  const serializationLayer = requestIdPolicyLayer(
    options.serializationLayer ?? RpcSerialization.layerNdjson,
  )
  const httpClientLayer =
    options.httpClientLayer ??
    FetchHttpClient.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          options.fetch !== undefined
            ? Layer.succeed(FetchHttpClient.Fetch, options.fetch)
            : Layer.empty,
          options.requestInit !== undefined
            ? Layer.succeed(FetchHttpClient.RequestInit, options.requestInit)
            : Layer.empty,
        ),
      ),
    )

  const protocolOptions = {
    url: options.url,
    ...(options.transformClient !== undefined ? { transformClient: options.transformClient } : {}),
  }

  return RpcClient.layerProtocolHttp(protocolOptions).pipe(
    Layer.provide(serializationLayer),
    Layer.provide(httpClientLayer),
  )
}
