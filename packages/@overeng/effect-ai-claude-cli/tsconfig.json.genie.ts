import {
  baseTsconfigCompilerOptions,
  domLib,
  packageTsconfigCompilerOptions,
} from '../../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from '../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    lib: domLib,
    noEmit: true,
  },
  include: ['src/**/*'],
} satisfies TSConfigArgs)
