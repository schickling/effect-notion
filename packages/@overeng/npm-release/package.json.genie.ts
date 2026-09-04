// @genie-bootstrap
import {
  catalog,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  type PackageJsonInputData,
  workspaceMember,
} from '../../../genie/internal.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'

/**
 * The `.` export is the decision layer and imports nothing at runtime, so consumers
 * that only classify registry state pull in no dependencies. Effect appears here for
 * the `./cli` entry, which is bundled into a standalone binary at build time.
 */
const peerDepNames = ['@effect/platform-node', 'effect'] as const

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/npm-release' }),
  devDependencies: {
    workspace: [utilsDevPkg],
    external: catalog.pick(...peerDepNames, '@types/node', 'typescript', 'vitest'),
  },
  peerDependencies: {
    external: catalog.pick(...peerDepNames),
  },
})

export default packageJson(
  {
    name: '@overeng/npm-release',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'isomorphic-es2024' },
      ),
      './cli': exportEntry(
        { types: './dist/src/cli.d.ts', default: './src/cli.ts' },
        { environment: 'bun' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
        './cli': './dist/cli.js',
      },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
