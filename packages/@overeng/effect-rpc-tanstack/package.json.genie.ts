// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const peerDepNames = [
  '@effect/platform-node',
  '@tanstack/react-router',
  '@tanstack/react-start',
  'effect',
  'react',
  'react-dom',
] as const
const workspaceDeps = catalog.compose({
  workspace: workspaceMember({
    memberPath: 'packages/@overeng/effect-rpc-tanstack',
    pnpmPackageClosure: {
      extraMemberPaths: ['packages/@overeng/effect-rpc-tanstack/examples/basic'],
    },
  }),
  devDependencies: {
    workspace: [utilsPkg],
    external: {
      ...catalog.pick(...peerDepNames, '@types/react', 'typescript', 'vite', 'vitest'),
    },
  },
  peerDependencies: {
    external: catalog.pick(...peerDepNames),
  },
})

export default packageJson(
  {
    name: '@overeng/effect-rpc-tanstack',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'browser' },
      ),
      './client': exportEntry(
        { types: './dist/src/client.d.ts', default: './src/client.ts' },
        { environment: 'browser' },
      ),
      './server': exportEntry(
        { types: './dist/src/server.d.ts', default: './src/server.ts' },
        { environment: 'node' },
      ),
      './router': exportEntry(
        { types: './dist/src/router.d.ts', default: './src/router.ts' },
        { environment: 'browser' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
        './client': './dist/client.js',
        './server': './dist/server.js',
        './router': './dist/router.js',
      },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
