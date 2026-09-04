/**
 * Storybook config factories for consistent Vite-based Storybook setups.
 *
 * Two variants:
 * - `createDomStorybookConfig` — browser-rendered React packages
 * - `createTuiStorybookConfig` — terminal UI packages (OpenTUI stubs, React dedupe, esnext)
 *
 * @module
 */

import type { StorybookConfig } from '@storybook/react-vite'
import type { InlineConfig } from 'vite'

type StorybookViteFinal<TConfig extends object> = (config: TConfig) => TConfig | Promise<TConfig>

/** Options for `createDomStorybookConfig`. */
export interface DomStorybookConfigOptions {
  /** Story glob patterns */
  stories?: string[]
  /** Extra addons to include */
  addons?: StorybookConfig['addons']
  /** Disable minification (useful for react-inspector to preserve function names) */
  disableMinify?: boolean
  /**
   * Register `@storybook/addon-a11y`.
   *
   * Required by the story gate: `parameters.a11y.test` is inert unless the
   * addon is registered, so without this the gate's per-story accessibility
   * check silently passes everything.
   */
  a11y?: boolean
}

/** Use when the consuming workspace needs its own local Vite config type for `viteFinal`. */
export interface DomStorybookConfigOptionsWithViteFinal<
  TConfig extends object,
> extends DomStorybookConfigOptions {
  /** Extension hook — runs after the factory transforms for custom overrides */
  viteFinal: StorybookViteFinal<TConfig>
}

/** Options for `createTuiStorybookConfig`. */
export interface TuiStorybookConfigOptions {
  /** Story glob patterns */
  stories?: string[]
  /** Extra addons to include */
  addons?: StorybookConfig['addons']
  /** Additional entries merged into `optimizeDeps.include` (e.g. CJS transitive deps) */
  additionalOptimizeDepsInclude?: string[]
}

/** Use when the consuming workspace needs its own local Vite config type for `viteFinal`. */
export interface TuiStorybookConfigOptionsWithViteFinal<
  TConfig extends object,
> extends TuiStorybookConfigOptions {
  /** Extension hook — runs after the factory transforms for custom overrides */
  viteFinal: StorybookViteFinal<TConfig>
}

const opentuiStubPath = new URL('../opentui-stub.ts', import.meta.url).pathname

/** Apply shared Vite config: server binding and file-watch policy. */
const applySharedConfig = (config: InlineConfig): void => {
  config.server = {
    ...config.server,
    host: '0.0.0.0',
    allowedHosts: true,
    /* Workaround: fsevents 2.3.3 pre-built native binary silently fails to deliver
     * file-change events on macOS 26+, breaking Vite/Storybook HMR.
     * Falls back to Node.js fs.watch (kqueue-based, event-driven — not polling).
     *
     * Root cause: https://github.com/fsevents/fsevents/issues/406
     * Vite is stuck on chokidar v3 (which bundles fsevents) because chokidar v4
     * causes EBADF on macOS: https://github.com/vitejs/vite/issues/18527
     * Upstream tracker for @parcel/watcher alternative: https://github.com/vitejs/vite/issues/13593 */
    watch: { ...config.server?.watch, useFsEvents: false },
  }
}

const callUserViteFinal = async <TConfig extends object>({
  config,
  viteFinal,
}: {
  config: InlineConfig
  viteFinal: StorybookViteFinal<TConfig> | undefined
}): Promise<InlineConfig> => {
  if (viteFinal === undefined) {
    return config
  }

  return (await viteFinal(config as TConfig)) as InlineConfig
}

type CreateDomStorybookConfig = {
  (options?: DomStorybookConfigOptions): StorybookConfig
  <TConfig extends object>(
    options: DomStorybookConfigOptionsWithViteFinal<TConfig>,
  ): StorybookConfig
}

/**
 * Create a Storybook config for browser-rendered React packages.
 *
 * @example
 * ```typescript
 * import { createDomStorybookConfig } from '@overeng/utils/node/storybook/config'
 * export default createDomStorybookConfig({})
 * ```
 */
