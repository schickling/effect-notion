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
  effect: '4.0.0-rc.112',
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
      effect: '^4.0.0-rc.112',
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
      '.': exportEntry(
        { types: './dist/src/index.d.ts', default: './src/index.tsx' },
        { environment: 'browser' },
      ),
    },
    /**
     * Pin the packed contents. Without this, the tarball varied by 169 files
     * depending on whether a typecheck had run — 236 entries after `ts:check`,
     * 67 from a clean checkout — because `dist/` is only ignored by the *repo
     * root* `.gitignore`, and npm consults a package-local ignore file (here:
     * `.vercel` only). `src` ships alongside the built directories so the
     * declaration maps and source maps resolve.
     *
     * Two built directories ship, because two different producers write them:
     * `dist` is Buck-owned and holds declarations only, and `dist-pack` holds
     * the JavaScript the `build` script emits for packing.
     *
     * The `.tsbuildinfo` is excluded because its contents embed absolute paths,
     * which would make the tarball differ between machines.
     */
    files: ['package.json', 'dist', 'dist-pack', 'src', '!dist/**/*.tsbuildinfo'],
    /**
     * `exports` resolves to source for workspace consumers; `publishConfig.exports`
     * swaps in the built entry at pack time, matching every other `@overeng/*`
     * package. This is the first package in the repo that is actually packed, so
     * it is the first place that mapping has to be real rather than declarative.
     *
     * It is also the only place in the repo where types and runtime come from
     * different producers, which is why this entry is a conditions object rather
     * than the repo's usual plain string: Buck materializes `dist` and it holds
     * declarations only, so the runtime cannot live beside them. The paths carry
     * a `src/` segment because `rootDir` is the package root, so `src/index.tsx`
     * emits to `<outDir>/src/index.js`.
     */
    publishConfig: {
      access: 'public',
      exports: {
        '.': {
          types: './dist/src/index.d.ts',
          default: './dist-pack/src/index.js',
        },
      },
    },
    scripts: {
      /**
       * The declared way to produce the `publishConfig.exports` runtime target.
       * Whoever packs this package must run it first. pnpm 12 does run
       * `prepack` and `prepare` on `pnpm pack` (verified against 12.3.4,
       * unlike pnpm 11.8.0, which ran neither), but a lifecycle script here
       * would still only cover packers that go through pnpm.
       *
       * The guarantee therefore stays at the layer that packs: livestore-contrib's
       * `release/simulate-publish.mjs` builds each package with this same
       * command and then fails if the declared outputs are missing.
       *
       * `tsconfig.json` is the Buck declaration-authority project: it carries
       * `noEmit`, and Buck materializes `dist` as declarations only. So this
       * command reuses that project — one emitting invocation, exactly how the
       * Buck emit action overrides the flag — but redirects every byte it writes
       * to `dist-pack` and turns off declaration, composite, and incremental
       * output. Nothing a source-side build produces may land in `dist`: that
       * directory has one producer, and `buck2:typescript:materialize-dist`
       * compares it against a fresh compile that emits declarations only.
       */
      build:
        'tsc --project tsconfig.json --noEmit false --outDir dist-pack --declaration false --declarationMap false --composite false --incremental false',
      storybook: 'storybook dev -p 6011',
      'storybook:build': 'storybook build',
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
