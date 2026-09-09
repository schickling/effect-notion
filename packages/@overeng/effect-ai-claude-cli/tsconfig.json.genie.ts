import {
  baseTsconfigCompilerOptions,
  domLib,
  nodeTypes,
  packageTsconfigCompilerOptions,
} from '../../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from '../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    ...nodeTypes,
    lib: domLib,
    types: ['node'],
  },
  include: ['src/**/*'],
  references: [],
} satisfies TSConfigArgs)