export const createDomStorybookConfig: CreateDomStorybookConfig = <TConfig extends object>(
  options: DomStorybookConfigOptions & {
    viteFinal?: StorybookViteFinal<TConfig>
  } = {},
): StorybookConfig => {
  const {
    stories = ['../src/**/*.stories.@(ts|tsx)'],
    addons,
    disableMinify = false,
    a11y = false,
    viteFinal,
  } = options

  const resolvedAddons = a11y === true ? [...(addons ?? []), '@storybook/addon-a11y'] : addons

  const config = {
    stories,
    ...(resolvedAddons !== undefined ? { addons: resolvedAddons } : {}),
    framework: { name: '@storybook/react-vite', options: {} },
    viteFinal: async (storybookConfig) => {
      const typedConfig = storybookConfig as InlineConfig
      applySharedConfig(typedConfig)

      if (disableMinify === true && typedConfig.build !== undefined) {
        typedConfig.build.minify = false
      } else if (disableMinify === true) {
        typedConfig.build = { minify: false }
      }

      /* Returns the parameter's own contextual type rather than `InlineConfig`. A
       * cross-checkout `link:` consumer typechecks this source but resolves `vite`
       * from its OWN node_modules, so naming Vite's type here makes the returned
       * config a DIFFERENT `InlineConfig` than the `ViteFinal` slot expects. Under
       * `strict` that cannot be reconciled: `dev.createEnvironment` takes a
       * `ResolvedConfig`, so parameters compare contravariantly and the check
       * recurses Vite's whole type graph. Peer-version parity does not help — only
       * not naming the type across the boundary does. */
      return (await callUserViteFinal({ config: typedConfig, viteFinal })) as typeof storybookConfig
    },
  } satisfies StorybookConfig

  return config
}

type CreateTuiStorybookConfig = {
  (options?: TuiStorybookConfigOptions): StorybookConfig
  <TConfig extends object>(
    options: TuiStorybookConfigOptionsWithViteFinal<TConfig>,
  ): StorybookConfig
}

/**
 * Create a Storybook config for TUI (terminal UI) packages.
 *
 * Adds OpenTUI stubs, React deduplication, esnext target, and CJS pre-bundling workarounds.
 *
 * @example
 * ```typescript
 * import { createTuiStorybookConfig } from '@overeng/utils/node/storybook/config'
 * export default createTuiStorybookConfig({
 *   additionalOptimizeDepsInclude: ['@effect/cli > ini', '@effect/cli > toml'],
 * })
 * ```
 */
export const createTuiStorybookConfig: CreateTuiStorybookConfig = <TConfig extends object>(
  options: TuiStorybookConfigOptions & {
    viteFinal?: StorybookViteFinal<TConfig>
  } = {},
): StorybookConfig => {
  const {
    stories = ['../src/**/*.stories.@(ts|tsx)'],
    addons,
    additionalOptimizeDepsInclude = [],
    viteFinal,
  } = options

  const config = {
    stories,
    ...(addons !== undefined ? { addons } : {}),
    framework: { name: '@storybook/react-vite', options: {} },
    viteFinal: async (storybookConfig) => {
      const typedConfig = storybookConfig as InlineConfig
      applySharedConfig(typedConfig)

      typedConfig.build = {
        ...typedConfig.build,
        target: 'esnext',
        rolldownOptions: {
          ...typedConfig.build?.rolldownOptions,
          // eslint-disable-next-line overeng/named-args -- Rollup API callback signature
          onwarn: (warning, warn) => {
            if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return
            warn(warning)
          },
        },
      }

      typedConfig.resolve = {
        ...typedConfig.resolve,
        alias: {
          ...typedConfig.resolve?.alias,
          '@opentui/core': opentuiStubPath,
          '@opentui/react': opentuiStubPath,
        },
        dedupe: ['react', 'react-dom', 'react-reconciler'],
      }

      // WORKAROUND: Vite 7+ doesn't properly pre-bundle CJS dependencies of linked workspace
      // packages in dev mode, causing "require is not defined" errors in the browser.
      // Docs: https://vite.dev/guide/dep-pre-bundling#monorepos-and-linked-dependencies
      // Related: https://github.com/vitejs/vite/issues/10447
      typedConfig.optimizeDeps = {
        ...typedConfig.optimizeDeps,
        include: [
          ...(typedConfig.optimizeDeps?.include ?? []),
          'react-reconciler',
          'react-reconciler > scheduler',
          ...additionalOptimizeDepsInclude,
        ],
        exclude: [...(typedConfig.optimizeDeps?.exclude ?? []), '@opentui/core', '@opentui/react'],
      }

      typedConfig.ssr = {
        ...typedConfig.ssr,
        external: ['@opentui/core', '@opentui/react'],
      }

      /* See the DOM factory: returns the parameter's contextual type so Vite's
       * `InlineConfig` never crosses the package boundary. */
      return (await callUserViteFinal({ config: typedConfig, viteFinal })) as typeof storybookConfig
    },
  } satisfies StorybookConfig

  return config
}
