/**
 * Playwright config factory for browser integration tests.
 *
 * Important: This module intentionally avoids importing `@playwright/test`
 * at runtime to prevent Playwright's duplicate-load guard from triggering in
 * nested dev shells. Keep this file free of runtime Playwright imports.
 *
 * Context: https://gist.github.com/schickling/c6484f40be38b250fab23e677461a3e2
 *
 * @module
 */

import type { PlaywrightTestConfig } from '@playwright/test'
export type { PlaywrightTestConfig }

import { shouldNeverHappen } from '../../../isomorphic/core.ts'
import { freePort } from '../../net.ts'
/** Web server configuration for Vite. */
export interface WebServerConfig {
  /** Command to start the dev server (use `{{port}}` placeholder) */
  command: string
  /** Working directory for the command */
  cwd?: string
  /** Additional environment variables for the web server process. */
  env?: Readonly<Record<string, string>>
  /** Timeout for server startup in ms (default: 30_000) */
  timeout?: number
  /**
   * Environment variable name to read/write the port.
   * This ensures port stability across multiple config evaluations.
   * On first evaluation, finds an available port and stores it in this env var.
   * On subsequent evaluations, reads from the env var (same port).
   * Default: `PW_TEST_PORT`
   */
  portEnvVar?: string
}

/** Options for creating a Playwright test configuration. */
export interface PlaywrightConfigOptions {
  /** Test directory (e.g. './src/browser/__tests__') */
  testDir: string

  /** Test file pattern (default: `**\/*.pw.test.ts`) */
  testMatch?: string | string[]

  /** Patterns to ignore (merged with default ignores: dist, node_modules) */
  testIgnore?: string | string[]

  /** Override Playwright projects (e.g. to isolate suites). */
  projects?: PlaywrightTestConfig['projects']

  /** Web server config for Vite dev server */
  webServer: WebServerConfig

  /** Timeout for each test in ms (default: 60_000) */
  timeout?: number

  /** Number of workers (default: 1) */
  workers?: number
}

/**
 * Create a Playwright config for browser integration tests.
 *
 * @example
 * ```typescript
 * // playwright.config.ts
 * import { createPlaywrightConfig } from '@overeng/utils/node/playwright'
 *
 * export default createPlaywrightConfig({
 *   testDir: './src/browser/__tests__',
 *   webServer: {
 *     command: 'pnpm exec vite --config src/browser/__tests__/vite.config.ts --port {{port}}',
 *   },
 * })
 * ```
 */
export const createPlaywrightConfig = async (
  options: PlaywrightConfigOptions,
): Promise<PlaywrightTestConfig> => {
  const {
    testDir,
    testMatch = '**/*.pw.test.ts',
    testIgnore: extraIgnore,
    timeout = 60_000,
    workers = 1,
    projects,
    webServer: webServerConfig,
  } = options

  const defaultIgnore = ['**/dist/**', '**/node_modules/**']
  const testIgnore =
    extraIgnore !== undefined
      ? [...defaultIgnore, ...(Array.isArray(extraIgnore) === true ? extraIgnore : [extraIgnore])]
      : defaultIgnore

  const {
    command,
    cwd,
    env,
    timeout: serverTimeout = 30_000,
    portEnvVar = 'PW_TEST_PORT',
  } = webServerConfig

  // Resolve port: read from env var if set, otherwise find available port and store it
  const envPort = process.env[portEnvVar]
  const port = envPort !== undefined ? Number.parseInt(envPort, 10) : await freePort()

  if (Number.isFinite(port) === false) {
    return shouldNeverHappen(
      `Failed to resolve port for Playwright webServer (portEnvVar: ${portEnvVar})`,
    )
  }

  // Store port in env var for subsequent config evaluations
  if (envPort === undefined) {
    process.env[portEnvVar] = String(port)
  }

  const url = `http://127.0.0.1:${port}`
  const resolvedCommand = command.replace(/\{\{port\}\}/g, String(port))

  return {
    testDir,
    testMatch,
    testIgnore,
    reporter: process.env.CI !== undefined ? 'line' : 'list',

    timeout,
    ...(process.env.CI !== undefined ? { maxFailures: 1 } : {}),
    workers,
    fullyParallel: false,

    ...(projects !== undefined ? { projects } : {}),

    use: {
      baseURL: url,
      headless: !process.env.PW_HEADFUL,
      viewport: { width: 1280, height: 800 },
      trace: process.env.CI !== undefined ? 'on-first-retry' : 'retain-on-failure',
      screenshot: 'off',
      video: 'off',
    },

    webServer: {
      command: resolvedCommand,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(env !== undefined ? { env } : {}),
      url,
      timeout: serverTimeout,
      stdout: 'pipe',
      stderr: 'pipe',
      reuseExistingServer: !process.env.CI,
    },
  }
}
