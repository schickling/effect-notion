import { readFileSync } from 'node:fs'

import type { Plugin } from 'vite'
import { describe, expect, it } from 'vitest'

import type { StylexVitePlugin, StylexVitePluginsOptions } from './mod-types.d.ts'
import { createStylexVitePlugins, stylexVirtualCssId } from './mod.js'

/**
 * These tests are an in-repo consumer on the same Vite major as the
 * implementation, so unlike a published consumer they may look at the hooks the
 * structural return type deliberately hides.
 */
const createInternal = (options?: StylexVitePluginsOptions): Plugin[] =>
  createStylexVitePlugins(options) as unknown as Plugin[]

describe('createStylexVitePlugins', () => {
  it('drops the upstream asset-picking hooks', () => {
    const [compiler] = createInternal()

    // These two are the defect: `generateBundle` picks an emitted CSS asset by
    // filename and `writeBundle` appends to disk when nothing matched. Both
    // exit zero on a miss, which is how compiled CSS gets stranded in a lazy
    // chunk with a successful build.
    expect({
      name: compiler?.name,
      generateBundle: compiler?.generateBundle,
      writeBundle: compiler?.writeBundle,
    }).toEqual({
      name: '@stylexjs/unplugin',
      generateBundle: undefined,
      writeBundle: undefined,
    })
  })

  it('keeps the compiler transform that collects rules', () => {
    const [compiler] = createInternal()

    expect(typeof compiler?.transform).toBe('function')
  })

  it('appends the virtual stylesheet import to named entries only', async () => {
    const entry = '/repo/src/entry.tsx'
    const plugins = createInternal({ entries: [entry] })
    const injector = plugins.find((plugin) => plugin.name === 'overeng:stylex:entry-import')
    const transform =
      typeof injector?.transform === 'function' ? injector.transform : injector?.transform?.handler

    const onEntry = await transform?.call({} as never, 'export const a = 1', entry)
    const onOther = await transform?.call({} as never, 'export const b = 2', '/repo/src/other.tsx')

    expect({ onEntry, onOther }).toEqual({
      // Appended rather than prepended: imports hoist, so this still runs before
      // the module body, but sorts after the entry's own stylesheet imports.
      onEntry: { code: `export const a = 1\nimport "${stylexVirtualCssId}"\n`, map: null },
      onOther: null,
    })
  })

  it('resolves and loads the virtual stylesheet as a side-effectful CSS module', () => {
    const plugins = createInternal({ entries: ['/repo/src/entry.tsx'] })
    const injector = plugins.find((plugin) => plugin.name === 'overeng:stylex:entry-import')
    const resolveId =
      typeof injector?.resolveId === 'function' ? injector.resolveId : injector?.resolveId?.handler
    const load = typeof injector?.load === 'function' ? injector.load : injector?.load?.handler

    const resolved = resolveId?.call({} as never, stylexVirtualCssId, undefined, {} as never)
    const loaded = load?.call({} as never, resolved as string)

    expect({
      resolved,
      moduleSideEffects:
        typeof loaded === 'object' && loaded !== null && 'moduleSideEffects' in loaded
          ? loaded.moduleSideEffects
          : undefined,
    }).toEqual({ resolved: `\0${stylexVirtualCssId}`, moduleSideEffects: true })
  })

  // Two guards, because the failure they protect against is silent and neither
  // catches it alone. A nominal bundler type in this signature forces every
  // consumer onto effect-utils' Vite major: a consumer on another major then
  // fails `tsc` on internals as incidental as
  // `PluginContextMeta.rolldownVersion`.
  it('publishes a plugin type with no members beyond name', () => {
    // The annotation is the assertion — it stops compiling the moment the
    // published element type grows a hook surface.
    const publishedSurface: (keyof StylexVitePlugin)[] = ['name']

    expect(publishedSurface).toEqual(['name'])
  })

  it('never names a bundler type in the published signature', () => {
    // Assignability cannot tell the two apart, because every plugin member
    // other than `name` is optional in both directions, and a type-level guard
    // silently degrades to `any` if the bundler types fail to resolve. So this
    // one reads the source: the published declaration and the JSDoc the emitted
    // `.d.ts` is generated from must both stay free of `vite`.
    const declaration = readFileSync(new URL('./mod-types.d.ts', import.meta.url), 'utf8')
    const implementation = readFileSync(new URL('./mod.js', import.meta.url), 'utf8')

    expect({
      declarationImportsVite: declaration.includes(`from 'vite'`),
      returnsStructuralType: implementation.includes('@returns {StylexVitePlugin[]}'),
    }).toEqual({ declarationImportsVite: false, returnsStructuralType: true })
  })
})
