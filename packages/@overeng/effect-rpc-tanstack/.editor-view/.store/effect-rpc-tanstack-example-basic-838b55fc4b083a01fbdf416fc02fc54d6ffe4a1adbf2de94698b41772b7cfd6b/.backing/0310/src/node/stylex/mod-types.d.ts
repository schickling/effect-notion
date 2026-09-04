/**
 * Module specifier of the virtual stylesheet holding all compiled StyleX rules.
 *
 * Every build entry must import this exactly once. That single static import is
 * the whole eager-placement guarantee: the bundler then owns which asset the
 * rules land in, how it is hashed, whether it is minified, and whether it shows
 * up in the manifest.
 */
export declare const stylexVirtualCssId: 'virtual:overeng-stylex.css'

/** Options for {@link createStylexVitePlugins}. */
export interface StylexVitePluginsOptions {
  /** Packages that ship uncompiled StyleX source and must be compiled by us. */
  readonly externalPackages?: readonly string[]
  /**
   * Absolute paths of the build entries that should receive the virtual
   * stylesheet import. One per surface: the library/app entry, and the
   * Storybook preview when the package has stories.
   */
  readonly entries?: readonly string[]
}

/**
 * A bundler plugin, described by the only member every Vite and Rollup major
 * agrees on.
 *
 * Deliberately structural. Naming vite's own `Plugin` here would publish
 * effect-utils' bundler major as part of this package's contract: a consumer on
 * a different Vite major cannot accept the value at all, failing on internals
 * as incidental as `PluginContextMeta.rolldownVersion`. Since every other
 * member of a plugin is optional in both majors, one required `name` is enough
 * to remain assignable to `PluginOption` everywhere while imposing nothing.
 *
 * The implementation still builds precisely-typed vite plugins; only the
 * published signature is widened, and only outward.
 */
export interface StylexVitePlugin {
  name: string
}

/**
 * Shared StyleX Vite integration: compiled CSS enters the bundle as a virtual
 * CSS module in the module graph rather than by picking an emitted asset by
 * filename.
 */
export declare const createStylexVitePlugins: (
  options?: StylexVitePluginsOptions,
) => StylexVitePlugin[]
