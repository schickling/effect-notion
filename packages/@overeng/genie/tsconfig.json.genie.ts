import {
  baseTsconfigCompilerOptions,
  packageTsconfigCompilerOptions,
  nodeTypes,
} from '../../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from './src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    ...nodeTypes,
    types: ['node', 'bun'],
    jsx: 'react-jsx',
    noEmit: true,
  },
  include: ['src/**/*.ts', 'src/**/*.tsx', 'bin/**/*.ts', 'bin/**/*.tsx'],
} satisfies TSConfigArgs)
