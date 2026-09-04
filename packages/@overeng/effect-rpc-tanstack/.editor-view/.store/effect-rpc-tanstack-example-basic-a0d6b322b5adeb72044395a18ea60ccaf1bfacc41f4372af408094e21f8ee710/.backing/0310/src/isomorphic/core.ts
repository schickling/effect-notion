// ============================================================================
// Environment Detection
// ============================================================================

/** Detects non-production environments when running in Node-like runtimes. */
export const isDevEnv = (): boolean => {
  if (globalThis.process === undefined) {
    return false
  }

  if (globalThis.process.env === undefined) {
    return false
  }

  return globalThis.process.env.NODE_ENV !== 'production'
}

// ============================================================================
// Defensive Programming
// ============================================================================

/** Throws a clear error for impossible states while offering a breakpoint in dev */
export const shouldNeverHappen = (msg?: string, ...args: any[]): never => {
  console.error(msg, ...args)
  if (isDevEnv() === true) {
    // oxlint-disable-next-line no-debugger -- intentional breakpoint for impossible states during development
    debugger
  }

  throw new Error(`This should never happen: ${msg}`)
}
