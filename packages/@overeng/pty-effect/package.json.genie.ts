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

const peerDepNames = ['effect'] as const

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/pty-effect' }),
  dependencies: {
    workspace: [otelContractPkg],
    external: catalog.pick('@myobie/pty'),
  },
  devDependencies: {
    workspace: [utilsDevPkg],
    external: {
      ...catalog.pick(
        ...peerDepNames,
        '@effect/vitest',
        '@types/node',
        'typescript',
        'vite',
        'vitest',
      ),
    },
  },
  peerDependencies: {
    external: catalog.pick(...peerDepNames),
  },
})

export default packageJson(
  {
    name: '@overeng/pty-effect',
    ...privatePackageDefaults,
    scripts: {
      'bundle:smoke': 'bun ../../../genie/ci-scripts/bundle-smoke.ts',
    },
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'node' },
      ),
      './client': exportEntry(
        { types: './dist/src/client.d.ts', default: './src/client.ts' },
        { environment: 'node' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
        './client': './dist/client.js',
      },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
