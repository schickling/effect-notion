import { builtinModules } from 'node:module'
import path from 'node:path'

import { build } from 'vite'

const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)])
const nativePty: Readonly<Record<string, true>> = {
  'node-pty': true,
  '@homebridge/node-pty-prebuilt-multiarch': true,
}
const external = (id: string): boolean =>
  builtins.has(id) === true || nativePty[id] === true || id.endsWith('.node')

const entries = [
  { name: 'pty-effect', entry: 'src/mod.ts' },
  { name: 'pty-effect-client', entry: 'src/client.ts' },
] as const

await Promise.all(
  entries.map(({ name, entry }) =>
    build({
      root: process.cwd(),
      configFile: false,
      logLevel: 'warn',
      ssr: { noExternal: true },
      build: {
        emptyOutDir: false,
        minify: false,
        outDir: path.join(process.cwd(), 'tmp', 'bundle-smoke', name),
        ssr: path.join(process.cwd(), entry),
        write: false,
        rollupOptions: {
          external,
          output: { entryFileNames: `${name}.mjs` },
        },
      },
    }),
  ),
)
