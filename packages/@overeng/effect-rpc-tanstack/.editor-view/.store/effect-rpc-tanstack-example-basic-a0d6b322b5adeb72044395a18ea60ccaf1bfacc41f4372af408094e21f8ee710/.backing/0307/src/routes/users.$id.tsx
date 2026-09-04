import type { RpcClientError } from 'effect/unstable/rpc'

import {
  createEffectRoute,
  type ExitEncoded,
  makeEffectLoaderResult,
} from '@overeng/effect-rpc-tanstack/router'

import { type User, UserNotFoundError } from '../rpc/api.ts'
import { userClient } from '../rpc/client.ts'

type LoaderError = UserNotFoundError | RpcClientError.RpcClientError

const UserDetailPage = () => {
  const encoded = Route.useLoaderData() as ExitEncoded
  const result = makeEffectLoaderResult<User, LoaderError>(encoded)

  return result.match({
    onSuccess: (user) => (
      <div>
        <h2>User Details</h2>
        <dl>
          <dt>ID</dt>
          <dd data-testid="user-id">{user.id}</dd>
          <dt>Name</dt>
          <dd data-testid="user-name">{user.name}</dd>
          <dt>Email</dt>
          <dd data-testid="user-email">{user.email}</dd>
        </dl>
        <a href="/">← Back to users</a>
      </div>
    ),
    onFailure: (error) => (
      <div>
        <h2>Error</h2>
        <p style={{ color: 'red' }}>
          {error instanceof UserNotFoundError ? `User not found: ${error.userId}` : String(error)}
        </p>
        <a href="/">← Back to users</a>
      </div>
    ),
  })
}

/** User detail page route */
export const Route = createEffectRoute('/users/$id')<{ id: string }, User, LoaderError>({
  loader: ({ params }) => userClient.getUser({ id: params.id }),
  component: UserDetailPage,
})
