/**
 * GitHub session management for internal web API access.
 *
 * Only the `user_session` cookie is needed — GitHub bootstraps `_gh_sess`
 * from it on each request. The cookie lasts ~14 days.
 *
 * Auth flow:
 * - `gh-ci-utils auth login` opens a Playwright browser for GitHub login
 * - The `user_session` cookie is extracted and saved
 * - Internal API calls send it as `Cookie: user_session=...`
 */
import { FileSystem } from 'effect'
import { Effect, Option, Schema } from 'effect'

import { ConfigError } from '../isomorphic/Errors.ts'

const SESSION_DIR = '~/.config/gh-ci-utils'
const SESSION_FILE = `${SESSION_DIR}/session.json`

const resolveHome = (path: string) => path.replace(/^~/, process.env.HOME ?? '/tmp')

/** Persistent session cookie data for GitHub internal API auth */
export const SessionData = Schema.Struct({
  /** The user_session cookie value (48 chars, httpOnly, ~14 day expiry). */
  userSession: Schema.String,
  /** Unix timestamp (seconds) when the cookie expires. */
  expiresAt: Schema.Finite,
  /** ISO string of when session was saved. */
  savedAt: Schema.String,
  /** GitHub username. */
  user: Schema.optional(Schema.String),
})
export type SessionData = typeof SessionData.Type

/** Read stored session. Returns None if no session or expired. */
export const loadSession = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = resolveHome(SESSION_FILE)

  const exists = yield* fs.exists(path)
  if (!exists) return Option.none<SessionData>()

  const content = yield* fs
    .readFileString(path)
    .pipe(
      Effect.mapError(
        (cause) => new ConfigError({ message: `Failed to read session file: ${path}`, cause }),
      ),
    )

  const data = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SessionData))(content).pipe(
    Effect.mapError((cause) => new ConfigError({ message: 'Failed to parse session data', cause })),
  )

  if (data.expiresAt > 0 && data.expiresAt * 1000 < Date.now()) {
    return Option.none<SessionData>()
  }

  return Option.some(data)
})

/** Save session to disk. */
export const saveSession = (data: SessionData) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = resolveHome(SESSION_DIR)
    const path = resolveHome(SESSION_FILE)

    yield* fs
      .makeDirectory(dir, { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => new ConfigError({ message: `Failed to create session dir: ${dir}`, cause }),
        ),
      )

    const json = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(SessionData))(data).pipe(
      Effect.mapError(
        (cause) => new ConfigError({ message: 'Failed to encode session data', cause }),
      ),
    )

    yield* fs
      .writeFileString(path, json)
      .pipe(
        Effect.mapError(
          (cause) => new ConfigError({ message: `Failed to write session file: ${path}`, cause }),
        ),
      )

    yield* fs.chmod(path, 0o600).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigError({
            message: `Failed to set permissions on session file: ${path}`,
            cause,
          }),
      ),
    )
  })

/** Build Cookie header from session. Only `user_session` is needed. */
export const buildCookieHeader = (session: SessionData): string =>
  `user_session=${session.userSession}`

/** Check if session expires within 2 days. */
export const isSessionNearExpiry = (session: SessionData): boolean => {
  if (session.expiresAt <= 0) return true
  const twoDaysMs = 2 * 24 * 60 * 60 * 1000
  return session.expiresAt * 1000 - Date.now() < twoDaysMs
}
