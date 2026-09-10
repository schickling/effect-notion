/**
 * Vite plugin that turns Storybook CSF files into Vitest tests through the
 * framework's Portable Stories API.
 *
 * This deliberately owns only the headless gate integration. The Storybook UI
 * test panel remains the concern of `@storybook/addon-vitest`; the gate does not
 * need that manager surface, and depending on it would weld the whole workspace
 * to the addon's narrower Vitest peer range.
 *
 * @module
 */

import { relative, resolve, sep } from 'node:path'

import { getStoryTitle, normalizeStories } from 'storybook/internal/common'
import { StoryIndexGenerator, experimental_loadStorybook } from 'storybook/internal/core-server'
import type { Plugin, ViteUserConfig } from 'vitest/config'

import { initialGlobalsProvideKey } from './constants.ts'
import type { StoryGateTheme } from './project.ts'

const sourceQuery = 'overeng-story-gate-source'

/**
 * Give the composed module the title the story index would have given it.
 *
 * `composeStories` does not consult the index: `composeStory` falls back to
 * `componentAnnotations.title ?? 'ComposedStory'` and derives every story id
 * from it, so every CSF file that relies on Storybook's auto-title collapses
 * onto `composedstory--<export>`. Two untitled files exporting the same story
 * name then share one id — the screenshot baseline key AND the settle record
 * key — and the gate silently compares one story against another's baseline.
 * `@storybook/addon-vitest` avoids this by re-indexing through
 * `loadCsf({ makeTitle })`; the gate does not load that addon, so it stamps
 * the same computed title itself.
 *
 * An explicit `title` in the file still wins, exactly as in the real index.
 */
const portableTestModule = ({ id, title }: { id: string; title: string }): string => `
import { composeStories } from '@storybook/react-vite'
import { describe, test } from 'vitest'
import * as csf from ${JSON.stringify(`${id}?${sourceQuery}`)}

const indexedTitle = ${JSON.stringify(title)}
const meta = csf.default ?? {}
const indexed = { ...csf, default: { ...meta, title: meta.title ?? indexedTitle } }

const stories = Object.values(composeStories(indexed)).filter((story) =>
  story.tags.includes('test'),
)

if (stories.length === 0) {
  describe.skip('No valid tests found', () => {})
} else {
  for (const story of stories) {
    test(story.storyName, async () => {
      await story.run()
    })
  }
}
`

/**
 * The title the real story index would assign to each indexed CSF file.
 *
 * `getStoryTitle` normalizes the RAW specifiers itself, so this takes what
 * `presets.apply('stories', [])` returned rather than the normalized form, and
 * absolute file paths, because the implementation does
 * `relative(workingDir, storyFilePath)`.
 *
 * A file that the specifiers cannot title is a contradiction — it only reached
 * this list by matching one of them — so it fails closed instead of falling
 * back to a shared placeholder that would re-introduce the id collision.
 */
export const indexedStoryTitles = ({
  storyFiles,
  configDir,
  stories,
  workingDir,
}: {
  readonly storyFiles: readonly string[]
  readonly configDir: string
  readonly stories: Parameters<typeof getStoryTitle>[0]['stories']
  readonly workingDir: string
}): ReadonlyMap<string, string> =>
  new Map(
    storyFiles.map((storyFilePath) => {
      const title = getStoryTitle({ storyFilePath, configDir, stories, workingDir })
      if (title === undefined) {
        throw new Error(
          `[story-gate] no \`stories\` specifier titles ${storyFilePath}, yet the index matched it. Composed stories would all share the \`ComposedStory\` id and overwrite each other's baselines.`,
        )
      }
      return [storyFilePath, title]
    }),
  )

/**
 * Load the consumer's real Storybook Vite pipeline, then collect every indexed
 * CSF file as a Vitest browser test. Rendering and lifecycle execution go
 * through `composeStories(...).run()`, Storybook's documented external-runner
 * contract, rather than the version-coupled Vitest addon plugin.
 */
export const portableStoryTests = async ({
  configDir,
  theme,
}: {
  readonly configDir: string
  readonly theme: StoryGateTheme | undefined
}): Promise<Plugin[]> => {
  const root = process.cwd()
  const absoluteConfigDir = resolve(root, configDir)
  const { presets } = await experimental_loadStorybook({
    configDir: absoluteConfigDir,
    packageJson: {},
  })
  const stories = await presets.apply('stories', [])
  const normalizedStories = normalizeStories(stories, {
    configDir: absoluteConfigDir,
    workingDir: process.cwd(),
  })
  const matchingStoryFiles = await StoryIndexGenerator.findMatchingFilesForSpecifiers(
    normalizedStories,
    process.cwd(),
  )
  const storyFiles = StoryIndexGenerator.storyFileNames(
    new Map(matchingStoryFiles.map(([specifier, cache]) => [specifier, cache])),
  ).map((file) => resolve(file))
  const titleByStoryFile = indexedStoryTitles({
    storyFiles,
    configDir: absoluteConfigDir,
    stories,
    workingDir: root,
  })

  const [corePlugins, storybookViteConfig] = await Promise.all([
    presets.apply<Plugin[]>('viteCorePlugins', []),
    presets.apply<ViteUserConfig & { plugins?: Plugin[] }>('viteFinal', { root }),
  ])
  const { plugins: storybookPlugins = [], ...storybookConfig } = storybookViteConfig

  const gatePlugin: Plugin = {
    name: 'overeng-story-gate:portable-stories',
    async transformIndexHtml(html) {
      const [head, body] = await Promise.all([
        presets.apply<string | undefined>('previewHead'),
        presets.apply<string | undefined>('previewBody'),
      ])
      return html
        .replace('</head>', `${head ?? ''}</head>`)
        .replace('<body>', `<body>${body ?? ''}`)
    },
    config: () => ({
      ...storybookConfig,
      test: {
        ...storybookConfig.test,
        include: storyFiles.map((file) => relative(root, file).replaceAll(sep, '/')),
        provide: {
          ...storybookConfig.test?.provide,
          [initialGlobalsProvideKey]: theme === undefined ? {} : { [theme.name]: theme.value },
        },
      },
    }),
    transform: {
      // oxlint-disable-next-line overeng/named-args -- Vite's transform hook has a fixed positional signature.
      handler: (_code, rawId) => {
        const [id, query = ''] = rawId.split('?', 2)
        if (id === undefined || query.split('&').includes(sourceQuery) === true) return undefined
        const title = titleByStoryFile.get(resolve(id))
        if (title === undefined) return undefined
        return portableTestModule({ id, title })
      },
    },
  }

  return [...corePlugins, ...storybookPlugins, gatePlugin]
}
