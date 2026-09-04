/**
 * Server-side utilities for Effect RPC with TanStack Start
 *
 * @since 0.1.0
 */

import type * as Context from 'effect/Context'
import * as Layer from 'effect/Layer'
import type { HttpMiddleware } from 'effect/unstable/http/HttpMiddleware'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import { type Rpc, type RpcGroup, RpcSerialization, RpcServer } from 'effect/unstable/rpc'

/** Web handler interface returned by makeHandler for use in TanStack Start API routes */
export type RpcWebHandler = {
  readonly handler: (
    request: Request,
    context?: Context.Context<never> | undefined,
  ) => Promise<Response>
  readonly dispose: () => Promise<void>
}

type HandlerLayer<TRpcs extends Rpc.Any, TError, TRuntime> = Layer.Layer<
  Rpc.ToHandler<TRpcs> | Rpc.Middleware<TRpcs> | Rpc.ServicesServer<TRpcs>,
  TError,
  TRuntime
>

type HandlerBaseOptions<TRpcs extends Rpc.Any, TError> = {
  readonly group: RpcGroup.RpcGroup<TRpcs>
  readonly handlerLayer: HandlerLayer<TRpcs, TError, never>
  /**
   * The HTTP route path the RPC protocol is registered on.
   * Defaults to '/api/rpc'.
   */
  readonly path?: `/${string}` | undefined
  readonly routerLayer?: Layer.Layer<HttpRouter.HttpRouter, never, never>
  readonly serializationLayer?: Layer.Layer<RpcSerialization.RpcSerialization, never, never>
  readonly disableTracing?: boolean | undefined
  readonly spanPrefix?: string | undefined
  readonly spanAttributes?: Record<string, unknown> | undefined
  readonly disableFatalDefects?: boolean | undefined
  readonly middleware?: HttpMiddleware
  readonly memoMap?: Layer.MemoMap
}

type HandlerOptions<TRpcs extends Rpc.Any, TError> = HandlerBaseOptions<TRpcs, TError>

type HandlerOptionsWithRuntime<TRpcs extends Rpc.Any, TRuntime, TError> = Omit<
  HandlerBaseOptions<TRpcs, TError>,
  'handlerLayer'
> & {
  readonly handlerLayer: HandlerLayer<TRpcs, TError, TRuntime>
  readonly runtimeLayer: Layer.Layer<TRuntime, never, never>
}

const buildHandlerLayer = <TRpcs extends Rpc.Any, TRuntime, TError>(
  options: HandlerOptions<TRpcs, TError> | HandlerOptionsWithRuntime<TRpcs, TRuntime, TError>,
): Layer.Layer<
  | Rpc.ToHandler<TRpcs>
  | Rpc.Middleware<TRpcs>
  | Rpc.ServicesServer<TRpcs>
  | RpcSerialization.RpcSerialization
  | HttpRouter.HttpRouter,
  TError,
  never
> => {
  const handlerLayer =
    'runtimeLayer' in options
      ? Layer.provide(options.handlerLayer, options.runtimeLayer)
      : options.handlerLayer

  const serializationLayer = options.serializationLayer ?? RpcSerialization.layerNdjson
  const routerLayer = options.routerLayer ?? HttpRouter.layer

  return Layer.mergeAll(handlerLayer, serializationLayer, routerLayer)
}

/**
 * Creates a web handler for TanStack Start API routes using Effect RPC's HTTP protocol.
 */
export const makeHandler: {
  <TRpcs extends Rpc.Any, TError>(options: HandlerOptions<TRpcs, TError>): RpcWebHandler
  <TRpcs extends Rpc.Any, TRuntime, TError>(
    options: HandlerOptionsWithRuntime<TRpcs, TRuntime, TError>,
  ): RpcWebHandler
} = <TRpcs extends Rpc.Any, TRuntime, TError>(
  options: HandlerOptions<TRpcs, TError> | HandlerOptionsWithRuntime<TRpcs, TRuntime, TError>,
): RpcWebHandler => {
  const handlerLayer = buildHandlerLayer(options)

  const appLayer: Layer.Layer<never, TError> = Layer.provide(
    RpcServer.layerHttp({
      group: options.group,
      path: options.path ?? '/api/rpc',
      protocol: 'http',
      ...(options.disableTracing === undefined ? {} : { disableTracing: options.disableTracing }),
      ...(options.spanPrefix === undefined ? {} : { spanPrefix: options.spanPrefix }),
      ...(options.spanAttributes === undefined ? {} : { spanAttributes: options.spanAttributes }),
      ...(options.disableFatalDefects === undefined
        ? {}
        : { disableFatalDefects: options.disableFatalDefects }),
    }),
    handlerLayer,
  )

  return HttpRouter.toWebHandler(appLayer, {
    ...(options.middleware === undefined ? {} : { middleware: options.middleware }),
    ...(options.memoMap === undefined ? {} : { memoMap: options.memoMap }),
  })
}

/**
 * Creates a handler with a provided runtime for dependency injection.
 */
export const makeHandlerWithRuntime: <TRpcs extends Rpc.Any, TRuntime, TError>(options: {
  readonly group: RpcGroup.RpcGroup<TRpcs>
  readonly handlerLayer: HandlerLayer<TRpcs, TError, TRuntime>
  readonly runtimeLayer: Layer.Layer<TRuntime, never, never>
  readonly path?: `/${string}` | undefined
  readonly routerLayer?: Layer.Layer<HttpRouter.HttpRouter, never, never>
  readonly serializationLayer?: Layer.Layer<RpcSerialization.RpcSerialization, never, never>
  readonly disableTracing?: boolean | undefined
  readonly spanPrefix?: string | undefined
  readonly spanAttributes?: Record<string, unknown> | undefined
  readonly disableFatalDefects?: boolean | undefined
  readonly middleware?: HttpMiddleware
  readonly memoMap?: Layer.MemoMap
}) => RpcWebHandler = (options) =>
  makeHandler({
    group: options.group,
    handlerLayer: options.handlerLayer,
    runtimeLayer: options.runtimeLayer,
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.routerLayer === undefined ? {} : { routerLayer: options.routerLayer }),
    ...(options.serializationLayer === undefined
      ? {}
      : { serializationLayer: options.serializationLayer }),
    ...(options.disableTracing === undefined ? {} : { disableTracing: options.disableTracing }),
    ...(options.spanPrefix === undefined ? {} : { spanPrefix: options.spanPrefix }),
    ...(options.spanAttributes === undefined ? {} : { spanAttributes: options.spanAttributes }),
    ...(options.disableFatalDefects === undefined
      ? {}
      : { disableFatalDefects: options.disableFatalDefects }),
    ...(options.middleware === undefined ? {} : { middleware: options.middleware }),
    ...(options.memoMap === undefined ? {} : { memoMap: options.memoMap }),
  })
