// @genie-bootstrap
import {
  catalog as repoCatalog,
  defineCatalog,
  workspaceMember,
  exportEntry,
  packageJson,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'

const catalog = defineCatalog({
  ...repoCatalog.pick(
    'is-dom',
    'react',
    '@storybook/react',
    '@storybook/react-vite',
    '@testing-library/react',
    '@testing-library/user-event',
    '@types/is-dom',
    '@types/react',
    '@vitejs/plugin-react',
    'happy-dom',
    'react-dom',
    'storybook',
    'typescript',
    'vite',
    'vitest',
  ),
  effect: '4.0.0-rc.111',
})

const peerDepNames = ['effect', 'react'] as const
const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/react-inspector' }),
  dependencies: {
    external: {
      ...catalog.pick('is-dom'),
    },
  },
  devDependencies: {
    external: {
      ...catalog.pick(
        ...peerDepNames,
        '@storybook/react',
        '@storybook/react-vite',
        '@testing-library/react',
        '@testing-library/user-event',
        '@types/is-dom',
        '@types/react',
        '@vitejs/plugin-react',
        'happy-dom',
        'react-dom',
        'storybook',
        'typescript',
        'vite',
        'vitest',
      ),
    },
  },
  peerDependencies: {
    external: {
      effect: '^4.0.0-rc.111',
      ...catalog.pick('react'),
    },
  },
})

export default packageJson(
  {
    name: '@overeng/react-inspector',
    /** Forked from react-inspector v8.0.0 (https://github.com/nicksenger/react-inspector) */
    version: '9.0.0',
    description: 'Browser DevTools-style React inspectors with native Effect 4 Schema support',
    /**
     * Fork of react-inspector, MIT (c) 2017 Xiaoyi Chen. The upstream notice is
     * required in all copies, so `LICENSE` ships with the package — the standalone
     * fork repo carries both and this copy had dropped them during a sync.
     */
    license: 'MIT',
    type: 'module',
    exports: {
      // `rootDir` is `src`, so the emitted declaration is `dist/index.d.ts` —
      // the same flat layout `publishConfig.exports` names below.
      '.': exportEntry(
        { types: './dist/index.d.ts', default: './src/index.tsx' },
        { environment: 'browser' },
      ),
    },
    /**
     * Pin the packed contents. Without this, the tarball varied by 169 files
     * depending on whether a typecheck had run — 236 entries after `ts:check`,
     * 67 from a clean checkout — because `dist/` is only ignored by the *repo
     * root* `.gitignore`, and npm consults a package-local ignore file (here:
     * `.vercel` only). `src` ships alongside `dist` so the declaration maps and
     * source maps resolve.
     *
     * The `.tsbuildinfo` is excluded because its contents embed absolute paths,
     * which would make the tarball differ between machines.
     */
    files: ['package.json', 'dist', 'src', '!dist/**/*.tsbuildinfo'],
    /**
     * `exports` resolves to source for workspace consumers; `publishConfig.exports`
     * swaps in the built entry at pack time, matching every other `@overeng/*`
     * package. This is the first package in the repo that is actually packed, so
     * it is the first place that mapping has to be real rather than declarative.
     *
     * The previous map was neither: it was a conditions object rather than the
     * repo's plain-string form, and its `require` condition named
     * `./dist/index.cjs`, which nothing has ever emitted.
     */
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/index.js',
      },
    },
    scripts: {
      /**
       * The declared way to produce the `publishConfig.exports` target. Whoever
       * packs this package must run it first — pnpm 11 runs neither `prepack`
       * nor `prepare` on `pnpm pack` (verified against 11.8.0), so a lifecycle
       * script here would assert a guarantee that does not hold.
       *
       * The guarantee lives at the layer that packs: livestore-contrib's
       * `release/simulate-publish.mjs` builds each package with this same
       * command and then fails if the declared outputs are missing.
       */
      build: 'tsc --build tsconfig.json',
      storybook: 'storybook dev -p 6011',
      'storybook:build': 'storybook build',
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
