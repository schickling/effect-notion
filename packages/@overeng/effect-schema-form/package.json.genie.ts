// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'

const peerDepNames = ['effect', 'react'] as const
const deps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/effect-schema-form' }),
  devDependencies: {
    external: {
      ...catalog.pick(
        ...peerDepNames,
        '@types/react',
        '@types/react-dom',
        'react-dom',
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
    name: '@overeng/effect-schema-form',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'browser' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
      },
    },
  } satisfies PackageJsonInputData,
  deps,
)
