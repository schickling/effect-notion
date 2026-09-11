import { describe, expect, it } from 'vitest'

import { composeGateProjectAnnotations } from './project-annotations.ts'

/** Stand-ins for real project annotations; only their identity matters here. */
type Annotation = Record<string, unknown>

const preview: Annotation = { parameters: { layout: 'centered' } }
const gate: Annotation = { name: 'story-gate' }

describe('composeGateProjectAnnotations', () => {
  it('pins the theme under `initialGlobals`, the only key Storybook 10.6 reads', () => {
    const composed = composeGateProjectAnnotations({
      base: preview,
      initialGlobals: { theme: 'dark' },
      gate,
    })

    const globalsLayer = composed.find(
      (layer): layer is { initialGlobals: Record<string, unknown> } =>
        'initialGlobals' in layer === true,
    )
    expect(globalsLayer).toEqual({ initialGlobals: { theme: 'dark' } })
    // A `globals` key is silently ignored by Storybook, so every theme project
    // would render the preview default and the two themes would be identical.
    expect(composed.some((layer) => 'globals' in layer === true)).toBe(false)
  })

  it('carries a distinct configured value into each themed project', () => {
    const themes = [
      { name: 'theme', value: 'light' },
      { name: 'theme', value: 'dark' },
    ]

    const perProject = themes.map(
      (theme) =>
        composeGateProjectAnnotations({
          base: preview,
          initialGlobals: { [theme.name]: theme.value },
          gate,
        })[1],
    )

    expect(perProject).toEqual([
      { initialGlobals: { theme: 'light' } },
      { initialGlobals: { theme: 'dark' } },
    ])
    expect(new Set(perProject.map((layer) => JSON.stringify(layer))).size).toBe(2)
  })

  it('keeps the theme pin and the gate layer after the consumer preview', () => {
    const first: Annotation = { parameters: { a: 1 } }
    const second: Annotation = { parameters: { b: 2 } }

    expect(
      composeGateProjectAnnotations({
        base: [first, second],
        initialGlobals: { theme: 'dark' },
        gate,
      }),
    ).toEqual([first, second, { initialGlobals: { theme: 'dark' } }, gate])
  })

  it('normalizes a single base annotation into the stack', () => {
    expect(composeGateProjectAnnotations({ base: preview, initialGlobals: {}, gate })).toEqual([
      preview,
      { initialGlobals: {} },
      gate,
    ])
  })
})
