import { Effect } from 'effect'
import type { RpcClientError } from 'effect/unstable/rpc'
import { useState, type SyntheticEvent } from 'react'

import {
  createEffectRoute,
  type ExitEncoded,
  makeEffectLoaderResult,
} from '@overeng/effect-rpc-tanstack/router'

import type { User } from '../rpc/api.ts'
import { userClient } from '../rpc/client.ts'

const UsersListPage = () => {
  const encoded = Route.useLoaderData() as ExitEncoded
  const result = makeEffectLoaderResult<readonly User[], RpcClientError.RpcClientError>(encoded)

  return result.match({
    onSuccess: (initialUsers) => <UserList initialUsers={initialUsers} />,
    onFailure: (error) => (
      <div>
        <h2>Error loading users</h2>
        <p style={{ color: 'red' }}>{String(error)}</p>
      </div>
    ),
  })
}

/** Home page route showing user list */
export const Route = createEffectRoute('/')<void, readonly User[], RpcClientError.RpcClientError>({
  loader: () => userClient.listUsers(),
  component: UsersListPage,
})

const UserList = ({ initialUsers }: { initialUsers: readonly User[] }): React.ReactElement => {
  const [users, setUsers] = useState<readonly User[]>(initialUsers)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCreateUser = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    await userClient
      .createUser({ name, email })
      .pipe(
        Effect.tap((newUser) =>
          Effect.sync(() => {
            setUsers([...users, newUser])
            setName('')
            setEmail('')
          }),
        ),
        Effect.catch((err) => Effect.sync(() => setError(String(err)))),
        Effect.runPromise,
      )
      .finally(() => setLoading(false))
  }

  return (
    <div>
      <h2>Users</h2>

      <ul data-testid="user-list">
        {users.map((user) => (
          <li key={user.id} data-testid={`user-${user.id}`}>
            <strong>{user.name}</strong> ({user.email})
          </li>
        ))}
      </ul>

      <h3>Create User</h3>
      <form onSubmit={handleCreateUser}>
        <div>
          <label>
            Name:
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              data-testid="name-input"
            />
          </label>
        </div>
        <div>
          <label>
            Email:
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              data-testid="email-input"
            />
          </label>
        </div>
        <button type="submit" disabled={loading} data-testid="submit-button">
          {loading === true ? 'Creating...' : 'Create User'}
        </button>
        {error && <p style={{ color: 'red' }}>{error}</p>}
      </form>
    </div>
  )
}
