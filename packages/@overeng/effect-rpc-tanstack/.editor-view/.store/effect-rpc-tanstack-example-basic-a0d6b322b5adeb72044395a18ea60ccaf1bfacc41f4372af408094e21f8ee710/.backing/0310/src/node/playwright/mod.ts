/**
 * Effect-native Playwright helpers.
 *
 * This module provides Effect wrappers for Playwright operations with:
 * - Structured errors via `PwOpError`
 * - OTEL spans for all operations
 * - Service tags (`PwPage`, `PwBrowserContext`) for dependency injection
 * - Test context helpers (`withTestCtx`) for automatic layer provision
 *
 * @example Basic usage
 * ```typescript
 * import { test } from '@playwright/test'
 * import { Pw } from '@overeng/utils/node/playwright'
 * import { Effect } from 'effect'
 *
 * test('basic navigation', ({ page, context }) =>
 *   Pw.withTestCtx({ page, context })(
 *     Effect.gen(function* () {
 *       yield* Pw.Page.goto({ url: 'https://example.com' })
 *       const title = yield* Pw.Page.evaluate(() => document.title)
 *       yield* Pw.expect('title-present', expect(title).toBeTruthy())
 *     })
 *   )
 * )
 * ```
 *
 * @example Using locators
 * ```typescript
 * test('form interaction', ({ page, context }) =>
 *   Pw.withTestCtx({ page, context })(
 *     Effect.gen(function* () {
 *       const input = yield* Pw.Locator.getByLabel('Email')
 *       yield* Pw.Locator.typeHuman({ locator: input, text: 'test@example.com' })
 *
 *       const submit = yield* Pw.Locator.getByRole('button', { name: 'Submit' })
 *       yield* Pw.Locator.click({ locator: submit })
 *     })
 *   )
 * )
 * ```
 *
 * @example With Playwright steps
 * ```typescript
 * test('multi-step flow', ({ page, context }) =>
 *   Pw.withTestCtx({ page, context })(
 *     Effect.gen(function* () {
 *       yield* loginEffect.pipe(Pw.Step.step('Login'))
 *       yield* searchEffect.pipe(Pw.Step.step('Search'))
 *       yield* checkoutEffect.pipe(Pw.Step.step('Checkout'))
 *     })
 *   )
 * )
 * ```
 *
 * @module
 */

/** Browser context operations (cookies, storage, etc). */
export * as Context from './context.ts'
/** Locator-based element interactions (click, fill, type, etc). */
export * as Locator from './locator.ts'
export { expect_ as expect, PwOpError, try_ as try, tryPw } from './op.ts'
/** OpenTelemetry integration for cross-process trace propagation. */
export * as Otel from './otel.ts'
/** Page-level operations (goto, evaluate, screenshot, etc). */
export * as Page from './page.ts'
/** Playwright test step wrappers for Effect spans. */
export * as Step from './step.ts'
export { makeTestLayers, PwBrowserContext, PwPage } from './tags.ts'
export {
  loadEnvConfig,
  makeWithTestCtx,
  type PlaywrightFixtures,
  TestEnvConfigLive,
  type WithTestCtxParams,
  withTestCtx,
} from './test.ts'
/** Wait/polling utilities with configurable timeouts. */
export * as Wait from './wait.ts'
export { PwWaitTimeoutError } from './wait.ts'
/** Playwright config factory for browser integration tests. */
export {
  createPlaywrightConfig,
  type PlaywrightConfigOptions,
  type WebServerConfig,
} from './config/mod.ts'
