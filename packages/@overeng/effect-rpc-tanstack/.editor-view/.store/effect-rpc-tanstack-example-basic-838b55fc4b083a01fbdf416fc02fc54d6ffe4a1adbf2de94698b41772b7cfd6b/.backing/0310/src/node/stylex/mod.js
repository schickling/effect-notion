import { unplugin as stylex } from '@stylexjs/unplugin'

/** @import { Plugin, ResolvedConfig } from 'vite' */

/**
 * Module specifier of the virtual stylesheet holding all compiled StyleX rules.
 *
 * Every build entry must import this exactly once. That single static import is
 * the whole eager-placement guarantee: the bundler then owns which asset the
 * rules land in, how it is hashed, whether it is minified, and whether it shows
 * up in the manifest.
 */
export const stylexVirtualCssId = 'virtual:overeng-stylex.css'

/** Rollup/Rolldown convention: `\0` marks an id as owned by a plugin. */
const resolvedStylexVirtualCssId = `\0${stylexVirtualCssId}`

/**
 * Content served for the virtual stylesheet while the graph is still being
 * built. Compiled rules are only complete once every module has been
 * transformed, which is strictly after this module is loaded, so the real CSS
 * is swapped in later (see `lateSwapCompiledCss`). Kept as a valid, inert rule
 * so CSS tooling in between never chokes on it.
 */
const pendingCssPlaceholder = '#--overeng-stylex--{compiled:pending}'

/** @param {string} id */
const stripQuery = (id) => id.split('?')[0] ?? id

/**
 * Vite's CSS pipeline keys everything on module id. `vite:css-post` records a
 * module's CSS during `transform` and concatenates it into the owning chunk's
 * asset later, so re-invoking that handler with the finished CSS replaces the
 * placeholder *inside the pipeline* rather than after it.
 *
 * The handler is deliberately re-typed with a loose `this`: we call it from
 * `renderChunk`, whose plugin context is a superset of what it actually uses
 * but not nominally the transform context.
 *
 * @param {Plugin | undefined} cssPostPlugin
 * @returns {((this: unknown, code: string, id: string) => unknown) | undefined}
 */
const getCssPostTransformHandler = (cssPostPlugin) => {
  const transform = cssPostPlugin?.transform
  if (transform === undefined) return undefined
  return /** @type {(this: unknown, code: string, id: string) => unknown} */ (
    /** @type {unknown} */ (typeof transform === 'function' ? transform : transform.handler)
  )
}

/**
 * @typedef {object} StylexVitePluginsOptions
 * @property {readonly string[]} [externalPackages]
 *   Packages that ship uncompiled StyleX source and must be compiled by us.
 * @property {boolean | { before?: readonly string[], after?: readonly string[], prefix?: string }} [useCSSLayers]
 *   Emit compiled rules into cascade layers. Defaults to OFF, and that default
 *   is load-bearing rather than conservative: unlayered StyleX beats a utility
 *   framework's layered utilities unconditionally, which is what lets converted
 *   code win during a migration without any ordering work. Turn it on only for
 *   a target that has left its utility framework AND whose global stylesheets
 *   are themselves layered — layered CSS loses to *any* unlayered CSS, so one
 *   unlayered global reset silently outranks every component rule it touches.
 *   Name those stylesheets' layers in `before` so the emitted `@layer` statement
 *   fixes the order by declaration instead of by stylesheet parse order.
 * @property {readonly string[]} [entries]
 *   Absolute paths of the build entries that should receive the virtual
 *   stylesheet import — one per surface: the library/app entry, and the
 *   Storybook preview when the package has stories. Only meaningful for
 *   builds; a test run that merely needs the compiler transform can omit it.
 */

/**
 * A bundler plugin, described by the only member every Vite and Rollup major
 * agrees on. Mirrors `StylexVitePlugin` in `./mod-types.d.ts`, which is what
 * consumers resolve; kept here so the emitted declarations widen the same way.
 *
 * Naming vite's own `Plugin` in the signature would publish effect-utils'
 * bundler major as part of this package's contract — a consumer on a different
 * Vite major could not accept the value at all.
 *
 * @typedef {{ name: string }} StylexVitePlugin

/**
 * Shared StyleX Vite integration.
 *
 * Compiled CSS enters the bundle as a virtual CSS module in the module graph
 * rather than by picking an emitted asset by filename. Upstream's build path
 * picks assets: it tries a caller-supplied predicate, then an unhashed
 * `index.css`, then an unhashed `style.css`, then silently falls back to the
 * *first* CSS asset and exits zero. On a route-chunked build that can strand
 * every rule in a lazily-loaded chunk while the build succeeds. Its two
 * asset-picking hooks are therefore dropped here and replaced.
 *
 * Upstream's dev path already uses a virtual module and is left untouched.
 *
 * @param {StylexVitePluginsOptions} [options]
 * @returns {StylexVitePlugin[]}
 */
