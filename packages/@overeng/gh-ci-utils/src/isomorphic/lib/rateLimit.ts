/** Parsed GitHub API rate-limit headers */
export interface RateLimitInfo {
  readonly remaining: number
  readonly limit: number
  readonly reset: Date
}

/** Extract rate-limit info from GitHub response headers; malformed headers count as absent. */
export const parseRateLimitHeaders = (
  headers: Record<string, string | undefined>,
): RateLimitInfo | undefined => {
  const remaining = Number(headers['x-ratelimit-remaining'])
  const limit = Number(headers['x-ratelimit-limit'])
  const reset = Number(headers['x-ratelimit-reset'])
  if (!Number.isFinite(remaining) || !Number.isFinite(limit) || !Number.isFinite(reset)) {
    return undefined
  }
  return { remaining, limit, reset: new Date(reset * 1000) }
}
