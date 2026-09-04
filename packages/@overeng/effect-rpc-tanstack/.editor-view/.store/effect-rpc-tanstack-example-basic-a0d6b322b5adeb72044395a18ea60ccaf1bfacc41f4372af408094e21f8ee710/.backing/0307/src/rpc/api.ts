/**
 * Shared RPC API definitions using idiomatic @effect/rpc patterns
 */

import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/unstable/rpc'

/**
 * User domain model
 */
export class User extends Schema.Class<User>('User')({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
}) {}

/**
 * Error when user is not found
 */
export class UserNotFoundError extends Schema.TaggedError<UserNotFoundError>()(
  'UserNotFoundError',
  {
    userId: Schema.String,
  },
) {}

/**
 * RPC definitions using Rpc.make()
 */
export const GetUser = Rpc.make('GetUser', {
  payload: { id: Schema.String },
  success: User,
  error: UserNotFoundError,
})

/** RPC to list all users */
export const ListUsers = Rpc.make('ListUsers', {
  success: Schema.Array(User),
})

/** RPC to create a new user */
export const CreateUser = Rpc.make('CreateUser', {
  payload: {
    name: Schema.String,
    email: Schema.String,
  },
  success: User,
})

/**
 * User API RpcGroup - shared between client and server
 */
export const UserApi = RpcGroup.make(GetUser, ListUsers, CreateUser)
