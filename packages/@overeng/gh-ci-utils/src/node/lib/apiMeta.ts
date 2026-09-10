import { Effect, Option } from 'effect'

import { type ApiMeta } from '../../isomorphic/lib/apiMeta.ts'
import { GitHubClient } from '../GitHubClient.ts'

/** Collect API metadata from a GitHub response */
export const collectApiMeta = Effect.gen(function* () {
  const github = yield* GitHubClient
  const requestCount = yield* github.getRequestCount
  const cachedCount = yield* github.getCachedResponseCount
  const rateLimit = yield* github.getRateLimit
  return {
    apiRequests: requestCount,
    apiRequestsCached: cachedCount,
    rateLimitRemaining: Option.isSome(rateLimit) ? rateLimit.value.remaining : 0,
    rateLimitLimit: Option.isSome(rateLimit) ? rateLimit.value.limit : 0,
  } satisfies ApiMeta
})
