import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts', 'src/**/*.pw.test.ts'],
    server: { deps: { inline: ['@effect/vitest'] } },
    // The otelite tests (src/otelite) spawn the real nix-built otelite binary;
    // give them headroom.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
