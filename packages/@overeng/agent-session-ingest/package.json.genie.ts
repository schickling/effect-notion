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
import utilsPkg from '../utils/package.json.genie.ts'

const peerDepNames = ['effect'] as const

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/agent-session-ingest' }),
  dependencies: {
    workspace: [utilsPkg],
  },
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
  // `@overeng/utils` is a runtime workspace dep that carries peer dependencies
  // (the @effect/* cluster + @playwright/test). `mode: 'install'` makes genie
  // install those inherited peers explicitly so a standalone consumer resolves.
  mode: 'install',
})

export default packageJson(
  {
    name: '@overeng/agent-session-ingest',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'node' },
      ),
      './codex': exportEntry(
        { types: './dist/src/adapters/codex.d.ts', default: './src/adapters/codex.ts' },
        { environment: 'node' },
      ),
      './claude': exportEntry(
        { types: './dist/src/adapters/claude.d.ts', default: './src/adapters/claude.ts' },
        { environment: 'node' },
      ),
      './opencode': exportEntry(
        { types: './dist/src/adapters/opencode.d.ts', default: './src/adapters/opencode.ts' },
        { environment: 'node' },
      ),
      './jsonl': exportEntry(
        { types: './dist/src/adapters/jsonl.d.ts', default: './src/adapters/jsonl.ts' },
        { environment: 'node' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
        './codex': './dist/adapters/codex.js',
        './claude': './dist/adapters/claude.js',
        './opencode': './dist/adapters/opencode.js',
        './jsonl': './dist/adapters/jsonl.js',
      },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
