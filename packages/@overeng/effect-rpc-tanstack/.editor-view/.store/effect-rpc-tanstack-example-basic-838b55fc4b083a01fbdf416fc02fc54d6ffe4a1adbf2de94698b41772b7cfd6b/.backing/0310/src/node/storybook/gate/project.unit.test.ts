import { beforeAll, describe, expect, it } from 'vitest'

import { baselineDirEnvVar, createStoryGateConfig } from './project.ts'

/**
 * These tests exist because of a defect that was invisible to every local
 * check: a consumer merging its plugins into the returned config got a working
 * gate with one theme and a gate that could not load a single story with two.
 *
 * The asymmetry is the whole bug. So each assertion is written against **both**
 * return shapes, and the one-theme case is not treated as the trivial case.
 */

const marker = { name: 'test-marker-plugin' }

/**
 * Stand-in for the Storybook plugin.
 *
 * The real one eagerly loads a Storybook config directory, which this package
 * does not have and should not need in order to check where plugins land.
 */
const fakeStorybookPluginFor = () => ({ name: 'fake-storybook-test' })

/** Read a `plugins` member without asserting a shape onto the value. */
const readPlugins = (value: unknown): unknown =>
  value !== null && typeof value === 'object' && 'plugins' in value ? value.plugins : undefined

/** Plugin names on a config or project, flattened — Vite accepts nested arrays. */
const pluginNames = (value: unknown): readonly string[] => {
  const plugins = readPlugins(value)
  if (Array.isArray(plugins) === false) return []

  const names: string[] = []
  for (const plugin of plugins.flat(Number.POSITIVE_INFINITY)) {
    if (plugin === null || typeof plugin !== 'object' || 'name' in plugin === false) continue
    const { name } = plugin
    if (typeof name === 'string') names.push(name)
  }
  return names
}

/** The projects array, or a thrown error naming what was found instead. */
const projectsOf = (config: unknown): readonly unknown[] => {
  const projects =
    config !== null && typeof config === 'object' && 'test' in config
      ? readProjects(config.test)
      : undefined
  if (Array.isArray(projects) === false) {
    throw new Error(`expected a projects array, got ${JSON.stringify(projects)}`)
  }
  return projects
}

const readProjects = (value: unknown): unknown =>
  value !== null && typeof value === 'object' && 'projects' in value ? value.projects : undefined

beforeAll(() => {
  process.env[baselineDirEnvVar] = '/tmp/story-gate-unit-test'
})

describe('createStoryGateConfig plugin threading', () => {
  it('puts caller plugins on the single project when there are no themes', () => {
    const config = createStoryGateConfig({
      plugins: [marker],
      storybookPluginFor: fakeStorybookPluginFor,
    })

    // No themes returns a bare project config rather than a projects array, so
    // the plugins belong at this level.
    expect(config.test?.projects).toBeUndefined()
    expect(pluginNames(config)).toContain(marker.name)
  })

  it('puts caller plugins on EVERY project when there are themes', () => {
    const config = createStoryGateConfig({
      themes: [
        { name: 'theme', value: 'light' },
        { name: 'theme', value: 'dark' },
      ],
      plugins: [marker],
      storybookPluginFor: fakeStorybookPluginFor,
    })

    const projects = projectsOf(config)
    expect(projects).toHaveLength(2)

    // The defect this guards: plugins reaching the root of a projects-shaped
    // config, where no project reads them. Asserting on the root would pass
    // while the gate loaded nothing, so the assertion has to be per project.
    for (const project of projects) {
      expect(pluginNames(project)).toContain(marker.name)
    }

    // And the root must NOT be where they live, or a future refactor could
    // satisfy the per-project assertion by duplicating them everywhere.
    expect(pluginNames(config)).not.toContain(marker.name)
  })

  it('orders caller plugins before the Storybook plugin', () => {
    // A compiler transform has to see the source before the Storybook plugin
    // turns it into a test module. Order is behaviour here, not style.
    const names = pluginNames(
      createStoryGateConfig({ plugins: [marker], storybookPluginFor: fakeStorybookPluginFor }),
    )

    const markerIndex = names.indexOf(marker.name)
    const storybookIndex = names.findIndex((name) => name.includes('storybook'))

    expect(markerIndex).toBeGreaterThanOrEqual(0)
    expect(storybookIndex).toBeGreaterThanOrEqual(0)
    expect(markerIndex).toBeLessThan(storybookIndex)
  })

  it('still builds both projects when no plugins are supplied', () => {
    // Negative control: the threading must not make `plugins` load-bearing for
    // consumers that need no transform, and an empty spread must not shift the
    // Storybook plugin out of the array.
    const projects = projectsOf(
      createStoryGateConfig({
        themes: [
          { name: 'theme', value: 'light' },
          { name: 'theme', value: 'dark' },
        ],
        storybookPluginFor: fakeStorybookPluginFor,
      }),
    )
    expect(projects).toHaveLength(2)

    for (const project of projects) {
      const names = pluginNames(project)
      expect(names.some((name) => name.includes('storybook'))).toBe(true)
      expect(names).not.toContain(marker.name)
    }
  })
})
