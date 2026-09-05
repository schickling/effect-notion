import { baseTsconfigCompilerOptions, domLib } from '../../../genie/internal.ts'
import {
  tsconfigJson,
  type TSConfigArgs,
} from '../../../packages/@overeng/genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    composite: true,
    rootDir: '.',
    noEmit: true,
    // Buck's emit action leaves only the `dist` output writable, so the
    // build-info file has to live inside it (as in context/opentui).
    tsBuildInfoFile: './dist/tsconfig.tsbuildinfo',
    lib: [...domLib],
    types: ['node'],
  },
  include: ['examples/**/*.ts'],
  exclude: ['*.genie.ts'],
} satisfies TSConfigArgs)
