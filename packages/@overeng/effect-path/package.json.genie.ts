// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'

const peerDepNames = ['effect'] as const

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/effect-path' }),
  devDependencies: {
    workspace: [utilsDevPkg],
    external: {
      ...catalog.pick(
        ...peerDepNames,
        '@effect/platform-node',
        '@effect/vitest',
        '@types/node',
        'typescript',
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
    name: '@overeng/effect-path',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'isomorphic-es2024' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
      },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
