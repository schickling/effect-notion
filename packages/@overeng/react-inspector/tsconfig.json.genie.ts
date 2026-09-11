import { baseTsconfigCompilerOptions, reactJsx } from '../../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from '../genie/src/runtime/mod.ts'

/** react-inspector is a git submodule with relaxed type checking for legacy code */
export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    lib: ['ES2023', 'DOM'],
    rootDir: '.',
    outDir: './dist',
    ...reactJsx,
    allowJs: true,
    checkJs: false,
    composite: true,
    strict: false,
    noImplicitAny: false,
    strictNullChecks: false,
    exactOptionalPropertyTypes: false,
    noUncheckedIndexedAccess: false,
    verbatimModuleSyntax: false,
    noImplicitReturns: false,
    noEmit: true,
  },
  include: ['src/**/*'],
  /**
   * The Buck TypeScript source census admits `.cts`, `.js`, `.mts`, `.ts` and
   * `.tsx`, so the compile tree Buck typechecks and emits from carries no
   * `.jsx`, `.cjs` or `.mjs` at all — this fork's `*.spec.jsx` modules are
   * staged only in the test tree, where the runner collects them.
   *
   * `allowJs` would otherwise pull them into this project from the working
   * tree, and then the two producers disagree: Buck's `dist` holds declarations
   * for the census, while a standalone compile of the same project emits five
   * extra `*.spec.d.ts` (and maps), which the declaration comparison in
   * `buck2:typescript:materialize-dist` reads as unfixable staleness. The pack
   * build reuses this project too, so the same exclusion keeps compiled specs
   * out of the published runtime.
   *
   * Stated by extension rather than by `*.spec.*`: the census rejects these
   * extensions outright, while a `.spec.ts` is an ordinary source both trees
   * carry and both producers must emit.
   */
  exclude: ['src/**/*.cjs', 'src/**/*.jsx', 'src/**/*.mjs'],
} satisfies TSConfigArgs)
