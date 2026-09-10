import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { toId } from 'storybook/internal/csf'
import { describe, expect, it } from 'vitest'

import { indexedStoryTitles } from './portable-stories.ts'

/**
 * Two CSF files with NO `title` in their meta and the SAME exported story
 * name. This is the shape that collides: `composeStory` falls back to the
 * literal `ComposedStory` title, so both files produce `composedstory--basic`.
 */
const workspaceWithTwoUntitledStories = (): {
  readonly workingDir: string
  readonly configDir: string
  readonly storyFiles: readonly string[]
} => {
  const workingDir = mkdtempSync(join(tmpdir(), 'story-gate-titles-'))
  const configDir = join(workingDir, '.storybook')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(join(workingDir, 'src', 'Alpha'), { recursive: true })
  mkdirSync(join(workingDir, 'src', 'Beta'), { recursive: true })
  const storyFiles = [
    join(workingDir, 'src', 'Alpha', 'Alpha.stories.tsx'),
    join(workingDir, 'src', 'Beta', 'Beta.stories.tsx'),
  ]
  for (const file of storyFiles) {
    writeFileSync(file, 'export default {}\nexport const Basic = {}\n')
  }
  return { workingDir, configDir, storyFiles }
}

const stories = ['../src/**/*.stories.@(ts|tsx)']

describe('indexedStoryTitles', () => {
  it('gives two untitled story files distinct indexed titles', () => {
    const { workingDir, configDir, storyFiles } = workspaceWithTwoUntitledStories()

    const titles = indexedStoryTitles({ storyFiles, configDir, stories, workingDir })

    expect([...titles.values()]).toEqual(['Alpha', 'Beta'])
  })

  it('keeps the ids two untitled files would otherwise share unique', () => {
    const { workingDir, configDir, storyFiles } = workspaceWithTwoUntitledStories()

    const titles = indexedStoryTitles({ storyFiles, configDir, stories, workingDir })
    const ids = storyFiles.map((file) => toId(titles.get(resolve(file))!, 'Basic'))

    // Without the stamped title both are `composedstory--basic`, and the
    // screenshot baseline plus the settle record of one story overwrite the
    // other's.
    expect(ids).toEqual(['alpha--basic', 'beta--basic'])
    expect(new Set(ids).size).toBe(2)
    expect(ids).not.toContain(toId('ComposedStory', 'Basic'))
  })

  it('fails closed when no specifier can title an indexed file', () => {
    const { workingDir, configDir } = workspaceWithTwoUntitledStories()
    const outside = join(workingDir, 'elsewhere', 'Gamma.stories.tsx')

    expect(() =>
      indexedStoryTitles({ storyFiles: [outside], configDir, stories, workingDir }),
    ).toThrow(/no `stories` specifier titles/)
  })
})
