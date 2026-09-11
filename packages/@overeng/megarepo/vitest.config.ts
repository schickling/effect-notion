import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    /** Make every git subprocess hermetic w.r.t. host/CI git config (identity + default branch). */
    setupFiles: ['./src/test-utils/git-env-setup.ts'],
    /** CLI integration tests mutate process.env and stdio while running in-process. */
    fileParallelism: false,
    /** Integration tests spawn git subprocesses whose overhead varies across CI runners */
    testTimeout: 15_000,
  },
})
