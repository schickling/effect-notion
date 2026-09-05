import { resolve } from 'node:path'

import { expect, layer } from '@effect/vitest'
import { Context, Effect, Layer, Schema } from 'effect'

import { captureStoryProps } from '../src/StoryCapture.ts'
import { discoverStories, type DiscoverStoriesResult } from '../src/StoryDiscovery.ts'
import { findStory } from '../src/StoryModule.ts'
import { renderStory } from '../src/StoryRenderer.ts'

/** Permissive JSON decode for asserting render output shape. */
const parseJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))

/* The story fixture package is resolved through its declared dependency link, not through a
 * repository layout guess, so discovery works in a checkout and in a Buck package view alike. */
const MEGAREPO_DIR = resolve(import.meta.dirname, '../node_modules/@overeng/megarepo')

/* Story discovery is slow on CI (glob + sequential imports due to Bun TDZ workaround
   can take >5s). Provide it as a layer so it runs once in beforeAll — independent of
   per-test timeouts — and is shared across all tests via dependency injection. */
class TestStories extends Context.Service<TestStories, DiscoverStoriesResult>()('TestStories') {
  static readonly layer = Layer.effect(
    TestStories,
    discoverStories({ packageDirs: [MEGAREPO_DIR] }),
  )
}

/** Helper to discover + find + capture a story */
const captureOrSkip = (query: string, overrides?: Record<string, unknown>) =>
  Effect.gen(function* () {
    const { modules } = yield* TestStories
    const story = findStory({ modules, query })
    if (story === undefined) {
      console.warn(`Skipping: story "${query}" not found`)
      return undefined
    }
    return yield* Effect.promise(() => captureStoryProps({ story, argOverrides: overrides }))
  })

layer(TestStories.layer, { timeout: '30 seconds' })('StoryRenderer', (it) => {
  it.effect('renders log mode (no colors, no ANSI)', () =>
    Effect.gen(function* () {
      const captured = yield* captureOrSkip('CLI/Status/Basic')
      if (captured === undefined) return

      const output = yield* renderStory({
        captured,
        width: 80,
        timelineMode: 'initial',
        output: 'log',
      })

      expect(output.length).toBeGreaterThan(0)
      expect(output).not.toContain('\x1b[')
    }),
  )

  it.effect('renders ci mode (with ANSI colors)', () =>
    Effect.gen(function* () {
      const captured = yield* captureOrSkip('CLI/Status/Basic')
      if (captured === undefined) return

      const output = yield* renderStory({
        captured,
        width: 80,
        timelineMode: 'initial',
        output: 'ci',
      })

      expect(output.length).toBeGreaterThan(0)
      expect(output).toContain('\x1b[')
    }),
  )

  it.effect('renders ci-plain mode (no colors)', () =>
    Effect.gen(function* () {
      const captured = yield* captureOrSkip('CLI/Status/Basic')
      if (captured === undefined) return

      const output = yield* renderStory({
        captured,
        width: 80,
        timelineMode: 'initial',
        output: 'ci-plain',
      })

      expect(output.length).toBeGreaterThan(0)
      expect(output).not.toContain('\x1b[')
    }),
  )

  it.effect('renders json mode (state as JSON)', () =>
    Effect.gen(function* () {
      const captured = yield* captureOrSkip('CLI/Status/Basic')
      if (captured === undefined) return

      const output = yield* renderStory({
        captured,
        width: 80,
        timelineMode: 'initial',
        output: 'json',
      })

      const parsed = parseJson(output)
      expect(parsed).toBeDefined()
      expect(typeof parsed).toBe('object')
    }),
  )

  it.effect('renders ndjson mode (timeline as JSON lines)', () =>
    Effect.gen(function* () {
      const captured = yield* captureOrSkip('CLI/Add/Results/AddDefault', {
        interactive: true,
      })
      if (captured === undefined) return

      const output = yield* renderStory({
        captured,
        width: 80,
        timelineMode: 'initial',
        output: 'ndjson',
      })

      const lines = output.split('\n').filter((l) => l.length > 0)
      expect(lines.length).toBeGreaterThan(1)

      for (const line of lines) {
        const parsed = parseJson(line)
        expect(parsed).toHaveProperty('at')
        expect(parsed).toHaveProperty('state')
      }
    }),
  )

  it.effect('applies timeline to final state', () =>
    Effect.gen(function* () {
      const captured = yield* captureOrSkip('CLI/Add/Results/AddDefault', {
        interactive: true,
      })
      if (captured === undefined) return

      const initial = yield* renderStory({
        captured,
        width: 80,
        timelineMode: 'initial',
        output: 'log',
      })

      const final = yield* renderStory({
        captured,
        width: 80,
        timelineMode: 'final',
        output: 'log',
      })

      expect(final).not.toBe(initial)
    }),
  )

  it.effect('respects width option', () =>
    Effect.gen(function* () {
      const captured = yield* captureOrSkip('CLI/Status/Basic')
      if (captured === undefined) return

      const narrow = yield* renderStory({
        captured,
        width: 40,
        timelineMode: 'initial',
        output: 'log',
      })

      const wide = yield* renderStory({
        captured,
        width: 120,
        timelineMode: 'initial',
        output: 'log',
      })

      expect(narrow.length).toBeGreaterThan(0)
      expect(wide.length).toBeGreaterThan(0)
    }),
  )
})
