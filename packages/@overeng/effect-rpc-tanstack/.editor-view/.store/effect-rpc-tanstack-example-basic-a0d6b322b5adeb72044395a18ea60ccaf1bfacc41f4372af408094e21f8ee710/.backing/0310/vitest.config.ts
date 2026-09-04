import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts', 'src/**/*.pw.test.ts'],
    server: { deps: { inline: ['@effect/vitest'] } },
    // The first lock/file-system test in a fresh CI worker can exceed the 5s
    // default under load (it passes in <1s locally). 20s absorbs cold-start cost.
    testTimeout: 20000,
    env: {
      /**
       * Storybook's `common` entry builds a `FileSystemCache` at import time and, with no
       * `CACHE_DIR` set, resolves its base path to `<package>/node_modules/.cache/storybook`.
       * The gate's unit tests reach that module transitively (`gate/project.ts` imports the
       * Storybook Vitest plugin), and the package tree is read-only inside the Buck test
       * sandbox, so the eager `mkdir` fails with `EROFS` before a single test is collected.
       *
       * Nothing these tests assert depends on that cache, so it is pointed at the temporary
       * root instead. Under Buck that is the runner-owned scratch directory, created and
       * released per invocation; outside Buck it is the host temporary directory.
       */
      CACHE_DIR: join(tmpdir(), 'overeng-utils-vitest'),
    },
  },
})
