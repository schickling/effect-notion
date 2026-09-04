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
  workspace: workspaceMember({ memberPath: 'packages/@overeng/effect-ai-claude-cli' }),
  devDependencies: {
    workspace: [utilsDevPkg],
    external: {
      ...catalog.pick('@effect/vitest', 'typescript', 'effect', 'vite', 'vitest'),
    },
  },
  peerDependencies: {
    external: catalog.pick(...peerDepNames),
  },
})

export default packageJson(
  {
    name: '@overeng/effect-ai-claude-cli',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'node' },
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
