import { Context, Effect, Layer, Option, Schema } from 'effect'
/**
 * GitHub internal web API client.
 *
 * Provides access to per-step logs and real-time log streaming
 * that the REST API doesn't support. Requires session cookies.
 *
 * Endpoints:
 * - /actions/runs/{run}/jobs/{internalId}/steps — step list with UUIDs
 * - /actions/runs/{run}/jobs/{internalId}/steps/{uuid}/backscroll — live log lines
 * - /actions/runs/{run}/job/{restId} (HTML) — extract internal job ID
 * - /commit/{sha}/checks/{restId}/logs/{stepNum} — completed step log redirect
 */
import { HttpClient, HttpClientRequest } from 'effect/unstable/http'

import { GitHubApiError } from '../isomorphic/Errors.ts'
import {
  type SessionData,
  buildCookieHeader,
  loadSession,
  isSessionNearExpiry,
} from './GitHubSession.ts'
import { withGitHubSpan } from './observability.ts'

const GITHUB_BASE = 'https://github.com'

const isLoginPageHtml = (html: string): boolean =>
  html.includes('action="/session"') || html.includes('Sign in to GitHub')

/** Schema for an individual workflow step from the internal API */
export const InternalStep = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  number: Schema.Finite,
  started_at: Schema.NullOr(Schema.String),
  completed_at: Schema.NullOr(Schema.String),
  change_id: Schema.Finite,
})
export type InternalStep = typeof InternalStep.Type

/** A single log line from the backscroll internal API */
export const BackscrollLine = Schema.Struct({
  id: Schema.String,
  line: Schema.String,
})
export type BackscrollLine = typeof BackscrollLine.Type

/** Response envelope from the backscroll internal API */
export const BackscrollResponse = Schema.Struct({
  lines: Schema.optional(Schema.Array(BackscrollLine)),
})

