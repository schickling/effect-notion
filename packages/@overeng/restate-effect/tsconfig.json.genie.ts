import {
  baseTsconfigCompilerOptions,
  packageTsconfigCompilerOptions,
  nodeTypes,
} from '../../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from '../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    ...nodeTypes,
    noEmit: true,
  },
  include: ['src/**/*', 'examples/**/*'],
} satisfies TSConfigArgs)
