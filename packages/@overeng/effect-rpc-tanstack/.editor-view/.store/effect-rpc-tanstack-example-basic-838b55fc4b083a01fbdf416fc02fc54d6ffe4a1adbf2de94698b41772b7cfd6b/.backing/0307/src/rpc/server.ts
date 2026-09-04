/**
 * Server-side RPC implementation using idiomatic @effect/rpc patterns
 */

import { Effect, Ref } from 'effect'

import { User, UserApi, UserNotFoundError } from './api.ts'

/**
 * In-memory user store (for demo purposes)
 */
const usersRef = Ref.makeUnsafe<User[]>([
  new User({ id: '1', name: 'Alice', email: 'alice@example.com' }),
  new User({ id: '2', name: 'Bob', email: 'bob@example.com' }),
])

let nextId = 3

/**
 * User API handler layer using RpcGroup.toLayer()
 */
export const UserHandlers = UserApi.toLayer(
  Effect.succeed(
    UserApi.of({
      GetUser: ({ id }) =>
        Effect.gen(function* () {
          const users = yield* Ref.get(usersRef)
          const user = users.find((u) => u.id === id)
          if (user === undefined) {
            return yield* Effect.fail(new UserNotFoundError({ userId: id }))
          }
          return user
        }),

      ListUsers: () => Ref.get(usersRef),

      CreateUser: ({ name, email }) =>
        Effect.gen(function* () {
          const newUser = new User({ id: String(nextId++), name, email })
          yield* Ref.update(usersRef, (users) => [...users, newUser])
          return newUser
        }),
    }),
  ),
)