export const createStylexVitePlugins = ({
  externalPackages = [],
  entries = [],
  useCSSLayers = false,
} = {}) => {
  const deduplicatedExternalPackages = [...new Set(['@overeng/stylex-tokens', ...externalPackages])]
  // `externalPackages` is supported at runtime (unplugin core destructures it)
  // but missing from @stylexjs/unplugin@0.19 UserOptions typings.
  const stylexOptions = /** @type {Parameters<typeof stylex.vite>[0]} */ ({
    externalPackages: deduplicatedExternalPackages,
    useCSSLayers,
  })

  const upstream = stylex.vite(stylexOptions)
  const collectCss = /** @type {{ __stylexCollectCss?: () => string }} */ (
    upstream
  ).__stylexCollectCss
  if (typeof collectCss !== 'function') {
    throw new Error(
      '[overeng:stylex] @stylexjs/unplugin no longer exposes `__stylexCollectCss`; the virtual-module injection path cannot read compiled rules.',
    )
  }

  const {
    generateBundle: _pickAssetInGenerateBundle,
    writeBundle: _appendToDisk,
    ...compiler
  } = upstream

  const entryIds = new Set(entries)

  /** @type {Plugin} */
  const injectEntryImport = {
    name: 'overeng:stylex:entry-import',
    apply: 'build',
    enforce: 'pre',
    resolveId: (id) => (id === stylexVirtualCssId ? resolvedStylexVirtualCssId : null),
    load: (id) =>
      id === resolvedStylexVirtualCssId
        ? { code: pendingCssPlaceholder, map: null, moduleSideEffects: true }
        : null,
    // Appended, not prepended. Import statements hoist, so this still runs
    // before the module body, but it sorts *after* the entry's own stylesheet
    // imports. That ordering is no longer what decides precedence now that the
    // rules are layered — the emitted `@layer` statement does that, and it does
    // it independently of parse order, which is the point of naming the reset
    // in `before`. Appending is kept anyway: a consumer of this factory may
    // still carry a utility framework — `useCSSLayers` defaults off for exactly
    // that reason — and there the unlayered-wins property does depend on the
    // entry's own stylesheets sorting first.
    // oxlint-disable-next-line overeng/named-args -- Vite's Plugin transform hook has a fixed positional signature.
    transform: (code, id) =>
      entryIds.has(stripQuery(id)) === true
        ? { code: `${code}\nimport ${JSON.stringify(stylexVirtualCssId)}\n`, map: null }
        : null,
  }

  /** @type {Plugin | undefined} */
  let cssPostPlugin
  let swapped = false

  /** @type {Plugin} */
  const lateSwapCompiledCss = {
    name: 'overeng:stylex:late-swap',
    apply: 'build',
    // Deliberately unenforced: normal-order plugins run before `post` ones, so
    // this lands ahead of `vite:css-post`'s own `renderChunk`.
    configResolved: (/** @type {ResolvedConfig} */ config) => {
      cssPostPlugin = config.plugins.find((plugin) => plugin.name === 'vite:css-post')
    },
    // oxlint-disable-next-line overeng/named-args -- Vite's Plugin renderChunk hook has a fixed positional signature.
    renderChunk: async function (_code, chunk) {
      const modules = /** @type {{ modules: Record<string, unknown> }} */ (chunk).modules
      if (Object.hasOwn(modules, resolvedStylexVirtualCssId) === false) {
        return null
      }

      const cssPostTransform = getCssPostTransformHandler(cssPostPlugin)
      if (cssPostTransform === undefined) {
        this.error(
          '[overeng:stylex] Vite `vite:css-post` plugin not found; compiled StyleX CSS cannot be placed in the bundle.',
        )
        return null
      }

      await cssPostTransform.call(this, collectCss(), resolvedStylexVirtualCssId)
      swapped = true
      return null
    },
    // Not the eager-placement guard deferred by decision 0009 — that one would
    // assert `viteMetadata.importedCss`. This only refuses to exit zero after
    // compiling rules that nothing in the bundle can reach.
    generateBundle: () => {
      if (swapped === true || collectCss() === '') return
      throw new Error(
        `[overeng:stylex] compiled StyleX rules exist but no chunk imported ${stylexVirtualCssId}, so they would be dropped from this build. Name the build entry in \`entries\`.`,
      )
    },
  }

  return [/** @type {Plugin} */ (compiler), injectEntryImport, lateSwapCompiledCss]
}