const makeGitHubInternal = Effect.gen(function* () {
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope)

  /** Execute and decode an authenticated JSON request before its response scope closes. */
  const internalGetJson = ({ path, session }: { path: string; session: SessionData }) =>
    Effect.gen(function* () {
      const response = yield* httpClient
        .execute(
          HttpClientRequest.get(`${GITHUB_BASE}${path}`).pipe(
            HttpClientRequest.setHeaders({
              Accept: 'application/json',
              'X-Requested-With': 'XMLHttpRequest',
              Cookie: buildCookieHeader(session),
            }),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new GitHubApiError({
                message: `Internal API request failed: GET ${path}`,
                cause,
              }),
          ),
        )
      if (response.status >= 300) {
        return yield* new GitHubApiError({
          message: `GitHub returned ${response.status} from internal API: GET ${path}`,
          cause: `HTTP ${response.status}`,
        })
      }
      return yield* response.json.pipe(
        Effect.mapError(
          (cause) =>
            new GitHubApiError({ message: 'Failed to parse internal API response', cause }),
        ),
      )
    }).pipe(Effect.scoped)

  /** Execute and consume an authenticated HTML request before its response scope closes. */
  const internalGetHtml = ({ path, session }: { path: string; session: SessionData }) =>
    Effect.gen(function* () {
      const response = yield* httpClient
        .execute(
          HttpClientRequest.get(`${GITHUB_BASE}${path}`).pipe(
            HttpClientRequest.setHeaders({
              Accept: 'text/html',
              Cookie: buildCookieHeader(session),
            }),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new GitHubApiError({
                message: `Internal HTML request failed: GET ${path}`,
                cause,
              }),
          ),
        )
      if (response.status >= 300) {
        const location = response.headers.location
        const redirectedToLogin = location?.includes('/login') === true
        return yield* new GitHubApiError({
          message: redirectedToLogin
            ? `GitHub session was rejected while resolving job ${path}; sign in again`
            : `GitHub returned ${response.status} while resolving internal job: GET ${path}`,
          cause: `HTTP ${response.status}`,
        })
      }
      return yield* response.text.pipe(
        Effect.mapError(
          (cause) => new GitHubApiError({ message: 'Failed to read job page HTML', cause }),
        ),
      )
    }).pipe(Effect.scoped)

  /**
   * Extract the internal job ID from the job page HTML.
   * The internal ID is embedded in the `data-job-steps-url` attribute.
   */
  const resolveInternalJobId = ({
    owner,
    repo,
    runId,
    restJobId,
    session,
  }: {
    owner: string
    repo: string
    runId: number
    restJobId: number
    session: SessionData
  }) =>
    Effect.gen(function* () {
      const html = yield* internalGetHtml({
        path: `/${owner}/${repo}/actions/runs/${runId}/job/${restJobId}`,
        session,
      })

      if (isLoginPageHtml(html)) {
        return yield* new GitHubApiError({
          message: `GitHub session was rejected while resolving job ${restJobId}; sign in again`,
          cause: 'GitHub login page',
        })
      }

      const match = /\/jobs\/(\d+)\/steps/.exec(html)
      if (!match?.[1]) {
        return yield* new GitHubApiError({
          message: `Could not extract internal job ID from HTML for job ${restJobId}`,
          cause: 'parse error',
        })
      }

      return Number(match[1])
    }).pipe(
      withGitHubSpan({
        name: 'github-internal.resolveInternalJobId',
        attributes: { owner, repo, runId, restJobId },
      }),
    )

  /** Get step list for a job (requires internal job ID). */
  const getSteps = ({
    owner,
    repo,
    runId,
    internalJobId,
    session,
    changeId = 0,
  }: {
    owner: string
    repo: string
    runId: number
    internalJobId: number
    session: SessionData
    changeId?: number
  }) =>
    Effect.gen(function* () {
      const json = yield* internalGetJson({
        path: `/${owner}/${repo}/actions/runs/${runId}/jobs/${internalJobId}/steps?change_id=${changeId}`,
        session,
      })
      return yield* Schema.decodeUnknownEffect(Schema.Array(InternalStep))(json).pipe(
        Effect.mapError(
          (cause) => new GitHubApiError({ message: 'Failed to decode steps', cause }),
        ),
      )
    }).pipe(
      withGitHubSpan({
        name: 'github-internal.getSteps',
        attributes: { owner, repo, runId, internalJobId },
      }),
    )

  /**
   * Get live log lines for an in-progress step (backscroll).
   * Returns empty array if step is completed.
   */
  const getBackscroll = ({
    owner,
    repo,
    runId,
    internalJobId,
    stepUuid,
    session,
    etag,
  }: {
    owner: string
    repo: string
    runId: number
    internalJobId: number
    stepUuid: string
    session: SessionData
    etag?: string
  }) =>
    Effect.gen(function* () {
      const request = HttpClientRequest.get(
        `${GITHUB_BASE}/${owner}/${repo}/actions/runs/${runId}/jobs/${internalJobId}/steps/${stepUuid}/backscroll`,
      ).pipe(
        HttpClientRequest.setHeaders({
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          Cookie: buildCookieHeader(session),
          ...(etag ? { 'If-None-Match': etag } : {}),
        }),
      )

      const response = yield* httpClient
        .execute(request)
        .pipe(
          Effect.mapError(
            (cause) => new GitHubApiError({ message: 'Backscroll request failed', cause }),
          ),
        )

      if (response.status === 304) {
        return { lines: [], etag, unchanged: true } as const
      }

      const newEtag = response.headers.etag ?? undefined
      const json = yield* response.json.pipe(
        Effect.mapError(
          (cause) => new GitHubApiError({ message: 'Failed to parse backscroll', cause }),
        ),
      )

      const data = yield* Schema.decodeUnknownEffect(BackscrollResponse)(json).pipe(
        Effect.mapError(
          (cause) => new GitHubApiError({ message: 'Failed to decode backscroll', cause }),
        ),
      )

      return { lines: data.lines ?? [], etag: newEtag, unchanged: false } as const
    }).pipe(
      Effect.scoped,
      withGitHubSpan({
        name: 'github-internal.getBackscroll',
        attributes: { owner, repo, runId, internalJobId, stepUuid },
      }),
    )

  /** Fetch the redirected log payload for one completed workflow step. */
  const getCompletedStepLog = ({
    owner,
    repo,
    headSha,
    restJobId,
    stepNumber,
    session,
  }: {
    owner: string
    repo: string
    headSha: string
    restJobId: number
    stepNumber: number
    session: SessionData
  }) =>
    Effect.gen(function* () {
      const path = `/${owner}/${repo}/commit/${headSha}/checks/${restJobId}/logs/${stepNumber}`
      const requestUrl = `${GITHUB_BASE}${path}`
      const response = yield* httpClient
        .execute(
          HttpClientRequest.get(requestUrl).pipe(
            HttpClientRequest.setHeaders({
              Accept: 'text/plain',
              Cookie: buildCookieHeader(session),
            }),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new GitHubApiError({
                message: `Completed step log request failed: GET ${path}`,
                cause,
              }),
          ),
        )

      if (response.status >= 400) {
        return yield* new GitHubApiError({
          message: `GitHub returned ${response.status} for completed step log: GET ${path}`,
          cause: `HTTP ${response.status}`,
        })
      }

      const logResponse =
        response.status >= 300
          ? yield* Effect.gen(function* () {
              const location = response.headers['location']
              if (location === undefined) {
                return yield* new GitHubApiError({
                  message: `GitHub returned ${response.status} without a location header: GET ${path}`,
                  cause: `HTTP ${response.status}`,
                })
              }
              const storageUrl = URL.parse(location, requestUrl)
              if (storageUrl === null) {
                return yield* new GitHubApiError({
                  message: `GitHub returned an unusable location header '${location}': GET ${path}`,
                  cause: 'invalid redirect',
                })
              }
              if (
                storageUrl.origin === GITHUB_BASE &&
                (storageUrl.pathname.startsWith('/login') ||
                  storageUrl.pathname.startsWith('/session'))
              ) {
                return yield* new GitHubApiError({
                  message: `GitHub session was rejected while fetching completed step log for job ${restJobId}; sign in again`,
                  cause: 'GitHub login redirect',
                })
              }
              return yield* httpClient.execute(HttpClientRequest.get(storageUrl.href)).pipe(
                Effect.mapError(
                  (cause) =>
                    new GitHubApiError({
                      message: `Completed step log storage request failed: GET ${path}`,
                      cause,
                    }),
                ),
              )
            })
          : response

      if (logResponse.status >= 300) {
        return yield* new GitHubApiError({
          message: `Completed step log storage returned ${logResponse.status}: GET ${path}`,
          cause: `HTTP ${logResponse.status}`,
        })
      }

      const logText = yield* logResponse.text.pipe(
        Effect.mapError(
          (cause) =>
            new GitHubApiError({
              message: `Failed to read completed step log: GET ${path}`,
              cause,
            }),
        ),
      )
      if (isLoginPageHtml(logText)) {
        return yield* new GitHubApiError({
          message: `GitHub session was rejected while fetching completed step log for job ${restJobId}; sign in again`,
          cause: 'GitHub login page',
        })
      }
      return logText
    }).pipe(
      Effect.scoped,
      withGitHubSpan({
        name: 'github-internal.getCompletedStepLog',
        attributes: { owner, repo, restJobId, stepNumber },
      }),
    )

  /** Try to load session, returning None if unavailable or expired. */
  const getSession = loadSession.pipe(Effect.orElseSucceed(() => Option.none<SessionData>()))

  /** Check if session is available and warn if near expiry. */
  const checkSession = Effect.gen(function* () {
    const session = yield* getSession
    if (Option.isNone(session)) return { available: false, nearExpiry: false } as const
    return {
      available: true,
      nearExpiry: isSessionNearExpiry(session.value),
      session: session.value,
    } as const
  })

  return {
    resolveInternalJobId,
    getSteps,
    getBackscroll,
    getCompletedStepLog,
    getSession,
    checkSession,
  } as const
})

type GitHubInternalShape = Effect.Success<typeof makeGitHubInternal>

/** Client for undocumented GitHub internal APIs (backscroll, live logs). */
export class GitHubInternal extends Context.Service<GitHubInternal, GitHubInternalShape>()(
  'gh-ci-utils/GitHubInternal',
) {
  static readonly Default = Layer.effect(GitHubInternal, makeGitHubInternal)
}
