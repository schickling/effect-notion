import { readFileSync } from 'node:fs'

import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { shouldNeverHappen } from '../../../isomorphic/core.ts'
import { createDomStorybookConfig } from './mod.ts'

const runViteFinal = async () => {
  const existingPlugin = { name: 'existing' }
  const viteFinal = createDomStorybookConfig({}).viteFinal

  if (viteFinal === undefined) {
    return shouldNeverHappen('Expected createDomStorybookConfig to define viteFinal')
  }

  const config = { plugins: [existingPlugin] } as Parameters<typeof viteFinal>[0]
  const options = {} as Parameters<typeof viteFinal>[1]
  const result = await viteFinal(config, options)

  return { existingPlugin, result }
}

Vitest.describe('createDomStorybookConfig', () => {
  // The factory used to be able to inject the StyleX plugin itself. It no
  // longer touches the plugin list at all: the Storybook builder merges the
  // package's own Vite config, which already registers it, and installing a
  // second instance produced byte-identical CSS — noise, not a defect.
  Vitest.it('leaves the plugin list to the merged app config', async () => {
    const { existingPlugin, result } = await runViteFinal()

    expect(result.plugins).toEqual([existingPlugin])
  })

  Vitest.it('registers the accessibility addon only when the gate asks for it', () => {
    expect({
      off: createDomStorybookConfig({}).addons,
      on: createDomStorybookConfig({ a11y: true }).addons,
    }).toEqual({ off: undefined, on: ['@storybook/addon-a11y'] })
  })

  /**
   * This module is exported as raw source, so a cross-checkout `link:` consumer
   * typechecks it while resolving `vite` from its OWN node_modules. If a default
   * `viteFinal` names Vite's `InlineConfig` in its return type, the value it
   * returns is a DIFFERENT `InlineConfig` than the consumer's `ViteFinal` slot
   * expects, and under `strict` the two cannot be reconciled: `dev.createEnvironment`
   * takes a `ResolvedConfig`, so parameters compare contravariantly and the check
   * recurses Vite's whole type graph. Aligning peer versions does not help.
   *
   * The guard is deliberately source-level. This defect is invisible to both other
   * kinds of test, which is how it reached a consumer in the first place:
   * - runtime: the fix is types-only, so before and after return the same value
   * - type-level: with one Vite copy in this tree, the correct and broken forms
   *   denote the SAME type, so any assertion passes either way
   *
   * Reproducing it needs two checkouts, which a unit test does not have. Asserting
   * the shape that cannot leak is what is left.
   */
  Vitest.it('keeps Vite types out of the default viteFinal return', () => {
    const source = readFileSync(new URL('./mod.ts', import.meta.url), 'utf8')
    const returns = [...source.matchAll(/^\s*return \(await callUserViteFinal\(([^\n]*)$/gmu)]

    expect({
      /* Both factories (DOM + TUI) must route through the boundary cast. */
      sites: returns.length,
      leaking: returns.filter((match) => match[1]?.includes('typeof storybookConfig') !== true)
        .length,
    }).toEqual({ sites: 2, leaking: 0 })
  })
})
