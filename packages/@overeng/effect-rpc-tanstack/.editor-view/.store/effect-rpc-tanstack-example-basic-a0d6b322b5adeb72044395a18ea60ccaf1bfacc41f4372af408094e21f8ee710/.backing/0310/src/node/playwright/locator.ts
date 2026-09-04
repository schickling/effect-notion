/**
 * Effect wrappers for Playwright Locator methods.
 *
 * @module
 */

import type { Locator, Page } from '@playwright/test'
import { Effect } from 'effect'

import { OtelSpan } from '@overeng/otel-contract'

import { type PwOpError, tryPw } from './op.ts'
// PwLocatorAttrs (annotate-only encoder) is DERIVED from the registered seam contract.
import { PwLocatorAttrs } from './pw.contract.ts'
import { PwPage } from './tags.ts'

const annotateLocator = (
  value: Partial<{
    timeoutMs: number
    valueLen: number
    textLen: number
    delayMs: number
    jitterMs: number
    key: string
    selector: string
    role: string
    name: string
    testId: string
    text: string
    label: string
    placeholder: string
  }>,
) => OtelSpan.annotate({ attributes: PwLocatorAttrs, value }).pipe(Effect.orDie)

const textLabel = (text: string | RegExp) => (typeof text === 'string' ? text : text.source)

/** Waits for the locator to become visible. */
export const waitForVisible: (args: {
  /** Locator to wait on. */
  locator: Locator
  /** Optional timeout in milliseconds. */
  timeoutMs?: number
}) => Effect.Effect<void, PwOpError> = Effect.fn('pw.locator.waitForVisible')(
  ({ locator, timeoutMs }) =>
    tryPw({
      op: 'pw.locator.waitForVisible',
      effect: () =>
        locator.waitFor({
          state: 'visible',
          ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
        }),
    }).pipe(Effect.tap(() => annotateLocator({ timeoutMs: timeoutMs ?? 0 }))),
)

/** Clicks the locator. Prefer a11y-first interactions when available. */
export const click: (args: {
  /** Locator to click. */
  locator: Locator
}) => Effect.Effect<void, PwOpError> = Effect.fn('pw.locator.click')(({ locator }) =>
  tryPw({ op: 'pw.locator.click', effect: () => locator.click() }).pipe(Effect.asVoid),
)

/** Fills the locator with the given value. */
export const fill: (args: {
  /** Locator to fill. */
  locator: Locator
  /** Value to write into the input. */
  value: string
}) => Effect.Effect<void, PwOpError> = Effect.fn('pw.locator.fill')(({ locator, value }) =>
  tryPw({ op: 'pw.locator.fill', effect: () => locator.fill(value) }).pipe(
    Effect.tap(() => annotateLocator({ valueLen: value.length })),
    Effect.asVoid,
  ),
)

/** Types text into the locator, optionally with a per-key delay. */
export const type: (args: {
  /** Locator to type into. */
  locator: Locator
  /** Text to type. */
  text: string
  /** Optional per-key delay in milliseconds. */
  delayMs?: number
}) => Effect.Effect<void, PwOpError> = Effect.fn('pw.locator.type')(({ locator, text, delayMs }) =>
  tryPw({
    op: 'pw.locator.type',
    effect: () =>
      locator.pressSequentially(text, delayMs !== undefined ? { delay: delayMs } : undefined),
  }).pipe(
    Effect.tap(() => annotateLocator({ textLen: text.length, delayMs: delayMs ?? 0 })),
    Effect.asVoid,
  ),
)

/** Focuses the locator. */
export const focus: (args: {
  /** Locator to focus. */
  locator: Locator
}) => Effect.Effect<void, PwOpError> = Effect.fn('pw.locator.focus')(({ locator }) =>
  tryPw({ op: 'pw.locator.focus', effect: () => locator.focus() }).pipe(Effect.asVoid),
)

/** Presses a keyboard key on the locator. */
export const press: (args: {
  /** Locator to dispatch the key press to. */
  locator: Locator
  /** Key to press (Playwright `key` string). */
  key: string
}) => Effect.Effect<void, PwOpError> = Effect.fn('pw.locator.press')(({ locator, key }) =>
  tryPw({ op: 'pw.locator.press', effect: () => locator.press(key) }).pipe(
    Effect.tap(() => annotateLocator({ key })),
    Effect.asVoid,
  ),
)

/** Scrolls the locator into view, if needed. */
export const scrollIntoViewIfNeeded: (args: {
  /** Locator to scroll into view. */
  locator: Locator
}) => Effect.Effect<void, PwOpError> = Effect.fn('pw.locator.scrollIntoViewIfNeeded')(
  ({ locator }) =>
    tryPw({
      op: 'pw.locator.scrollIntoViewIfNeeded',
      effect: () => locator.scrollIntoViewIfNeeded(),
    }).pipe(Effect.asVoid),
)

/** Returns whether the checkbox-like locator is currently checked. */
export const isChecked: (args: {
  /** Checkbox-like locator to query. */
  locator: Locator
}) => Effect.Effect<boolean, PwOpError> = Effect.fn('pw.locator.isChecked')(({ locator }) =>
  tryPw({ op: 'pw.locator.isChecked', effect: () => locator.isChecked() }),
)

/**
 * Types into an input in a more human-like way (jitter + per-key delay).
 *
 * Useful for anti-bot flows where very fast interactions can be flagged.
 */
