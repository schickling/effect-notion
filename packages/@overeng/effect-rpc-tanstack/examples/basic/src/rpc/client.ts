/**
 * Client-side RPC client using idiomatic @effect/rpc patterns
 */

import { Effect } from 'effect'
import { RpcClient, type RpcClientError } from 'effect/unstable/rpc'

import { layerClient } from '@overeng/effect-rpc-tanstack/client'

import { type User, UserApi, type UserNotFoundError } from './api.ts'

/**
 * Client layer using the TanStack Start transport
 */
const ProtocolLive = layerClient({ url: '/api/rpc' })

/**
 * Type-safe user RPC client using RpcClient.make()
 */
export const userClient = {
  getUser: (payload: {
    id: string
  }): Effect.Effect<User, UserNotFoundError | RpcClientError.RpcClientError> =>
    Effect.gen(function* () {
      const client = yield* RpcClient.make(UserApi)
      return yield* client.GetUser(payload)
    }).pipe(Effect.provide(ProtocolLive), Effect.scoped),

  listUsers: (): Effect.Effect<readonly User[], RpcClientError.RpcClientError> =>
    Effect.gen(function* () {
      const client = yield* RpcClient.make(UserApi)
      return yield* client.ListUsers()
    }).pipe(Effect.provide(ProtocolLive), Effect.scoped),

  createUser: (payload: {
    name: string
    email: string
  }): Effect.Effect<User, RpcClientError.RpcClientError> =>
    Effect.gen(function* () {
      const client = yield* RpcClient.make(UserApi)
      return yield* client.CreateUser(payload)
    }).pipe(Effect.provide(ProtocolLive), Effect.scoped),
}
