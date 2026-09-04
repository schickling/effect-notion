/**
 * Effect service tags for Playwright fixtures.
 *
 * @module
 */

import type { BrowserContext, Page } from '@playwright/test'
import { Context, Layer } from 'effect'

/**
 * Effect service tag for the current Playwright `page`.
 *
 * Provide this in Playwright tests to avoid threading `page` through every helper call.
 */
export class PwPage extends Context.Service<PwPage, Page>()('PwPage') {
  static layer = (page: Page) => Layer.succeed(PwPage, page)
}

/**
 * Effect service tag for the current Playwright `context`.
 *
 * Provide this in Playwright tests to avoid threading `context` through every helper call.
 */
export class PwBrowserContext extends Context.Service<PwBrowserContext, BrowserContext>()(
  'PwBrowserContext',
) {
  static layer = (context: BrowserContext) => Layer.succeed(PwBrowserContext, context)
}

/**
 * Convenience helper to provide both `PwPage` and `PwBrowserContext`.
 *
 * Tests can still provide the layers individually if desired.
 */
export const makeTestLayers = ({
  page,
  context,
}: {
  /** Playwright page for the current test. */
  page: Page
  /** Playwright browser context for the current test. */
  context: BrowserContext
}) => Layer.mergeAll(PwPage.layer(page), PwBrowserContext.layer(context))
