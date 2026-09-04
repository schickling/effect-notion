import { baseTsconfigCompilerOptions, reactJsx } from '../../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from '../genie/src/runtime/mod.ts'

/** react-inspector is a git submodule with relaxed type checking for legacy code */
export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    lib: ['ES2023', 'DOM'],
    rootDir: 'src',
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
} satisfies TSConfigArgs)
