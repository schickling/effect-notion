/**
 * Vitest config factory for the story-driven visual + accessibility gate.
 *
 * @module
 */

import { appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

import { storybookTest } from '@storybook/addon-vitest/vitest-plugin'
import { playwright } from '@vitest/browser-playwright'
import type { Plugin, ViteUserConfig } from 'vitest/config'

/**
 * Directory the current run compares against, supplied by `runStoryGate`.
 *
 * The gate config is executed in a Vitest child process, so the derived
 * baseline location travels as an environment variable rather than an argument.
 */
export const baselineDirEnvVar = 'OVERENG_STORY_GATE_BASELINE_DIR'

/**
 * File the config appends every resolved baseline path to.
 *
 * `resolveScreenshotPath` is called exactly once per story assertion, which
 * makes it the cheapest faithful record of which baselines the current tree
 * actually asked for. A baseline present on disk but absent from this list is a
 * story that disappeared — the one gate failure the runner cannot infer from
 * test results, because a story that no longer exists produces no test.
 */
export const manifestEnvVar = 'OVERENG_STORY_GATE_MANIFEST'

/** A theme the gate covers, expressed as a Storybook toolbar global. */
export interface StoryGateTheme {
  /** Toolbar global name, e.g. `'theme'`. */
  readonly name: string
  /** Value to pin for this project, e.g. `'dark'`. */
  readonly value: string
}

/** Options for {@link createStoryGateConfig}. */
export interface StoryGateConfigOptions {
  /** Storybook config dir, relative to the Vitest config file. @default '.storybook' */
  readonly configDir?: string
  /**
   * One Vitest project per theme. Requires Storybook >= 10.5, which is where
   * `initialGlobals` became a per-project option.
   */
  readonly themes?: readonly StoryGateTheme[]
  /** @default true */
  readonly headless?: boolean
  /**
   * Vite plugins the stories need in order to load, e.g. a compiler transform.
   *
   * These MUST arrive here rather than being merged into the returned config,
   * because **Vitest projects do not inherit root-level `plugins`** — each
   * project is its own Vite config. Merging at the root works only by accident
   * in the single-theme case, where this factory returns a bare project config
   * and the caller's merge target *is* the project. Add a second theme and the
   * same merge silently stops applying: the return shape becomes
   * `{ test: { projects } }`, the plugins land beside `test` where nothing reads
   * them, and every story fails to load with a runtime error from the
   * untransformed source.
   *
   * Measured end to end: a one-theme consumer ran 4 stories while a two-theme
   * consumer reported `Tests no tests`, and threading the same plugins through
   * this option moved it to 10 stories executed.
   */
  readonly plugins?: ViteUserConfig['plugins']
}

const readBaselineRoot = (): string => {
  const baselineRoot = process.env[baselineDirEnvVar]
  if (baselineRoot === undefined || baselineRoot === '') {
    throw new Error(
      `[story-gate] ${baselineDirEnvVar} is not set. Baselines are derived from a git ref by \`runStoryGate\`, never committed, so this config cannot be run directly.`,
    )
  }
  return baselineRoot
}

const recordResolvedBaseline = (path: string): void => {
  const manifest = process.env[manifestEnvVar]
  if (manifest === undefined || manifest === '') return
  appendFileSync(manifest, `${path}\n`)
}

/**
 * Every React specifier the alias pins, in match order.
 *
 * The five entry points come first and map to `require.resolve`d files, because
 * that is the shape that was measured. The two subpath rules come last and only
 * catch specifiers the exact rules did not, so they cannot change any measured
 * mapping. They exist because the exact list is an enumeration and enumerations
 * of a package's subpaths are never complete: `react-dom/test-utils` is already
 * a live optimizer entry in one consumer's prebundle and is not among the five,
 * and `react-dom/server` and `react/compiler-runtime` are the obvious next ones.
 *
 * Every `find` is anchored. A bare string `'react'` would be a prefix match and
 * would swallow `react-dom`, `react-aria-components` and every other `react*`
 * package; `/^react\/(.*)$/` cannot, because the separator is part of the match.
 *
 * `react-is` is deliberately absent. Duplicating it is harmless — it holds no
 * runtime state, it is a bag of predicates over element types.
 */
const reactAliasRules = [
  { find: /^react$/, target: { kind: 'entry', specifier: 'react' } },
  { find: /^react-dom$/, target: { kind: 'entry', specifier: 'react-dom' } },
  { find: /^react-dom\/client$/, target: { kind: 'entry', specifier: 'react-dom/client' } },
  { find: /^react\/jsx-runtime$/, target: { kind: 'entry', specifier: 'react/jsx-runtime' } },
  {
    find: /^react\/jsx-dev-runtime$/,
    target: { kind: 'entry', specifier: 'react/jsx-dev-runtime' },
  },
  { find: /^react\/(.*)$/, target: { kind: 'subpath', specifier: 'react' } },
  { find: /^react-dom\/(.*)$/, target: { kind: 'subpath', specifier: 'react-dom' } },
] as const

/**
 * Resolve every React specifier against `root` — the consuming package.
 *
 * `@overeng/utils` reaches most consumers as a `link:` into a sibling megarepo
 * checkout that carries its own `node_modules`, and Node resolves from a link's
 * real path. So `@storybook/react-dom-shim` — the thing that actually renders
 * every story — resolves `react`/`react-dom` inside THIS tree, while the
 * consuming package's stories and its `react-aria-components` resolve them
 * inside THEIRS. Two React copies, same version, one optimise pass, different
 * absolute files.
 *
 * The renderer then installs the hook dispatcher on its own copy's shared
 * internals, any component reaching a hook through the other copy reads a null
 * dispatcher and throws `Cannot read properties of null (reading 'useContext')`,
 * React unwinds and retries, the DOM never settles, and the screenshot matcher
 * — which waits for two identical consecutive frames — reports a stability
 * timeout naming none of the above. Measured on one consumer's `Button.stories`
 * before this alias: 40 `Invalid hook call` warnings, 20 null-dispatcher errors,
 * 10/10 stories failed, 67.6s. After: 8 passed / 2 failed in 8.8s, zero hook
 * errors, and the 2 are real accessibility violations.
 *
 * Two obvious levers do not do this. `resolve.dedupe` picks one copy of one
 * *package*, but esbuild shares a chunk per *module* and these are two files on
 * disk. `optimizeDeps.include`/`exclude` move modules between graphs without
 * changing which file `react` resolves to. Only a resolution-level override
 * collapses them.
 *
 * Resolving against the consuming root rather than this module's own location
 * is the whole point and is easy to invert: `createRequire(import.meta.url)`
 * here would pin every consumer to the effect-utils copy, i.e. the wrong side of
 * the duplicate. For a consumer that lives *inside* the effect-utils tree the
 * two resolutions are the same file, so this degrades to an identity mapping —
 * which is why such packages never had the defect in the first place.
 *
 * Unresolvable specifiers are dropped rather than thrown on: a package whose
 * stories are not React at all is a legitimate gate consumer.
 */
const resolveReactAlias = (root: string): { find: RegExp; replacement: string }[] => {
  const require = createRequire(join(root, 'noop.js'))
  const resolveSafely = (specifier: string): string | undefined => {
    try {
      return require.resolve(specifier)
    } catch {
      return undefined
    }
  }

  // `$` is a replacement-pattern metacharacter in `String.prototype.replace`,
  // and these replacements are filesystem paths we did not choose. pnpm's
  // virtual store has never produced one, but a path that did would corrupt
  // silently, so both branches escape it.
  return reactAliasRules.flatMap(({ find, target }) => {
    if (target.kind === 'entry') {
      const file = resolveSafely(target.specifier)
      return file === undefined ? [] : [{ find, replacement: file.replaceAll('$', '$$$$') }]
    }
    const manifest = resolveSafely(`${target.specifier}/package.json`)
    return manifest === undefined
      ? []
      : [{ find, replacement: `${dirname(manifest).replaceAll('$', '$$$$')}/$1` }]
  })
}

/**
 * Apply {@link resolveReactAlias} using Vite's own notion of the project root.
 *
 * A plugin rather than a literal `resolve.alias`, because the root is only known
 * once Vite has the config in hand, and `config.root ?? process.cwd()` is
 * exactly how Vite itself derives it. Living inside each project's `plugins`
 * also means it applies per project: a root-level `resolve` is not reliably
 * inherited by a Vitest project, which carries its own Vite config.
 */
const pinReactToConsumer = (): Plugin => ({
  name: 'overeng-story-gate:pin-react-to-consumer',
  enforce: 'pre',
  config: (config) => ({
    resolve: { alias: resolveReactAlias(resolve(config.root ?? process.cwd())) },
  }),
})

/**
 * Build the Storybook test plugin for one project.
 *
 * Injected rather than called inline so the plugin-placement invariant is
 * unit-testable. `storybookTest` eagerly loads a real Storybook config
 * directory, so a test that invoked it would need a Storybook install and a
 * fixture `main.ts` in a package that has neither — and the thing worth
 * guarding is *where the plugins land*, which is independent of what they are.
 */
export type StorybookPluginFor = (args: {
  configDir: string
  theme: StoryGateTheme | undefined
}) => NonNullable<ViteUserConfig['plugins']>[number]

const defaultStorybookPluginFor: StorybookPluginFor = ({ configDir, theme }) =>
  storybookTest({
    configDir,
    ...(theme === undefined ? {} : { initialGlobals: { [theme.name]: theme.value } }),
  })

const createProject = ({
  configDir,
  theme,
  headless,
  baselineRoot,
  plugins,
  storybookPluginFor,
}: {
  configDir: string
  theme: StoryGateTheme | undefined
  headless: boolean
  baselineRoot: string
  plugins: ViteUserConfig['plugins']
  storybookPluginFor: StorybookPluginFor
}): ViteUserConfig => {
  const projectName = theme === undefined ? 'story-gate' : `story-gate-${theme.value}`
  const baselineDir = join(baselineRoot, projectName)

  return {
    // Caller plugins come after the React pin and before the Storybook plugin:
    // a compiler transform has to see the source before Storybook turns it into
    // a test module, and the React pin must stay first so its alias applies to
    // whatever the transform emits.
    plugins: [pinReactToConsumer(), ...(plugins ?? []), storybookPluginFor({ configDir, theme })],
    // The baseline half of a run happens inside a git worktree that borrows the
    // main tree's `node_modules` by symlink, so workspace sources — this gate's
    // own setup file among them — resolve to paths outside the served root and
    // Vite refuses them. This is a throwaway test server; strict roots buy
    // nothing here and cost the derived-baseline mechanism entirely.
    server: { fs: { strict: false } },
    test: {
      name: projectName,
      setupFiles: ['@overeng/utils/node/storybook/gate/setup'],
      browser: {
        enabled: true,
        headless,
        provider: playwright(),
        instances: [{ browser: 'chromium' }],
        // Capturing several stories concurrently in one browser context
        // corrupted frames nondeterministically — a few stories per run showed
        // a stale duplicate band from racing full-page captures. Sequential
        // capture was byte-stable across runs and the concurrency saving was
        // under a quarter of the runtime, so it buys nothing.
        fileParallelism: false,
        expect: {
          toMatchScreenshot: {
            comparatorName: 'pixelmatch',
            comparatorOptions: {
              // All three are non-default and every default fails silently.
              //
              // `allowedMismatchedPixels: 0` alone does NOT compare strictly:
              // pixelmatch defaults to a perceptual `threshold` of 0.1 and to
              // ignoring anti-aliased pixels. Measured — a token mis-map moving
              // a radius by one pixel and one colour channel by six passed
              // across three stories under those defaults.
              //
              // `threshold` is 0.02 rather than 0 because 0 fails on sub-pixel
              // anti-aliasing. A border at a fractional y renders as ~70%
              // coverage on one row with the remainder bleeding into the next,
              // and the split is not stable across capture sessions. Measured
              // on a real artifact: one 1px-tall row, 689 pixels, each off by
              // 1-2/255 against white.
              //
              // The reason a tolerance is safe here is that the noise is an
              // INTENSITY delta while the smallest regression the gate must
              // catch is a STRUCTURAL one, and pixelmatch's threshold separates
              // them by two orders of magnitude. Swept against this comparator:
              //
              //   threshold  AA fringe   1px border shift
              //   0          689         1868
              //   0.005      689         1868
              //   0.0075     0           1868
              //   0.02       0           ~1868   <- landed here
              //   0.05       0           1860
              //   0.1        0           0
              //
              // 0.02 sits ~2.7x above where the noise dies and ~5x below where
              // a 1px shift starts eroding at all. Do not raise it towards 0.1;
              // that is where real geometry changes stop being reported.
              //
              // `allowedMismatchedPixels` stays 0 on purpose. Absorbing the
              // fringe with a pixel-count budget instead would have cost the
              // property that a single structurally-different pixel still
              // fails; keeping the count at 0 preserves it.
              threshold: 0.02,
              includeAA: true,
              allowedMismatchedPixels: 0,
            },
            resolveScreenshotPath: ({ arg, ext, testFileDirectory, testFileName }) => {
              const path = join(baselineDir, testFileDirectory, testFileName, `${arg}${ext}`)
              recordResolvedBaseline(path)
              return path
            },
          },
        },
      },
    },
  }
}

/**
 * Build the Vitest configuration that gates a package's stories.
 *
 * Four settings are non-default because each ecosystem default fails silently,
 * and all four are measured:
 *
 * 1. Comparator `threshold: 0.02` with `includeAA: true` and a zero mismatched-
 *    pixel budget — see the inline note for the sweep behind the number.
 * 2. `parameters.a11y.test: 'error'`, applied through `setupFiles`; the default
 *    `'todo'` downgrades every violation to a warning. See `./annotations.ts`.
 * 3. Baselines resolved into a ref-derived directory rather than a committed
 *    one. Captures depend on the host's installed fonts wherever a generic
 *    family is used: forcing a different family moved one to three thousand
 *    pixels per story, one to two orders of magnitude more than a real
 *    regression, so a committed baseline is only valid on the machine that
 *    produced it. Deriving both sides in one run on one host cancels the host
 *    out exactly.
 * 4. React pinned to the consuming package's own copy — see
 *    {@link resolveReactAlias}. Without it, a consumer that reaches this
 *    package through a cross-checkout `link:` renders every story against a
 *    second React instance and every story times out.
 */
export const createStoryGateConfig = ({
  configDir = '.storybook',
  themes,
  headless = true,
  plugins,
  storybookPluginFor = defaultStorybookPluginFor,
}: StoryGateConfigOptions & {
  /** Seam for unit tests; production callers never pass this. */
  readonly storybookPluginFor?: StorybookPluginFor
} = {}): ViteUserConfig => {
  const baselineRoot = readBaselineRoot()
  const projects = (themes ?? [undefined]).map((theme) =>
    createProject({ configDir, theme, headless, baselineRoot, plugins, storybookPluginFor }),
  )

  if (projects.length === 1 && projects[0] !== undefined) return projects[0]
  // Also at the root, not only inside each project. The root config runs its own
  // Vite pipeline for config loading and collection, and a project's `resolve`
  // does not reach it.
  return { plugins: [pinReactToConsumer()], test: { projects } }
}
