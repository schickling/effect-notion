import {
  baseTsconfigCompilerOptions,
  domLib,
  nodeTypes,
  packageTsconfigCompilerOptions,
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
    noEmit: true,
  },
  include: ['src/**/*', 'test/**/*'],
} satisfies TSConfigArgs)
