/**
 * Namespaced block key derived from a business identifier.
 *
 * Use this at call sites where multiple renderers might share a cache file
 * and you want to avoid collisions with unrelated keys.
 */
export const blockKey = (business: string): string => `b:${business}`

/**
 * Encoder for the node keys the reconciler assigns to candidate/cache tree
 * entries. `buildCandidateTree` derives every node's `key` through exactly
 * these two constructors, and `candidateToCache` persists them verbatim, so
 * consumers that need to address a cache entry (e.g. to seed or inspect a
 * cache out-of-band) MUST go through this encoder rather than hand-rolling
 * the `k:`/`p:` prefixes.
 */
export const NodeKey = {
  /** Key for an element that carries an explicit `blockKey` prop. */
  keyed: (key: string): string => `k:${key}`,
  /** Positional fallback key for an element without a `blockKey`, by sibling index. */
  positional: (index: number): string => `p:${index}`,
}
