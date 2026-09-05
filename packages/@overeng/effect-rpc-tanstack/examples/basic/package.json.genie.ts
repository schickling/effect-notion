// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  packageJson,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../../../genie/internal.ts'
import utilsPkg from '../../../utils/package.json.genie.ts'
import rpcTanstackPkg from '../../package.json.genie.ts'

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({
    memberPath: 'packages/@overeng/effect-rpc-tanstack/examples/basic',
  }),
  dependencies: {
    workspace: [rpcTanstackPkg],
    external: {
      ...catalog.pick(
        '@effect/platform-node',
        '@tanstack/react-router',
        '@tanstack/react-start',
        'effect',
        'react',
        'react-dom',
      ),
    },
  },
  devDependencies: {
    workspace: [utilsPkg],
    external: {
      ...catalog.pick(
        '@playwright/test',
        '@tanstack/router-plugin',
        '@types/node',
        '@types/react',
        '@types/react-dom',
        '@vitejs/plugin-react',
        'typescript',
        'vite',
      ),
    },
  },
})

export default packageJson(
  {
    name: 'effect-rpc-tanstack-example-basic',
    ...privatePackageDefaults,
    scripts: {
      dev: 'vite',
      build: 'vite build',
      start: 'node .output/server/index.mjs',
      'test:e2e': 'playwright test',
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
