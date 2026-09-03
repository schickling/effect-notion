import {
  baseTsconfigCompilerOptions,
  domLib,
  packageTsconfigCompilerOptions,
  nodeTypes,
  reactJsx,
} from '../../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from '../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    ...nodeTypes,
    ...reactJsx,
    jsxImportSource: 'react',
    lib: [...domLib],
  },
  include: ['src/**/*'],
  references: [],
} satisfies TSConfigArgs)
