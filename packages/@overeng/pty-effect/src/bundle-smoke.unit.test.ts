import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it } from 'vitest'

const builtinSpecifiers = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
])
const nativePtySpecifiers = new Set(['node-pty', '@homebridge/node-pty-prebuilt-multiarch'])
const external = (id: string): boolean =>
  builtinSpecifiers.has(id) || nativePtySpecifiers.has(id) || id.endsWith('.node')

const smokeEntries = [
  { name: 'pty-effect', entry: 'src/mod.ts' },
  { name: 'pty-effect-client', entry: 'src/client.ts' },
] as const

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

describe('public Vite/Rollup bundle surface', () => {
  it('bundles every public entry with dependency resolution', async () => {
    const { build } = await import('vite')
    await Promise.all(
      smokeEntries.map((smokeEntry) =>
        build({
          root: packageRoot,
          configFile: false,
          logLevel: 'warn',
          ssr: { noExternal: true },
          build: {
            emptyOutDir: false,
            minify: false,
            outDir: path.join(packageRoot, 'tmp', 'bundle-smoke', smokeEntry.name),
            ssr: path.join(packageRoot, smokeEntry.entry),
            write: false,
            rolldownOptions: {
              external,
              output: { entryFileNames: `${smokeEntry.name}.mjs` },
            },
          },
        }),
      ),
    )
  }, 120_000)
})
