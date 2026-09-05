import { defineConfig } from 'vitest/config'

/**
 * Root suite: the Buck projection generators plus the repository-contract tests.
 *
 * The contract suites stay physically in the package whose code they assert on
 * (`@overeng/genie`) and are excluded from that package's own test target, so
 * they are collected here by their declared paths. `rootTestRepositoryContractModules`
 * in `root-test-layout.ts` is the declaration the root test tree stages them
 * from, and `root-test-layout.unit.test.ts` fails when the two disagree; the
 * paths are literal here so loading this config stays free of the projection
 * census.
 */
export default defineConfig({
  test: {
    include: [
      'genie/buck2/**/*.unit.test.ts',
      'buck2/dependencies/**/*.unit.test.ts',
      'packages/@overeng/genie/src/runtime/github-workflow/ci-runtime-scripts.unit.test.ts',
      'packages/@overeng/genie/src/runtime/github-workflow/ci-workflow-helpers.unit.test.ts',
      'packages/@overeng/otel-contract/src/raw-otel-boundary.unit.test.ts',
      'packages/@overeng/otel-contract/src/registry-seam.unit.test.ts',
    ],
    server: { deps: { inline: ['@effect/vitest'] } },
  },
})
