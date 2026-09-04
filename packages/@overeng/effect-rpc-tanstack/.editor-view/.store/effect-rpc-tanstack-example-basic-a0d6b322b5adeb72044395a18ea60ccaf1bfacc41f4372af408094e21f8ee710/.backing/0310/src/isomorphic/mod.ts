/** Schema annotations for tracking data lineage (authority, freshness, references) */
export * as Lineage from './lineage/mod.ts'

/** Debug utilities for tracing scope and finalizer lifecycle */
export * from './ScopeDebugger.ts'

import { Schema } from 'effect'

// ============================================================================
// Error Types
// ============================================================================

/**
 * Generic error class for wrapping unknown error causes.
 * Useful when catching errors of unknown type and wrapping them in a typed Effect error.
 */
export class UnknownError extends Schema.TaggedError<UnknownError>()('UnknownError', {
  cause: Schema.Unknown,
  payload: Schema.optional(Schema.Unknown),
}) {}

// ============================================================================
// Type Guards
// ============================================================================

/** Type guard for filtering out undefined values. */
export const isNotUndefined = <T>(value: T | undefined): value is T => value !== undefined

/** Type guard for checking if a value is undefined. */
export const isUndefined = <T>(value: T | undefined): value is undefined => value === undefined

/** Type guard for filtering out null values. */
export const isNotNull = <T>(value: T | null): value is T => value !== null

/** Type guard for checking if a value is null or undefined (nil) */
export const isNil = (value: any): value is null | undefined =>
  value === null || value === undefined

/** Type guard for filtering out null and undefined values. */
export const isNotNil = <T>(value: T | null | undefined): value is T =>
  value !== null && value !== undefined

// ============================================================================
// Re-exports from core module (environment detection, defensive programming)
// ============================================================================

export { isDevEnv, shouldNeverHappen } from './core.ts'

// ============================================================================
// Re-exports from utility modules
// ============================================================================

export * from './misc.ts'
export * from './timestamp.ts'
export * from './time.ts'
export * from './humanized-date.ts'
export * from './binary.ts'
export * from './hash.ts'
export * from './get-env.ts'
export * from './object/mod.ts'
export * from './single-item.ts'
export * from './string.ts'
export * from './types/mod.ts'
