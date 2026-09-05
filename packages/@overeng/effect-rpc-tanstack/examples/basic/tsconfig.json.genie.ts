import { domLib, nodeTypes, reactJsx } from '../../../../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from '../../../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    target: 'ES2022',
    lib: [...domLib],
    module: 'ESNext',
    moduleResolution: 'bundler',
    // Explicit `.ts`/`.tsx` specifiers are the repo-wide convention and Vite resolves them
    // as written. `rewriteRelativeImportExtensions` keeps that legal once the Buck `dist`
    // action re-runs this very project with `--noEmit false`: TS5096 accepts
    // `allowImportingTsExtensions` only together with `noEmit`, `emitDeclarationOnly`, or
    // this rewrite, and only the rewrite survives an emitting run. Nothing about the app
    // build changes — Vite, not tsc, produces the shipped bundle.
    allowImportingTsExtensions: true,
    rewriteRelativeImportExtensions: true,
    // The example publishes no package exports, so its declarations are the Buck emit
    // proof that the whole example program compiled (same role as `context/opentui`).
    declaration: true,
    ...nodeTypes,
    ...reactJsx,
    strict: true,
    noUncheckedIndexedAccess: true,
    esModuleInterop: true,
    skipLibCheck: true,
    forceConsistentCasingInFileNames: true,
    isolatedModules: true,
    noEmit: true,
  },
  include: ['src/**/*', 'vite.config.ts'],
} satisfies TSConfigArgs)
