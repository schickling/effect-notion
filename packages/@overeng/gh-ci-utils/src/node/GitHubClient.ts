/**
 * GitHub API client for CI debugging.
 *
 * Supports either `gh auth token` or GitHub App installation tokens and
 * uses Effect's HTTP client for data fetching with schema validation.
 */
import { createPrivateKey, createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { Context, Duration, Effect, Layer, Option, Ref, Schema } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/unstable/http'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'

import { GitHubApiError, GitHubAuthError, LogsUnavailableError } from '../isomorphic/Errors.ts'
import type { WorkflowJobsResponse } from '../isomorphic/GitHubSchemas.ts'
import * as GH from '../isomorphic/GitHubSchemas.ts'
import { type RateLimitInfo, parseRateLimitHeaders } from '../isomorphic/lib/rateLimit.ts'
import type { PrHealth } from '../isomorphic/lib/viewModels.ts'
import { RateLimitWaitPolicy, budgetOutcome } from '../isomorphic/lib/watchPlan.ts'
import { GitHubAuthConfigTag } from './Config.ts'
import type { GitHubAppAuthConfig } from './Config.ts'
import { withGitHubSpan } from './observability.ts'

const GITHUB_API_BASE = 'https://api.github.com'
const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql'

/**
 * REST and GraphQL are billed from separate buckets with separate resets, so
 * their numbers must never be mixed.
 */
type RateLimitBucket = 'rest' | 'graphql'

/**
 * Requests held back as reserve. Once a bucket drops below this the client
 * parks until the reset instead of spending the last requests, so a follow-up
 * command (`logs`, `rerun`) still has budget to work with.
 */
const RATE_LIMIT_RESERVE = 25

/** Budget below which every response logs a warning. */
const RATE_LIMIT_WARN = 100

interface InstallationTokenInfo {
  readonly token: string
  readonly expiresAt: Date
}

/** Detects Azure Blob Storage XML error responses that GitHub returns instead of log content */
export const isAzureBlobError = (text: string): boolean =>
  text.startsWith('<?xml') || text.includes('<Code>BlobNotFound</Code>')

const ownerFromRepo = (repo: string) => {
  const [owner, repoName, ...rest] = repo.split('/')
  if (owner === undefined || repoName === undefined || rest.length > 0) {
    throw new Error(`Expected repo slug in owner/repo form, got ${repo}`)
  }
  return owner
}

/**
 * Which credential a repo should be read with under GitHub App auth.
 *
 * The auth mode is a global config switch while the credential a request needs
 * is per-owner: owners with a configured installation get an installation
 * token, every other owner falls back to the local `gh` CLI token — the same
 * credential the `gh` binary already uses for that repo.
 */
export type AppAuthSource =
  | { readonly _tag: 'app-installation'; readonly owner: string; readonly installationID: number }
  | { readonly _tag: 'cli-token-fallback'; readonly owner: string }

/** Resolve the credential for `repo` from the configured App installation map. */
export const selectAppAuthSource = ({
  auth,
  repo,
}: {
  auth: Pick<GitHubAppAuthConfig, 'installationIDs'>
  repo: string
}): AppAuthSource => {
  const owner = ownerFromRepo(repo)
  const installationID = auth.installationIDs[owner]
  return installationID === undefined
    ? { _tag: 'cli-token-fallback', owner }
    : { _tag: 'app-installation', owner, installationID }
}

const base64urlJson = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

/** Returns whether a workflow run has not yet reached GitHub's completed state. */
export const isRunActive = (run: Pick<GH.WorkflowRun, 'status'>): boolean =>
  run.status !== 'completed'

/** Workflow file a status verdict prefers when the caller named none. */
export const DEFAULT_EXPECTED_WORKFLOW = 'ci.yml'

/**
 * Match either an exact normalized workflow path or an exact basename.
 *
 * A path argument remains path-specific, while `ci.yml` matches the basename
 * without also accepting suffixes such as `foo-ci.yml`.
 */
export const workflowPathMatches = ({
  candidatePath,
  workflow,
}: {
  candidatePath: string
  workflow: string
}): boolean => {
  const candidate = candidatePath.replaceAll('\\', '/').replace(/^\.?\/+/u, '')
  const wanted = workflow.replaceAll('\\', '/').replace(/^\.?\/+/u, '')
  return wanted.includes('/')
    ? candidate === wanted
    : candidate.slice(candidate.lastIndexOf('/') + 1) === wanted
}

/** Which run a verdict should describe, and what it may claim about the workflow. */
export type VerdictRunPick = {
  readonly run: GH.WorkflowRun | null
  /**
   * Workflow the verdict claims to be about, or `null` when nothing was expected —
   * the caller must not warn about a missing workflow in that case.
   */
  readonly expectedWorkflow: string | null
  readonly matchedExpectedWorkflow: boolean
}

/**
 * Pick the run a verdict should describe, and report what may be claimed about it.
 *
 * `ci.yml` is a *preference*, not an expectation: many repos have no `ci.yml`, and
 * demanding one there turns every verdict into `no_checks`. So an unmatched
 * preference yields `expectedWorkflow: null` — judge the newest run on its own jobs.
 * An unmatched explicit `--workflow` is the opposite: the caller asked about a
 * specific workflow that never ran, and must be told loudly.
 */
export const selectRunForVerdict = ({
  runs,
  preferWorkflow,
  activeOnly = false,
}: {
  runs: readonly GH.WorkflowRun[]
  /** Explicit `--workflow` expectation; absent means "prefer `ci.yml`, accept what ran". */
  preferWorkflow?: string
  activeOnly?: boolean
}): VerdictRunPick => {
  const candidates = activeOnly ? runs.filter(isRunActive) : runs
  if (candidates.length === 0)
    return {
      run: null,
      expectedWorkflow: preferWorkflow ?? null,
      matchedExpectedWorkflow: false,
    }

  const wanted = preferWorkflow ?? DEFAULT_EXPECTED_WORKFLOW
  const match = candidates.find((run) =>
    workflowPathMatches({ candidatePath: run.path, workflow: wanted }),
  )
  if (match) return { run: match, expectedWorkflow: wanted, matchedExpectedWorkflow: true }

  const fallback = candidates[0] ?? null
  return preferWorkflow === undefined
    ? { run: fallback, expectedWorkflow: null, matchedExpectedWorkflow: true }
    : { run: fallback, expectedWorkflow: preferWorkflow, matchedExpectedWorkflow: false }
}

/** Create a signed RS256 JWT for GitHub App authentication (valid for ~9 minutes) */
export const createGitHubAppJwt = ({
  clientID,
  privateKeyPem,
  now = new Date(),
}: {
  clientID: string
  privateKeyPem: string
  now?: Date
}) => {
  const issuedAtSeconds = Math.floor((now.getTime() - 60_000) / 1000)
  const expiresAtSeconds = Math.floor((now.getTime() + 9 * 60_000) / 1000)
  const unsignedToken = `${base64urlJson({ alg: 'RS256', typ: 'JWT' })}.${base64urlJson({
    iat: issuedAtSeconds,
    exp: expiresAtSeconds,
    iss: clientID,
  })}`
  const signature = createSign('RSA-SHA256')
  signature.update(unsignedToken)
  signature.end()
  return `${unsignedToken}.${signature.sign(createPrivateKey(privateKeyPem)).toString('base64url')}`
}

/** Service wrapping the GitHub REST API with rate-limit tracking */
const makeGitHubClient = Effect.gen(function* () {
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope)
  const spawner = yield* ChildProcessSpawner
  const auth = yield* GitHubAuthConfigTag
  const installationTokenRef = yield* Ref.make<Map<string, InstallationTokenInfo>>(new Map())
  const privateKeyRef = yield* Ref.make<Option.Option<string>>(Option.none())
  /** REST bucket, as reported by `api.github.com` REST responses. */
  const rateLimitRef = yield* Ref.make<Option.Option<RateLimitInfo>>(Option.none())
  /** GraphQL bucket — a separate budget with its own reset, never mixed with REST. */
  const graphqlRateLimitRef = yield* Ref.make<Option.Option<RateLimitInfo>>(Option.none())
  /** Every request issued, across both buckets. */
  const requestCountRef = yield* Ref.make(0)
  /** Subset of {@link requestCountRef} billed to the GraphQL bucket. */
  const graphqlRequestCountRef = yield* Ref.make(0)
  /** Requests answered `304 Not Modified`, which GitHub does not bill. */
  const cachedResponseCountRef = yield* Ref.make(0)
  const etagCache = yield* Ref.make<Map<string, { etag: string; value: unknown }>>(new Map())
  /** Owners already warned about the CLI-token fallback, so it is said once per process. */
  const cliFallbackNoticeRef = yield* Ref.make<ReadonlySet<string>>(new Set())

  /**
   * The local `gh` CLI token, resolved at most once per process.
   *
   * `Effect.cached` rather than a `Ref` guard: it dedupes *concurrent* first
   * callers on one latch, so the parallel per-repo requests a single `status`
   * fans out cannot each spawn their own `gh auth token` child.
   */
  const getCliToken = yield* Effect.cached(
    Effect.gen(function* () {
      // `gh auth token` terminates its output with a newline, which is not a legal
      // HTTP header value: an untrimmed token fails as `Invalid character in header
      // content ["authorization"]` rather than as an auth error.
      const output = yield* spawner.string(ChildProcess.make('gh', ['auth', 'token'])).pipe(
        Effect.map((stdout) => stdout.trim()),
        Effect.mapError(
          (cause) =>
            new GitHubAuthError({
              message: 'Failed to get GitHub auth token via `gh auth token`',
              cause,
            }),
        ),
      )

      if (output.length === 0) {
        return yield* new GitHubAuthError({
          message: 'gh auth token returned empty output — is gh authenticated?',
          cause: 'empty token',
        })
      }

      return output
    }),
  )

  const loadPrivateKey = (appAuth: GitHubAppAuthConfig) =>
    Effect.gen(function* () {
      const cached = yield* Ref.get(privateKeyRef)
      if (Option.isSome(cached)) return cached.value

      const privateKey = yield* Effect.try({
        try: () => readFileSync(appAuth.privateKeyPath, 'utf8'),
        catch: (cause) =>
          new GitHubAuthError({
            message: `Failed to read GitHub App private key: ${appAuth.privateKeyPath}`,
            cause,
          }),
      })

      yield* Ref.set(privateKeyRef, Option.some(privateKey))
      return privateKey
    })

  const getInstallationToken = ({
    owner: installationName,
    installationID,
    auth: appAuth,
  }: {
    owner: string
    installationID: number
    auth: GitHubAppAuthConfig
  }) =>
    Effect.gen(function* () {
      const now = Date.now()
      const cachedTokens = yield* Ref.get(installationTokenRef)
      const cached = cachedTokens.get(installationName)
      if (cached !== undefined && cached.expiresAt.getTime() - now > 60_000) {
        return cached.token
      }

      const privateKeyPem = yield* loadPrivateKey(appAuth)
      const appJwt = yield* Effect.try({
        try: () => createGitHubAppJwt({ clientID: appAuth.clientID, privateKeyPem }),
        catch: (cause) =>
          new GitHubAuthError({
            message: 'Failed to create GitHub App JWT',
            cause,
          }),
      })

      yield* Ref.update(requestCountRef, (count) => count + 1)

      const response = yield* httpClient
        .execute(
          HttpClientRequest.post(
            `${GITHUB_API_BASE}/app/installations/${installationID}/access_tokens`,
          ).pipe(
            HttpClientRequest.setHeaders({
              Authorization: `Bearer ${appJwt}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            }),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new GitHubApiError({
                message: `GitHub App installation token request failed for ${installationName}`,
                cause,
              }),
          ),
        )

      if (response.status < 200 || response.status >= 300) {
        const text = yield* response.text.pipe(Effect.orElseSucceed(() => '<no body>'))
        return yield* new GitHubApiError({
          message: `GitHub App installation token request failed (${String(response.status)}): ${text}`,
          cause: text,
        })
      }

      const json = yield* response.json.pipe(
        Effect.mapError(
          (cause) =>
            new GitHubApiError({
              message: `Failed to parse installation token response for ${installationName}`,
              cause,
            }),
        ),
      )

      const token = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          token: Schema.String,
          expires_at: Schema.DateFromString,
        }),
      )(json).pipe(
        Effect.mapError(
          (cause) =>
            new GitHubApiError({
              message: `Invalid installation token response for ${installationName}`,
              cause,
            }),
        ),
      )

      yield* Ref.update(installationTokenRef, (tokens) => {
        const next = new Map(tokens)
        next.set(installationName, { token: token.token, expiresAt: token.expires_at })
        return next
      })

      return token.token
    }).pipe(Effect.scoped)

  /**
   * Resolve the credential every read and write goes through.
   *
   * Under App auth an owner without a configured installation falls back to the
   * local `gh` CLI token instead of failing: the App can only ever be installed
   * on owners we control, so without the fallback every third-party repo is
   * unreachable. The fallback token is strictly less capable than an
   * installation token and is already on the agent's PATH as `gh`, so it grants
   * no new authority.
   */
  const getTokenForRepo = Effect.fn('github-client.get-token-for-repo')(function* (repo: string) {
    if (auth._tag === 'gh-cli') return yield* getCliToken

    const source = selectAppAuthSource({ auth, repo })
    if (source._tag === 'app-installation') {
      return yield* getInstallationToken({
        owner: source.owner,
        installationID: source.installationID,
        auth,
      })
    }

    // `Ref.modify` claims the owner and reports whether this fiber is the one
    // that has to speak: a get-then-set pair would let concurrent requests for
    // the same owner both read an empty set and warn twice.
    const claimedNotice = yield* Ref.modify(cliFallbackNoticeRef, (notified) =>
      notified.has(source.owner) ? [false, notified] : [true, new Set(notified).add(source.owner)],
    )
    if (claimedNotice) {
      yield* Effect.logWarning(
        `No GitHub App installation configured for \`${source.owner}\` — falling back to the local \`gh\` CLI token. Add \`auth.installationIDs.${source.owner}\` to ~/.config/gh-ci-utils/config.json to use the App instead.`,
      )
    }

    return yield* getCliToken.pipe(
      Effect.mapError(
        (cause) =>
          new GitHubAuthError({
            message: `No GitHub App installation is configured for \`${source.owner}\` and the \`gh\` CLI fallback failed: ${cause.message}`,
            cause,
          }),
      ),
    )
  })

  /**
   * Record what a response reported about its bucket. Recording never fails:
   * a low budget is a scheduling problem, handled by {@link awaitBudget}.
   */
  const trackRateLimit = ({
    headers,
    bucket,
  }: {
    headers: Record<string, string | undefined>
    bucket: RateLimitBucket
  }) =>
    Effect.gen(function* () {
      const info = parseRateLimitHeaders(headers)
      if (info === undefined) return
      yield* Ref.set(bucket === 'rest' ? rateLimitRef : graphqlRateLimitRef, Option.some(info))
      if (info.remaining < RATE_LIMIT_WARN) {
        yield* Effect.logWarning(
          `GitHub ${bucket} rate limit low: ${info.remaining}/${info.limit} remaining, resets at ${info.reset.toISOString()}`,
        )
      }
    })

  /**
   * Hold the next request until its bucket can pay for it.
   *
   * Exhaustion is temporary — the bucket refills at `reset` — so a caller that
   * owns a deadline (the watch loop) parks and continues rather than aborting.
   * A caller without one keeps the old fail-fast behaviour: a reset window is
   * an hour, and a one-shot command must report that, not sleep through it.
   * When the recorded reset already lies in the past the numbers are stale and
   * the request proceeds.
   */
  const awaitBudget = (bucket: RateLimitBucket) =>
    Effect.gen(function* () {
      const ref = bucket === 'rest' ? rateLimitRef : graphqlRateLimitRef
      const outcome = budgetOutcome({
        rateLimit: Option.getOrUndefined(yield* Ref.get(ref)),
        nowMs: Date.now(),
        threshold: RATE_LIMIT_RESERVE,
        maxWaitSeconds: yield* RateLimitWaitPolicy,
      })

      if (outcome._tag === 'Proceed') return

      if (outcome._tag === 'Fail') {
        return yield* new GitHubApiError({
          message: `GitHub ${bucket} API rate limit nearly exhausted: ${outcome.remaining}/${outcome.limit} remaining, resets at ${outcome.reset.toISOString()}`,
          cause: 'rate limit exhaustion',
        })
      }

      if (outcome._tag === 'Park') {
        yield* Effect.logWarning(
          `GitHub ${bucket} budget spent (${outcome.remaining}/${outcome.limit}) — parking ${outcome.waitSeconds}s until ${outcome.reset.toISOString()}`,
        )
        yield* Effect.sleep(Duration.seconds(outcome.waitSeconds))
      }

      /** Whether it expired on its own or we waited it out, the cached numbers are void. */
      yield* Ref.set(ref, Option.none())
    })

  const apiGet = <A, I>({
    repo,
    path,
    schema,
    useETag = false,
  }: {
    repo: string
    path: string
    schema: Schema.Codec<A, I>
    useETag?: boolean
  }) =>
    Effect.gen(function* () {
      yield* awaitBudget('rest')
      const token = yield* getTokenForRepo(repo)
      const cache = yield* Ref.get(etagCache)
      const cached = useETag ? cache.get(path) : undefined

      const response = yield* httpClient
        .execute(
          HttpClientRequest.get(`${GITHUB_API_BASE}${path}`).pipe(
            HttpClientRequest.setHeaders({
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              ...(cached ? { 'If-None-Match': cached.etag } : {}),
            }),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new GitHubApiError({
                message: `GitHub API request failed: GET ${path}`,
                cause,
              }),
          ),
        )

      yield* Ref.update(requestCountRef, (n) => n + 1)

      if (response.status === 304 && cached) {
        /** GitHub does not bill `304 Not Modified`, so this tick was free. */
        yield* Ref.update(cachedResponseCountRef, (n) => n + 1)
        return yield* Schema.decodeUnknownEffect(schema)(cached.value).pipe(
          Effect.mapError(
            (cause) =>
              new GitHubApiError({
                message: `Schema decode failed for: GET ${path}`,
                cause,
              }),
          ),
        )
      }

      yield* trackRateLimit({ headers: response.headers, bucket: 'rest' })

      if (response.status < 200 || response.status >= 300) {
        return yield* new GitHubApiError({
          message: `GitHub API error ${response.status}: GET ${path}`,
          cause: undefined,
        })
      }

      const json = yield* response.json.pipe(
        Effect.mapError(
          (cause) =>
            new GitHubApiError({
              message: `Failed to parse JSON from: GET ${path}`,
              cause,
            }),
        ),
      )

      if (useETag && response.headers.etag) {
        yield* Ref.update(etagCache, (m) =>
          new Map(m).set(path, { etag: response.headers.etag!, value: json }),
        )
      }

      return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError(
          (cause) =>
            new GitHubApiError({
              message: `Schema decode failed for: GET ${path}`,
              cause,
            }),
        ),
      )
    }).pipe(Effect.scoped)

  /** Execute an authenticated POST and consume any response body before its scope closes. */
  const apiPostResponse = ({
    repo,
    path,
    body,
    readJson,
  }: {
    repo: string
    path: string
    body?: unknown
    readJson: boolean
  }) =>
    Effect.gen(function* () {
      yield* awaitBudget('rest')
      const token = yield* getTokenForRepo(repo)
      const baseRequest = HttpClientRequest.post(`${GITHUB_API_BASE}${path}`).pipe(
        HttpClientRequest.setHeaders({
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        }),
      )
      const request =
        body === undefined ? baseRequest : HttpClientRequest.bodyJsonUnsafe(body)(baseRequest)

      const response = yield* httpClient.execute(request).pipe(
        Effect.mapError(
          (cause) =>
            new GitHubApiError({
              message: `GitHub API request failed: POST ${path}`,
              cause,
            }),
        ),
      )

      yield* Ref.update(requestCountRef, (n) => n + 1)
      yield* trackRateLimit({ headers: response.headers, bucket: 'rest' })

      if (response.status >= 400) {
        const responseBody = yield* response.text.pipe(Effect.orElseSucceed(() => ''))
        return yield* new GitHubApiError({
          message: `GitHub API returned ${response.status}: POST ${path}${responseBody ? ` — ${responseBody}` : ''}`,
          cause: `HTTP ${response.status}`,
        })
      }

      if (!readJson) return undefined
      return yield* response.json.pipe(
        Effect.mapError(
          (cause) =>
            new GitHubApiError({
              message: `Failed to parse JSON from: POST ${path}`,
              cause,
            }),
        ),
      )
    }).pipe(Effect.scoped)

  /** Make an authenticated POST request for a GitHub mutation with no response payload. */
  const apiPost = (options: { repo: string; path: string; body?: unknown }) =>
    apiPostResponse({ ...options, readJson: false }).pipe(Effect.asVoid)

  /** Make an authenticated POST request and decode its JSON response. */
  const apiPostJson = <TValue, TEncoded>({
    repo,
    path,
    body,
    schema,
  }: {
    repo: string
    path: string
    body?: unknown
    schema: Schema.Codec<TValue, TEncoded>
  }) =>
    Effect.gen(function* () {
      const json = yield* apiPostResponse({ repo, path, body, readJson: true })
      return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError(
          (cause) =>
            new GitHubApiError({
              message: `Schema decode failed for: POST ${path}`,
              cause,
            }),
        ),
      )
    })

  /**
   * Fetch raw text (for log download endpoints).
   *
   * `/actions/jobs/{id}/logs` answers `302` with a `Location` pointing at the
   * blob store that actually holds the log; the body of that 302 is empty.
   * The redirect is followed here rather than by `HttpClient.followRedirects`
   * so the GitHub token is not forwarded to a third-party storage host — the
   * redirect URL already carries its own short-lived credentials.
   */
  const apiGetText = ({ repo, path }: { repo: string; path: string }) =>
    Effect.gen(function* () {
      yield* awaitBudget('rest')
      const token = yield* getTokenForRepo(repo)
      const requestUrl = `${GITHUB_API_BASE}${path}`

      const response = yield* httpClient
        .execute(
          HttpClientRequest.get(requestUrl).pipe(
            HttpClientRequest.setHeaders({
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            }),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new GitHubApiError({
                message: `GitHub API request failed: GET ${path}`,
                cause,
              }),
          ),
        )

      yield* Ref.update(requestCountRef, (n) => n + 1)
      yield* trackRateLimit({ headers: response.headers, bucket: 'rest' })

      if (response.status === 404) {
        return yield* new LogsUnavailableError({
          message: `GitHub API returned 404: GET ${path}`,
          jobId: 0,
        })
      }
      if (response.status >= 400) {
        const responseBody = yield* response.text.pipe(Effect.orElseSucceed(() => ''))
        return yield* new GitHubApiError({
          message: `GitHub API returned ${response.status}: GET ${path}${responseBody ? ` — ${responseBody}` : ''}`,
          cause: `HTTP ${response.status}`,
        })
      }

      if (response.status >= 300) {
        const location = response.headers['location']
        if (location === undefined) {
          return yield* new GitHubApiError({
            message: `GitHub API returned ${response.status} without a location header: GET ${path}`,
            cause: `HTTP ${response.status}`,
          })
        }

        /** The header may be relative, so resolve it against the request it answered. */
        const storageUrl = URL.parse(location, requestUrl)
        if (storageUrl === null) {
          return yield* new GitHubApiError({
            message: `GitHub API returned ${response.status} with an unusable location header '${location}': GET ${path}`,
            cause: 'invalid redirect',
          })
        }

        const stored = yield* httpClient.execute(HttpClientRequest.get(storageUrl.href)).pipe(
          Effect.mapError(
            (cause) =>
              new GitHubApiError({
                message: `Log storage request failed: GET ${path}`,
                cause,
              }),
          ),
        )

        /**
         * Redirects are followed exactly once so the storage credentials in the
         * first `Location` are never replayed to a third host we did not vet.
         */
        if (stored.status >= 300 && stored.status < 400) {
          return yield* new GitHubApiError({
            message: `Log storage chained another redirect (${stored.status} -> ${stored.headers['location'] ?? 'no location header'}): GET ${path}`,
            cause: `HTTP ${stored.status}`,
          })
        }

        if (stored.status === 404) {
          return yield* new LogsUnavailableError({
            message: `Log storage returned 404: GET ${path}`,
            jobId: 0,
          })
        }
        if (stored.status >= 400) {
          return yield* new GitHubApiError({
            message: `Log storage returned ${stored.status}: GET ${path}`,
            cause: `HTTP ${stored.status}`,
          })
        }

        return yield* stored.text.pipe(
          Effect.mapError(
            (cause) =>
              new GitHubApiError({
                message: `Failed to read log storage response: GET ${path}`,
                cause,
              }),
          ),
        )
      }

      return yield* response.text.pipe(
        Effect.mapError(
          (cause) =>
            new GitHubApiError({
              message: `Failed to read text from: GET ${path}`,
              cause,
            }),
        ),
      )
    }).pipe(Effect.scoped)

  /** List active (queued + in_progress) workflow runs for a repo. */
  const listActiveRuns = (repo: string) =>
    Effect.all([
      apiGet({
        repo,
        path: `/repos/${repo}/actions/runs?status=queued&per_page=100`,
        schema: GH.WorkflowRunsResponse,
        useETag: true,
      }),
      apiGet({
        repo,
        path: `/repos/${repo}/actions/runs?status=in_progress&per_page=100`,
        schema: GH.WorkflowRunsResponse,
        useETag: true,
      }),
    ]).pipe(
      Effect.map(([queued, inProgress]) => ({
        total_count: queued.total_count + inProgress.total_count,
        workflow_runs: [...queued.workflow_runs, ...inProgress.workflow_runs],
      })),
      withGitHubSpan({ name: 'github-client.listActiveRuns', attributes: { repo } }),
    )

  /** List workflow runs for a repo filtered by status. */
  const listWorkflowRunsByStatus = ({ repo, status }: { repo: string; status: GH.RunStatus }) =>
    apiGet({
      repo,
      path: `/repos/${repo}/actions/runs?status=${encodeURIComponent(status)}&per_page=100`,
      schema: GH.WorkflowRunsResponse,
      useETag: true,
    }).pipe(
      withGitHubSpan({
        name: 'github-client.listWorkflowRunsByStatus',
        attributes: { repo, status },
      }),
    )

  /** Get a single workflow run by ID. */
  const getWorkflowRun = ({ repo, runId }: { repo: string; runId: number }) =>
    apiGet({
      repo,
      path: `/repos/${repo}/actions/runs/${runId}`,
      schema: GH.WorkflowRun,
      useETag: true,
    }).pipe(withGitHubSpan({ name: 'github-client.getWorkflowRun', attributes: { repo, runId } }))

  /**
   * Get a single workflow job by its numeric id.
   *
   * `inspect` is addressed by job id, not run id, so listing a run's jobs to
   * find one would cost a paginated fetch to discard nearly all of it.
   */
  const getWorkflowJob = ({ repo, jobId }: { repo: string; jobId: number }) =>
    apiGet({
      repo,
      path: `/repos/${repo}/actions/jobs/${jobId}`,
      schema: GH.WorkflowJob,
      useETag: true,
    }).pipe(Effect.withSpan('github-client.getWorkflowJob', { attributes: { repo, jobId } }))

  /** List all jobs for a workflow run (handles pagination). */
  const listWorkflowJobs = ({ repo, runId }: { repo: string; runId: number }) =>
    Effect.gen(function* () {
      const allJobs: GH.WorkflowJob[] = []
      let page = 1
      while (true) {
        const response = yield* apiGet({
          repo,
          path: `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`,
          schema: GH.WorkflowJobsResponse,
          useETag: true,
        })
        allJobs.push(...response.jobs)
        if (allJobs.length >= response.total_count) break
        page++
      }
      return { total_count: allJobs.length, jobs: allJobs } satisfies WorkflowJobsResponse
    }).pipe(withGitHubSpan({ name: 'github-client.listWorkflowJobs', attributes: { repo, runId } }))

  /** Get logs for a specific job (works mid-run for completed jobs). */
  const getJobLogs = ({ repo, jobId }: { repo: string; jobId: number }) =>
    apiGetText({ repo, path: `/repos/${repo}/actions/jobs/${jobId}/logs` }).pipe(
      /**
       * `apiGetText` is job-agnostic and reports `jobId: 0`; stamp the real id
       * here so the placeholder never reaches a caller.
       */
      Effect.mapError((cause) =>
        cause._tag === 'LogsUnavailableError'
          ? new LogsUnavailableError({ message: cause.message, jobId })
          : cause,
      ),
      Effect.filterOrFail(
        (text) => !isAzureBlobError(text),
        () =>
          new LogsUnavailableError({
            message: 'Logs not available (Azure Blob Storage returned an error)',
            jobId,
          }),
      ),
      /** An empty body is never a useful log — report it instead of rendering silence. */
      Effect.filterOrFail(
        (text) => text.trim().length > 0,
        () =>
          new LogsUnavailableError({
            message: 'GitHub returned an empty log body for this job',
            jobId,
          }),
      ),
      withGitHubSpan({ name: 'github-client.getJobLogs', attributes: { repo, jobId } }),
    )

  /**
   * Get check run annotations for a job.
   *
   * Watch loops re-ask for this per job per tick, and the answer is almost
   * always identical, so it is served conditionally: an unchanged annotation
   * set comes back as an unbilled `304`.
   */
  const getCheckAnnotations = ({ repo, checkRunId }: { repo: string; checkRunId: number }) =>
    Effect.gen(function* () {
      const annotations: GH.CheckAnnotation[] = []
      let page = 1
      while (true) {
        const pageAnnotations = yield* apiGet({
          repo,
          path: `/repos/${repo}/check-runs/${checkRunId}/annotations?per_page=100&page=${page}`,
          schema: Schema.Array(GH.CheckAnnotation),
          useETag: true,
        })
        annotations.push(...pageAnnotations)
        if (pageAnnotations.length < 100) return annotations
        page++
      }
    }).pipe(
      withGitHubSpan({
        name: 'github-client.getCheckAnnotations',
        attributes: { repo, checkRunId },
      }),
    )

  /**
   * List enough branch runs to preserve exact `--workflow` matching.
   *
   * Ordinary selection keeps the small first page used for the default preference.
   * Active selection and explicit workflow selection scan later pages until the
   * newest eligible run is found, while retaining the newest eligible fallback.
   */
  const listRunsForBranchSelection = ({
    repo,
    branch,
    event,
    preferWorkflow,
    activeOnly,
  }: {
    repo: string
    branch: string
    event?: 'pull_request'
    preferWorkflow?: string
    activeOnly: boolean
  }) =>
    Effect.gen(function* () {
      const eventQuery = event === undefined ? '' : `&event=${event}`
      if (preferWorkflow === undefined && !activeOnly) {
        const response = yield* apiGet({
          repo,
          path: `/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}${eventQuery}&per_page=25`,
          schema: GH.WorkflowRunsResponse,
        })
        return response.workflow_runs
      }

      let page = 1
      let fallbackRun: GH.WorkflowRun | undefined
      while (true) {
        const response = yield* apiGet({
          repo,
          path: `/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}${eventQuery}&per_page=100&page=${page}`,
          schema: GH.WorkflowRunsResponse,
        })
        const eligibleRuns = activeOnly
          ? response.workflow_runs.filter(isRunActive)
          : response.workflow_runs
        fallbackRun ??= eligibleRuns[0]

        const match =
          preferWorkflow === undefined
            ? eligibleRuns[0]
            : eligibleRuns.find((run) =>
                workflowPathMatches({ candidatePath: run.path, workflow: preferWorkflow }),
              )
        if (match !== undefined) {
          return fallbackRun === undefined || fallbackRun.id === match.id
            ? [match]
            : [fallbackRun, match]
        }
        if (page * 100 >= response.total_count || response.workflow_runs.length === 0) {
          return fallbackRun === undefined ? [] : [fallbackRun]
        }
        page++
      }
    })

  /** Get the latest run for a branch, preferring the requested workflow (or ci.yml by default). */
  const getLatestRunForBranch = ({
    repo,
    branch,
    preferWorkflow,
  }: {
    repo: string
    branch: string
    preferWorkflow?: string
  }) =>
    listRunsForBranchSelection({
      repo,
      branch,
      ...(preferWorkflow !== undefined ? { preferWorkflow } : {}),
      activeOnly: false,
    }).pipe(
      Effect.map(
        (runs) =>
          selectRunForVerdict({
            runs,
            ...(preferWorkflow !== undefined ? { preferWorkflow } : {}),
          }).run,
      ),
      withGitHubSpan({ name: 'github-client.getLatestRunForBranch', attributes: { repo, branch } }),
    )

  /** Get the latest active run for a branch, preferring the requested workflow (or ci.yml by default). */
  const getLatestActiveRunForBranch = ({
    repo,
    branch,
    preferWorkflow,
  }: {
    repo: string
    branch: string
    preferWorkflow?: string
  }) =>
    listRunsForBranchSelection({
      repo,
      branch,
      ...(preferWorkflow !== undefined ? { preferWorkflow } : {}),
      activeOnly: true,
    }).pipe(
      Effect.map(
        (runs) =>
          selectRunForVerdict({
            runs,
            ...(preferWorkflow !== undefined ? { preferWorkflow } : {}),
            activeOnly: true,
          }).run,
      ),
      withGitHubSpan({
        name: 'github-client.getLatestActiveRunForBranch',
        attributes: { repo, branch },
      }),
    )

  /**
   * List enough runs for one commit to preserve exact `--workflow` matching.
   *
   * Without an explicit workflow, the first page is enough for the default
   * preference. An explicit workflow scans later pages until its newest run is
   * found, while retaining the newest run as the existing unmatched fallback.
   */
  const listRunsForHeadSha = ({
    repo,
    headSha,
    preferWorkflow,
  }: {
    repo: string
    headSha: string
    preferWorkflow?: string
  }) =>
    Effect.gen(function* () {
      if (preferWorkflow === undefined) {
        const response = yield* apiGet({
          repo,
          path: `/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100`,
          schema: GH.WorkflowRunsResponse,
        })
        return response.workflow_runs
      }

      let page = 1
      let fallbackRun: GH.WorkflowRun | undefined
      while (true) {
        const response = yield* apiGet({
          repo,
          path: `/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100&page=${page}`,
          schema: GH.WorkflowRunsResponse,
        })
        fallbackRun ??= response.workflow_runs[0]

        const match = response.workflow_runs.find((run) =>
          workflowPathMatches({ candidatePath: run.path, workflow: preferWorkflow }),
        )
        if (match !== undefined) {
          return fallbackRun === undefined || fallbackRun.id === match.id
            ? [match]
            : [fallbackRun, match]
        }
        if (page * 100 >= response.total_count || response.workflow_runs.length === 0) {
          return fallbackRun === undefined ? [] : [fallbackRun]
        }
        page++
      }
    }).pipe(
      withGitHubSpan({ name: 'github-client.listRunsForHeadSha', attributes: { repo, headSha } }),
    )

  /**
   * Get the latest PR run for a branch (pull_request event).
   * When `preferWorkflow` is set, filters to runs from that workflow file.
   * By default, prefers `ci.yml` over other workflows (e.g. `auto-review.yml`).
   */
  const getLatestPRRun = ({
    repo,
    branch,
    preferWorkflow,
  }: {
    repo: string
    branch: string
    preferWorkflow?: string
  }) =>
    listRunsForBranchSelection({
      repo,
      branch,
      event: 'pull_request',
      ...(preferWorkflow !== undefined ? { preferWorkflow } : {}),
      activeOnly: false,
    }).pipe(
      Effect.map(
        (runs) =>
          selectRunForVerdict({
            runs,
            ...(preferWorkflow !== undefined ? { preferWorkflow } : {}),
          }).run,
      ),
      withGitHubSpan({ name: 'github-client.getLatestPRRun', attributes: { repo, branch } }),
    )

  /** Get the latest active PR run for a branch, preferring the requested workflow (or ci.yml by default). */
  const getLatestActivePRRun = ({
    repo,
    branch,
    preferWorkflow,
  }: {
    repo: string
    branch: string
    preferWorkflow?: string
  }) =>
    listRunsForBranchSelection({
      repo,
      branch,
      event: 'pull_request',
      ...(preferWorkflow !== undefined ? { preferWorkflow } : {}),
      activeOnly: true,
    }).pipe(
      Effect.map(
        (runs) =>
          selectRunForVerdict({
            runs,
            ...(preferWorkflow !== undefined ? { preferWorkflow } : {}),
            activeOnly: true,
          }).run,
      ),
      withGitHubSpan({ name: 'github-client.getLatestActivePRRun', attributes: { repo, branch } }),
    )

  /** Make an authenticated GraphQL query. */
  const apiGraphql = <A, I>({
    repo,
    query,
    variables,
    schema,
  }: {
    repo: string
    query: string
    variables: Record<string, unknown>
    schema: Schema.Codec<A, I>
  }) =>
    Effect.gen(function* () {
      yield* awaitBudget('graphql')
      const token = yield* getTokenForRepo(repo)

      const response = yield* httpClient
        .execute(
          HttpClientRequest.post(GITHUB_GRAPHQL_URL).pipe(
            HttpClientRequest.setHeaders({
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            }),
            HttpClientRequest.bodyJsonUnsafe({ query, variables }),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) => new GitHubApiError({ message: 'GitHub GraphQL request failed', cause }),
          ),
        )

      yield* Ref.update(requestCountRef, (n) => n + 1)
      yield* Ref.update(graphqlRequestCountRef, (n) => n + 1)
      yield* trackRateLimit({ headers: response.headers, bucket: 'graphql' })

      const json = yield* response.json.pipe(
        Effect.mapError(
          (cause) =>
            new GitHubApiError({ message: 'Failed to parse GraphQL JSON response', cause }),
        ),
      )

      const body = json as { data?: unknown; errors?: Array<{ message: string }> }
      if (body.errors && body.errors.length > 0) {
        return yield* new GitHubApiError({
          message: `GraphQL errors: ${body.errors.map((e) => e.message).join(', ')}`,
          cause: body.errors,
        })
      }

      return yield* Schema.decodeUnknownEffect(schema)(body.data).pipe(
        Effect.mapError(
          (cause) =>
            new GitHubApiError({ message: 'GraphQL response schema decode failed', cause }),
        ),
      )
    }).pipe(Effect.scoped)

  const PR_HEALTH_QUERY = `
      query($owner: String!, $repo: String!, $number: Int!, $headRef: String!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            mergeable
            baseRefName
            baseRef {
              compare(headRef: $headRef) { behindBy }
            }
          }
        }
      }
    `

  const PrHealthResponse = Schema.Struct({
    repository: Schema.Struct({
      pullRequest: Schema.Struct({
        mergeable: Schema.Literals(['CONFLICTING', 'MERGEABLE', 'UNKNOWN']),
        baseRefName: Schema.String,
        baseRef: Schema.NullOr(
          Schema.Struct({
            compare: Schema.Struct({ behindBy: Schema.Finite }),
          }),
        ),
      }),
    }),
  })

  /** Fetch PR health (merge conflicts + behind count) via GraphQL. */
  const getPrHealth = ({
    repo,
    prNumber,
    headRef,
  }: {
    repo: string
    prNumber: number
    headRef: string
  }) => {
    const [owner, repoName] = repo.split('/')
    return apiGraphql({
      repo,
      query: PR_HEALTH_QUERY,
      variables: { owner, repo: repoName, number: prNumber, headRef },
      schema: PrHealthResponse,
    }).pipe(
      Effect.map((data): PrHealth => {
        const pr = data.repository.pullRequest
        return {
          prNumber,
          mergeable: pr.mergeable,
          behindBy: pr.baseRef?.compare.behindBy ?? 0,
          baseRefName: pr.baseRefName,
        }
      }),
      withGitHubSpan({ name: 'github-client.getPrHealth', attributes: { repo, prNumber } }),
    )
  }

  /** Get a pull request's head ref and head commit — the commit a verdict must describe. */
  const getPullRequest = ({ repo, prNumber }: { repo: string; prNumber: number }) =>
    apiGet({ repo, path: `/repos/${repo}/pulls/${prNumber}`, schema: GH.PullRequest }).pipe(
      Effect.map((pr) => ({
        number: pr.number,
        head_branch: pr.head.ref,
        head_sha: pr.head.sha,
      })),
      withGitHubSpan({ name: 'github-client.getPullRequest', attributes: { repo, prNumber } }),
    )

  const WorkflowList = Schema.Struct({
    total_count: Schema.Finite,
    workflows: Schema.Array(
      Schema.Struct({
        id: Schema.Finite,
        name: Schema.String,
        path: Schema.String,
      }),
    ),
  })

  const WorkflowDispatchResponse = Schema.Struct({
    workflow_run_id: Schema.Finite,
    run_url: Schema.String,
    html_url: Schema.String,
  })

  /**
   * Dispatch a workflow through the same authenticated REST boundary as every
   * other mutation. Resolving display names here preserves `gh workflow run`
   * compatibility while keeping App installation tokens out of subprocesses.
   */
  const dispatchWorkflow = ({
    repo,
    workflow,
    ref,
  }: {
    repo: string
    workflow: string
    ref: string
  }) =>
    Effect.gen(function* () {
      let page = 1
      while (true) {
        const listed = yield* apiGet({
          repo,
          path: `/repos/${repo}/actions/workflows?per_page=100&page=${page}`,
          schema: WorkflowList,
        })
        const match = listed.workflows.find(
          (candidate) =>
            candidate.name === workflow ||
            workflowPathMatches({ candidatePath: candidate.path, workflow }),
        )
        if (match !== undefined) {
          return yield* apiPostJson({
            repo,
            path: `/repos/${repo}/actions/workflows/${match.id}/dispatches`,
            body: { ref, return_run_details: true },
            schema: WorkflowDispatchResponse,
          })
        }
        if (page * 100 >= listed.total_count || listed.workflows.length === 0) {
          return yield* new GitHubApiError({
            message: `Could not find workflow '${workflow}' in ${repo}`,
            cause: 'workflow not found',
          })
        }
        page++
      }
    }).pipe(
      withGitHubSpan({
        name: 'github-client.dispatchWorkflow',
        attributes: { repo, workflow, ref },
      }),
    )

  /** Re-run an entire workflow. */
  const rerunWorkflow = ({ repo, runId }: { repo: string; runId: number }) =>
    apiPost({ repo, path: `/repos/${repo}/actions/runs/${runId}/rerun` }).pipe(
      withGitHubSpan({ name: 'github-client.rerunWorkflow', attributes: { repo, runId } }),
    )

  /** Re-run only failed jobs in a workflow. */
  const rerunFailedJobs = ({ repo, runId }: { repo: string; runId: number }) =>
    apiPost({ repo, path: `/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs` }).pipe(
      withGitHubSpan({ name: 'github-client.rerunFailedJobs', attributes: { repo, runId } }),
    )

  /** Request graceful cancellation of a workflow run. */
  const cancelRun = ({ repo, runId }: { repo: string; runId: number }) =>
    apiPost({ repo, path: `/repos/${repo}/actions/runs/${runId}/cancel` }).pipe(
      withGitHubSpan({ name: 'github-client.cancelRun', attributes: { repo, runId } }),
    )

  /** Get the default branch name for a repository. */
  const getDefaultBranch = (repo: string) =>
    apiGet({ repo, path: `/repos/${repo}`, schema: GH.RepoResponse }).pipe(
      Effect.map((r) => r.default_branch),
      withGitHubSpan({ name: 'github-client.getDefaultBranch', attributes: { repo } }),
    )

  const getRateLimit = Ref.get(rateLimitRef)
  const getRequestCount = Ref.get(requestCountRef)
  /**
   * Requests issued against the REST bucket, `304`s included.
   *
   * Pacing prices a tick against the REST budget, so GraphQL requests — a
   * separate bucket with its own reset — must not be charged to it.
   */
  const getRestRequestCount = Effect.gen(function* () {
    const total = yield* Ref.get(requestCountRef)
    const graphql = yield* Ref.get(graphqlRequestCountRef)
    return total - graphql
  })
  const getCachedResponseCount = Ref.get(cachedResponseCountRef)

  return {
    listActiveRuns,
    listWorkflowRunsByStatus,
    getWorkflowRun,
    getWorkflowJob,
    listWorkflowJobs,
    getJobLogs,
    getCheckAnnotations,
    getLatestRunForBranch,
    getLatestActiveRunForBranch,
    listRunsForHeadSha,
    getLatestPRRun,
    getLatestActivePRRun,
    getPullRequest,
    getPrHealth,
    getDefaultBranch,
    dispatchWorkflow,
    rerunWorkflow,
    rerunFailedJobs,
    cancelRun,
    getRateLimit,
    getRequestCount,
    getRestRequestCount,
    getCachedResponseCount,
  } as const
})

/** Runtime shape of the GitHub CI client. */
export type GitHubClientShape = Effect.Success<typeof makeGitHubClient>
/** Context service providing authenticated GitHub CI operations. */
export class GitHubClient extends Context.Service<GitHubClient, GitHubClientShape>()(
  'gh-ci-utils/GitHubClient',
) {
  static readonly Default = Layer.effect(GitHubClient, makeGitHubClient)
}
