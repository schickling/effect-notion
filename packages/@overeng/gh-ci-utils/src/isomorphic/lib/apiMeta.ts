import { Schema } from 'effect'

/** Schema for API request metadata and rate-limit info */
export const ApiMetaSchema = Schema.Struct({
  apiRequests: Schema.Finite,
  /** Subset of `apiRequests` answered `304 Not Modified`, which GitHub does not bill. */
  apiRequestsCached: Schema.Finite,
  rateLimitRemaining: Schema.Finite,
  rateLimitLimit: Schema.Finite,
}).annotate({ identifier: 'ApiMeta' })

export type ApiMeta = typeof ApiMetaSchema.Type

/** Default empty API metadata */
export const defaultApiMeta: ApiMeta = {
  apiRequests: 0,
  apiRequestsCached: 0,
  rateLimitRemaining: 0,
  rateLimitLimit: 0,
}
