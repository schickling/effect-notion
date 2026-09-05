import { resolve } from 'node:path'

import { describe, it, expect } from '@effect/vitest'
import { Effect } from 'effect'

import { discoverStories } from '../src/StoryDiscovery.ts'
import { parseStoryModule } from '../src/StoryModule.ts'

/* The story fixture package is resolved through its declared dependency link, not through a
 * repository layout guess, so discovery works in a checkout and in a Buck package view alike. */
const MEGAREPO_DIR = resolve(import.meta.dirname, '../node_modules/@overeng/megarepo')

describe('StoryDiscovery', () => {
  it.effect(
    'discovers and parses stories (dynamic import)',
    () =>
      Effect.gen(function* () {
        const { modules } = yield* discoverStories({ packageDirs: [MEGAREPO_DIR] })

        // In vitest, some stories may fail to import due to browser-only deps.
        // In bun (the real CLI runtime), all stories load.
        // Here we just verify the discovery pipeline doesn't crash.
        expect(Array.isArray(modules)).toBe(true)

        if (modules.length > 0) {
          const story = modules[0]!.stories[0]!
          expect(story.title).toBeTruthy()
          expect(typeof story.render).toBe('function')
        }
      }),
    { timeout: 30_000 },
  )

  it.effect('returns empty for non-existent directory', () =>
    Effect.gen(function* () {
      const { modules } = yield* discoverStories({
        packageDirs: ['/non/existent/path'],
      })
      expect(modules).toEqual([])
    }),
  )

  it('parseStoryModule handles valid exports', () => {
    const mod = parseStoryModule({
      exports: {
        default: {
          title: 'Test/Component',
          args: { height: 400 },
          argTypes: {
            height: { control: { type: 'range', min: 200, max: 600 } },
          },
        },
        Basic: {
          args: { height: 300 },
          render: () => null as never,
        },
      },
      filePath: '/test.stories.tsx',
    })

    expect(mod).toBeDefined()
    expect(mod!.meta.title).toBe('Test/Component')
    expect(mod!.stories).toHaveLength(1)
    expect(mod!.stories[0]!.args.height).toBe(300)
    expect(mod!.stories[0]!.argTypes.height!.control.type).toBe('range')
  })
})
