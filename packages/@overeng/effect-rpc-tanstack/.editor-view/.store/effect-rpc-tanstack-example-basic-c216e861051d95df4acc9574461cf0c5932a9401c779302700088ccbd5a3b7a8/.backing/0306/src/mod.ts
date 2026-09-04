/**
 * @overeng/effect-rpc-tanstack
 *
 * Effect RPC integration for TanStack Start using the native HTTP RPC protocol.
 *
 * ## Server Usage
 *
 * ```typescript
 * import { Rpc, RpcGroup } from 'effect/unstable/rpc'
 * import { Schema, Effect } from 'effect'
 * import { createFileRoute } from '@tanstack/react-router'
 * import { makeHandler } from '@overeng/effect-rpc-tanstack/server'
 *
 * // Define RPC endpoints
 * const GetUser = Rpc.make('GetUser', {
 *   payload: { id: Schema.String },
 *   success: User,
 *   error: UserNotFoundError,
 * })
 *
 * const UserApi = RpcGroup.make(GetUser)
 *
 * // Implement handlers
 * const UserHandlers = UserApi.toLayer(Effect.gen(function*() {
 *   return UserApi.of({
 *     GetUser: ({ id }) => Effect.succeed(new User({ id, name: 'John' })),
 *   })
 * }))
 *
 * const { handler } = makeHandler({ group: UserApi, handlerLayer: UserHandlers })
 *
 * export const Route = createFileRoute('/api/rpc')({
 *   server: {
 *     handlers: {
 *       POST: ({ request }) => handler(request),
 *     },
 *   },
 * })
 * ```
 *
 * ## Client Usage
 *
 * ```typescript
 * import { RpcClient } from 'effect/unstable/rpc'
 * import { Effect } from 'effect'
 * import { layerClient } from '@overeng/effect-rpc-tanstack/client'
 * import { UserApi } from './api.ts'
 *
 * const program = Effect.gen(function*() {
 *   const client = yield* RpcClient.make(UserApi)
 *   const user = yield* client.GetUser({ id: '123' })
 *   return user
 * })
 *
 * program.pipe(
 *   Effect.provide(layerClient({ url: '/api/rpc' })),
 *   Effect.runPromise
 * )
 * ```
 *
 * @since 0.1.0
 */

export * from './client.ts'
export * from './router.ts'

/**
 * Re-export RPC primitives for direct access
 */
export { RpcClient, RpcClientError, RpcSerialization, RpcServer } from 'effect/unstable/rpc'
