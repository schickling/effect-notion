import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Integration tests (e.g. the SC-R12 weaver live-check e2e) SKIP without their env, so they
    // are safe in the default lane; the `weaver:live-check` devenv task runs the e2e with the
    // hermetic weaver + semconv-model on env.
    include: ['src/**/*.unit.test.ts', 'src/**/*.integration.test.ts'],
    server: { deps: { inline: ['@effect/vitest'] } },
  },
})