export const typeHuman: (args: {
  /** Locator to type into. */
  locator: Locator
  /** Text to type. */
  text: string
  /** Min per-key delay in milliseconds. */
  delayMsMin?: number
  /** Max per-key delay in milliseconds. */
  delayMsMax?: number
  /** Min jitter before typing in milliseconds. */
  jitterMsMin?: number
  /** Max jitter before typing in milliseconds. */
  jitterMsMax?: number
}) => Effect.Effect<void, PwOpError> = Effect.fn('pw.locator.typeHuman')(
  ({ locator, text, delayMsMin = 50, delayMsMax = 50, jitterMsMin = 250, jitterMsMax = 250 }) =>
    Effect.gen(function* () {
      const delay = Math.floor(Math.random() * (delayMsMax - delayMsMin + 1)) + delayMsMin
      const jitter = Math.floor(Math.random() * (jitterMsMax - jitterMsMin + 1)) + jitterMsMin

      yield* annotateLocator({ textLen: text.length, delayMs: delay, jitterMs: jitter })

      yield* click({ locator })
      yield* tryPw({
        op: 'pw.page.waitForTimeout',
        effect: () => locator.page().waitForTimeout(jitter),
      }).pipe(Effect.tap(() => annotateLocator({ jitterMs: jitter })))
      yield* fill({ locator, value: '' })
      yield* type({ locator, text, delayMs: delay })
    }),
)

/** Returns whether the locator is visible. */
export const isVisible: (args: {
  /** Locator to query. */
  locator: Locator
}) => Effect.Effect<boolean, PwOpError> = Effect.fn('pw.locator.isVisible')(({ locator }) =>
  tryPw({ op: 'pw.locator.isVisible', effect: () => locator.isVisible() }),
)

/** Returns whether the locator is enabled. */
export const isEnabled: (args: {
  /** Locator to query. */
  locator: Locator
}) => Effect.Effect<boolean, PwOpError> = Effect.fn('pw.locator.isEnabled')(({ locator }) =>
  tryPw({ op: 'pw.locator.isEnabled', effect: () => locator.isEnabled() }),
)

/** Returns the inner text of the locator. */
export const innerText: (args: {
  /** Locator to query. */
  locator: Locator
}) => Effect.Effect<string, PwOpError> = Effect.fn('pw.locator.innerText')(({ locator }) =>
  tryPw({ op: 'pw.locator.innerText', effect: () => locator.innerText() }),
)

/** Returns the text content of the locator. */
export const textContent: (args: {
  /** Locator to query. */
  locator: Locator
}) => Effect.Effect<string | null, PwOpError> = Effect.fn('pw.locator.textContent')(({ locator }) =>
  tryPw({ op: 'pw.locator.textContent', effect: () => locator.textContent() }),
)

/** Returns a locator for the given selector. Synchronous, no network call. */
export const locator: (
  /** CSS or Playwright selector. */
  selector: string,
) => Effect.Effect<Locator, never, PwPage> = Effect.fn('pw.locator')((selector) =>
  Effect.gen(function* () {
    const page = yield* PwPage
    yield* annotateLocator({ selector })
    return page.locator(selector)
  }),
)

/** Returns a locator by role. Synchronous, no network call. */
export const getByRole: (opts: {
  /** ARIA role (e.g. 'button', 'link', 'heading'). */
  role: Parameters<Page['getByRole']>[0]
  /** Optional role options (e.g. name, exact). */
  options?: Parameters<Page['getByRole']>[1]
}) => Effect.Effect<Locator, never, PwPage> = Effect.fn('pw.getByRole')((opts) =>
  Effect.gen(function* () {
    const page = yield* PwPage
    yield* annotateLocator({ role: String(opts.role), name: textLabel(opts.options?.name ?? '') })
    return page.getByRole(opts.role, opts.options)
  }),
)

/** Returns a locator by test id. Synchronous, no network call. */
export const getByTestId: (
  /** Test ID value. */
  testId: string,
) => Effect.Effect<Locator, never, PwPage> = Effect.fn('pw.getByTestId')((testId) =>
  Effect.gen(function* () {
    const page = yield* PwPage
    yield* annotateLocator({ testId })
    return page.getByTestId(testId)
  }),
)

/** Returns a locator by text. Synchronous, no network call. */
export const getByText: (opts: {
  /** Text to match. */
  text: string | RegExp
  /** Optional text options (e.g. exact). */
  options?: Parameters<Page['getByText']>[1]
}) => Effect.Effect<Locator, never, PwPage> = Effect.fn('pw.getByText')((opts) =>
  Effect.gen(function* () {
    const page = yield* PwPage
    yield* annotateLocator({ text: textLabel(opts.text) })
    return page.getByText(opts.text, opts.options)
  }),
)

/** Returns a locator by label text. Synchronous, no network call. */
export const getByLabel: (opts: {
  /** Label text to match. */
  text: string | RegExp
  /** Optional text options (e.g. exact). */
  options?: Parameters<Page['getByLabel']>[1]
}) => Effect.Effect<Locator, never, PwPage> = Effect.fn('pw.getByLabel')((opts) =>
  Effect.gen(function* () {
    const page = yield* PwPage
    yield* annotateLocator({ label: textLabel(opts.text) })
    return page.getByLabel(opts.text, opts.options)
  }),
)

/** Returns a locator by placeholder text. Synchronous, no network call. */
export const getByPlaceholder: (opts: {
  /** Placeholder text to match. */
  text: string | RegExp
  /** Optional text options (e.g. exact). */
  options?: Parameters<Page['getByPlaceholder']>[1]
}) => Effect.Effect<Locator, never, PwPage> = Effect.fn('pw.getByPlaceholder')((opts) =>
  Effect.gen(function* () {
    const page = yield* PwPage
    yield* annotateLocator({ placeholder: textLabel(opts.text) })
    return page.getByPlaceholder(opts.text, opts.options)
  }),
)
