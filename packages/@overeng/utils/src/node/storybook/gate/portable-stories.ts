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

import { normalizeStories } from 'storybook/internal/common'
import { StoryIndexGenerator, experimental_loadStorybook } from 'storybook/internal/core-server'
import type { Plugin, ViteUserConfig } from 'vitest/config'

import { initialGlobalsProvideKey } from './constants.ts'
import type { StoryGateTheme } from './project.ts'

const sourceQuery = 'overeng-story-gate-source'

const portableTestModule = ({ id }: { id: string }): string => `
import { composeStories } from '@storybook/react-vite'
import { describe, test } from 'vitest'
import * as csf from ${JSON.stringify(`${id}?${sourceQuery}`)}

const stories = Object.values(composeStories(csf)).filter((story) => story.tags.includes('test'))

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
  const storyFileSet = new Set(storyFiles)

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
        if (
          id === undefined ||
          query.split('&').includes(sourceQuery) === true ||
          storyFileSet.has(resolve(id)) === false
        ) {
          return undefined
        }
        return portableTestModule({ id })
      },
    },
  }

  return [...corePlugins, ...storybookPlugins, gatePlugin]
}
