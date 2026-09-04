// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import otelContractPkg from '../otel-contract/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/ci-tools' }),
  dependencies: {
    workspace: [otelContractPkg, utilsPkg],
  },
  devDependencies: {
    workspace: [utilsDevPkg, utilsPkg],
    external: catalog.pick(
      '@effect/platform-node',
      '@effect/vitest',
      '@types/bun',
      '@types/node',
      'typescript',
      'vitest',
    ),
  },
  peerDependencies: {
    workspace: [utilsPkg],
    external: catalog.pick('effect'),
  },
})

export default packageJson(
  {
    name: '@overeng/ci-tools',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'node' },
      ),
      './cli': exportEntry(
        { types: './dist/src/cli-command.d.ts', default: './src/cli-command.ts' },
        { environment: 'node' },
      ),
    },
    publishConfig: {
      access: 'public',
      bin: {
        'ci-tools': './dist/bin/ci-tools.js',
      },
      exports: {
        '.': './dist/src/mod.js',
        './cli': './dist/src/cli-command.js',
      },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
