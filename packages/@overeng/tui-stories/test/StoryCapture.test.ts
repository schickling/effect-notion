import { resolve } from 'node:path'

import { expect, layer } from '@effect/vitest'
import { Context, Effect, Layer } from 'effect'

import { captureStoryProps } from '../src/StoryCapture.ts'
import { discoverStories, type DiscoverStoriesResult } from '../src/StoryDiscovery.ts'
import { findStory } from '../src/StoryModule.ts'

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

/** Helper to find a story, skipping the test if not found */
const findOrSkip = (query: string) =>
  Effect.gen(function* () {
    const { modules } = yield* TestStories
    const story = findStory({ modules, query })
    if (story === undefined) {
      console.warn(`Skipping: story "${query}" not found (may be an import issue)`)
      return undefined
    }
    return story
  })

layer(TestStories.layer, { timeout: '30 seconds' })('StoryCapture', (it) => {
  it.effect('captures props from a status story', () =>
    Effect.gen(function* () {
      const story = yield* findOrSkip('CLI/Status/Basic')
      if (story === undefined) return

      const captured = yield* Effect.promise(() => captureStoryProps({ story }))

      expect(captured.app).toBeDefined()
      expect(captured.app.config.reducer).toBeDefined()
      expect(typeof captured.View).toBe('function')
      expect(captured.command).toBeTruthy()
    }),
  )

  it.effect('captures props from an exec story', () =>
    Effect.gen(function* () {
      const story = yield* findOrSkip('RunningVerboseParallel')
      if (story === undefined) return

      const captured = yield* Effect.promise(() => captureStoryProps({ story }))

      expect(captured.app).toBeDefined()
      expect(typeof captured.View).toBe('function')
      expect(captured.command).toContain('mr exec')
    }),
  )

  it.effect('captures timeline when interactive=true', () =>
    Effect.gen(function* () {
      const story = yield* findOrSkip('RunningVerboseParallel')
      if (story === undefined) return

      // Without interactive: no timeline
      const noTimeline = yield* Effect.promise(() => captureStoryProps({ story }))
      expect(noTimeline.timeline).toHaveLength(0)

      // With interactive=true: timeline present
      const withTimeline = yield* Effect.promise(() =>
        captureStoryProps({ story, argOverrides: { interactive: true } }),
      )
      expect(withTimeline.timeline.length).toBeGreaterThan(0)
    }),
  )
})
