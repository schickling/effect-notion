/**
 * Effect wrappers for Playwright BrowserContext methods.
 *
 * @module
 */

import type { Cookie } from '@playwright/test'
import { Effect } from 'effect'

import { OtelSpan } from '@overeng/otel-contract'

import { type PwOpError, tryPw } from './op.ts'
// PwContextAttrs (annotate-only encoder) is DERIVED from the registered seam contract.
import { PwContextAttrs } from './pw.contract.ts'
import { PwBrowserContext } from './tags.ts'

const annotateContext = (
  value: Partial<{
    cookieCount: number
    cookiesUrl: string
    storageStatePath: string
  }>,
) => OtelSpan.annotate({ attributes: PwContextAttrs, value }).pipe(Effect.orDie)

/**
 * Reads cookies from the current browser context.
 *
 * The context is provided via `PwBrowserContext`.
 */
export const cookies: (args: {
  /** Optional URL(s) to scope the cookie query (Playwright `context.cookies(url)` behavior). */
  url?: string | string[]
}) => Effect.Effect<ReadonlyArray<Cookie>, PwOpError, PwBrowserContext> = Effect.fn(
  'pw.context.cookies',
)(({ url }) =>
  Effect.gen(function* () {
    const context = yield* PwBrowserContext
    return yield* tryPw({
      op: 'pw.context.cookies',
      effect: () => (url !== undefined ? context.cookies(url) : context.cookies()),
    }).pipe(
      Effect.tap((cs) =>
        annotateContext({
          cookieCount: cs.length,
          cookiesUrl:
            url !== undefined ? (Array.isArray(url) === true ? url.join(' | ') : url) : '',
        }),
      ),
    )
  }),
)

/**
 * Persists the current browser context storage state to disk.
 *
 * The context is provided via `PwBrowserContext`.
 */
export const storageState: (args: {
  /** File path where Playwright should write `storageState` JSON. */
  path: string
}) => Effect.Effect<void, PwOpError, PwBrowserContext> = Effect.fn('pw.context.storageState')(
  ({ path }) =>
    Effect.gen(function* () {
      const context = yield* PwBrowserContext
      yield* tryPw({
        op: 'pw.context.storageState',
        effect: () => context.storageState({ path }).then(() => undefined),
      }).pipe(Effect.tap(() => annotateContext({ storageStatePath: path })))
    }),
)

/**
 * Adds cookies to the browser context.
 */
export const addCookies: (args: {
  /** Cookies to add. */
  cookies: Cookie[]
}) => Effect.Effect<void, PwOpError, PwBrowserContext> = Effect.fn('pw.context.addCookies')(
  ({ cookies: cookiesToAdd }) =>
    Effect.gen(function* () {
      const context = yield* PwBrowserContext
      yield* tryPw({
        op: 'pw.context.addCookies',
        effect: () => context.addCookies(cookiesToAdd),
      }).pipe(Effect.tap(() => annotateContext({ cookieCount: cookiesToAdd.length })))
    }),
)

/**
 * Clears cookies from the browser context.
 */
export const clearCookies: Effect.Effect<void, PwOpError, PwBrowserContext> = Effect.gen(
  function* () {
    const context = yield* PwBrowserContext
    yield* tryPw({
      // tryPw emits the `pw.context.clearCookies` operation span itself.
      op: 'pw.context.clearCookies',
      effect: () => context.clearCookies(),
    })
  },
)
