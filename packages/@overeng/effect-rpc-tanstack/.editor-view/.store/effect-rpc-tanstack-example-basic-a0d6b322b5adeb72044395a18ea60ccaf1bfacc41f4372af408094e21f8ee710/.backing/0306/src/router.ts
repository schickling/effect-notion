/**
 * Effect-native TanStack Router integration
 *
 * @since 0.1.0
 */

import {
  createFileRoute,
  type ErrorRouteComponent,
  type FileRoutesByPath,
  type RouteComponent,
} from '@tanstack/react-router'
import { Cause, Effect, Exit, type Layer, Option, Result, Schema } from 'effect'

/**
 * Schema for encoding Exit values for SSR serialization.
 * Uses Effect's built-in Exit schema with Unknown types for flexibility.
 */
const ExitSchema = Schema.Exit(Schema.Unknown, Schema.Unknown, Schema.Defect())

/**
 * Encoded Exit type for SSR serialization.
 * This is the JSON-safe representation that can be serialized by seroval.
 */
export type ExitEncoded = typeof ExitSchema.Encoded

/**
 * Encode an Exit for SSR serialization using Effect Schema.
 */
export const encodeExit = <A, E>(exit: Exit.Exit<A, E>): ExitEncoded =>
  Schema.encodeSync(ExitSchema)(exit as Exit.Exit<unknown, unknown>)

/**
 * Decode an ExitEncoded back to Exit using Effect Schema.
 */
export const decodeExit = <A, E>(encoded: ExitEncoded): Exit.Exit<A, E> =>
  Schema.decodeSync(ExitSchema)(encoded) as Exit.Exit<A, E>

/**
 * Effect-native loader context
 */
export interface EffectLoaderContext<TParams = unknown> {
  params: TParams
  abortController: AbortController
}

/**
 * Options for createEffectRoute
 */
export interface EffectRouteOptions<TParams, TLoaderData, TLoaderError, TLoaderContext> {
  /**
   * Effect-native loader function.
   * Returns an Effect that produces the loader data.
   */
  loader?: (
    ctx: EffectLoaderContext<TParams>,
  ) => Effect.Effect<TLoaderData, TLoaderError, TLoaderContext>

  /**
   * Layer to provide dependencies to the loader Effect.
   */
  loaderLayer?: Layer.Layer<TLoaderContext, never, never>

  /**
   * React component to render for this route.
   */
  component?: RouteComponent

  /**
   * Component to render on error.
   */
  errorComponent?: false | null | undefined | ErrorRouteComponent

  /**
   * Component to render while loading.
   */
  pendingComponent?: RouteComponent
}

/**
 * Result type for useLoaderData when using createEffectRoute.
 * Provides the Exit and helper methods for pattern matching.
 */
export interface EffectLoaderResult<A, E> {
  /**
   * The raw Exit value from the loader
   */
  readonly exit: Exit.Exit<A, E>

  /**
   * Get the success value or throw if failed
   */
  readonly getOrThrow: () => A

  /**
   * Check if the loader succeeded
   */
  readonly isSuccess: boolean

  /**
   * Check if the loader failed
   */
  readonly isFailure: boolean

  /**
   * Get the success value if present
   */
  readonly value: Option.Option<A>

  /**
   * Get the error if present
   */
  readonly error: Option.Option<E>

  /**
   * Pattern match on the Exit
   */
  readonly match: <R>(handlers: {
    readonly onSuccess: (value: A) => R
    readonly onFailure: (error: E) => R
    readonly onDefect?: (defect: unknown) => R
  }) => R
}

/**
 * Create an EffectLoaderResult from an ExitEncoded
 */
export const makeEffectLoaderResult = <A, E>(encoded: ExitEncoded): EffectLoaderResult<A, E> => {
  const exit = decodeExit<A, E>(encoded)

  return {
    exit,
    isSuccess: Exit.isSuccess(exit),
    isFailure: Exit.isFailure(exit),
    value: Exit.isSuccess(exit) === true ? Option.some(exit.value) : Option.none(),
    error: Exit.isFailure(exit) === true ? Cause.findErrorOption(exit.cause) : Option.none(),
    getOrThrow: () => {
      if (Exit.isSuccess(exit) === true) {
        return exit.value
      }
      throw Cause.squash(exit.cause)
    },
    match: (handlers) =>
      Exit.match(exit, {
        onSuccess: handlers.onSuccess,
        onFailure: (cause) => {
          const failure = Cause.findErrorOption(cause)
          if (Option.isSome(failure) === true) {
            return handlers.onFailure(failure.value)
          }
          if (handlers.onDefect !== undefined) {
            const defect = Option.map(Result.getSuccess(Cause.findDie(cause)), (die) => die.defect)
            if (Option.isSome(defect) === true) {
              return handlers.onDefect(defect.value)
            }
          }
          return handlers.onFailure(Cause.squash(cause) as E)
        },
      }),
  }
}

/**
 * Hook to use loader data from an Effect route.
 * Wraps the raw ExitEncoded in an EffectLoaderResult.
 */
export const useEffectLoaderData = <A, E>(route: {
  useLoaderData: () => ExitEncoded
}): EffectLoaderResult<A, E> => {
  const encoded = route.useLoaderData()
  return makeEffectLoaderResult<A, E>(encoded)
}

/**
 * Creates an Effect-native file route.
 *
 * This is a wrapper around TanStack Router's `createFileRoute` that provides:
 * - Effect-native loader with typed errors
 * - Automatic Exit serialization for SSR
 * - Layer-based dependency injection
 * - Pattern matching helpers for components
 *
 * @example
 * ```typescript
 * import { createEffectRoute, useEffectLoaderData } from '@overeng/effect-rpc-tanstack/router'
 *
 * export const Route = createEffectRoute('/users/$id')({
 *   loader: ({ params }) => userClient.GetUser({ id: params.id }),
 *   component: UserDetail,
 * })
 *
 * const UserDetail = () => {
 *   const result = useEffectLoaderData(Route)
 *
 *   return result.match({
 *     onSuccess: (user) => <div>{user.name}</div>,
 *     onFailure: (error) => <div>Error: {error.message}</div>,
 *   })
 * }
 * ```
 */
export const createEffectRoute = <TFilePath extends keyof FileRoutesByPath>(path: TFilePath) => {
  return <TParams, TLoaderData, TLoaderError, TLoaderContext = never>(
    options: EffectRouteOptions<TParams, TLoaderData, TLoaderError, TLoaderContext>,
  ) => {
    const tanstackRoute = createFileRoute(path)
    const loader = options.loader
    type TanstackRouteOptions = NonNullable<Parameters<typeof tanstackRoute>[0]>
    type TanstackLoader = Extract<
      NonNullable<TanstackRouteOptions['loader']>,
      (...args: readonly any[]) => unknown
    >
    type TanstackLoaderContext = Parameters<TanstackLoader>[0]

    const config = {
      ...(loader !== undefined
        ? {
            loader: async (ctx: TanstackLoaderContext) => {
              const effect = loader({
                params: ctx.params as TParams,
                abortController: ctx.abortController,
              })

              const provided =
                options.loaderLayer !== undefined
                  ? Effect.provide(effect, options.loaderLayer)
                  : (effect as Effect.Effect<TLoaderData, TLoaderError, never>)

              const exit = await Effect.runPromiseExit(provided)
              return encodeExit(exit)
            },
          }
        : {}),
      ...(options.component !== undefined ? { component: options.component } : {}),
      ...(options.errorComponent !== undefined ? { errorComponent: options.errorComponent } : {}),
      ...(options.pendingComponent !== undefined
        ? { pendingComponent: options.pendingComponent }
        : {}),
    } satisfies Parameters<typeof tanstackRoute>[0]

    return tanstackRoute(config as Parameters<typeof tanstackRoute>[0])
  }
}
