/** Static loading state. */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import {
  ALL_OUTPUT_TABS,
  TuiStoryPreview,
  commonArgTypes,
  createInteractiveProps,
  defaultStoryArgs,
} from '@overeng/tui-react/storybook'

import { CiApp } from '../app.ts'
import type { CiAction } from '../schema.ts'
import { CiView } from '../view.tsx'
import { loadingState } from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  target: string
  workflow: string
}

export default {
  title: 'gh-ci-utils/Status/Loading',
  component: CiView,
  argTypes: {
    ...commonArgTypes,
    playbackSpeed: {
      description: 'Playback speed',
      control: { type: 'range', min: 1, max: 100, step: 5 },
      if: { arg: 'interactive' },
    },
    target: {
      description: 'Target (run ID, #PR, branch, owner/repo, owner/repo#PR, owner/repo@branch)',
      control: 'text',
    },
    workflow: {
      description: 'Workflow file filter',
      control: 'text',
    },
  },
  args: { ...defaultStoryArgs, playbackSpeed: 50, target: '', workflow: 'ci.yml' },
} satisfies Meta

type Story = StoryObj<StoryArgs>

export const Loading: Story = {
  render: function Render(args) {
    return (
      <TuiStoryPreview
        View={CiView}
        app={CiApp}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command={`gh-ci-utils status${args.target ? ` ${args.target}` : ''}${args.workflow !== 'ci.yml' ? ` --workflow ${args.workflow}` : ''}${args.interactive ? ' --watch' : ''}`}
        {...createInteractiveProps({
          args,
          staticState: loadingState(),
          idleState: loadingState(),
          createTimeline: (): Array<{ at: number; action: CiAction }> => [],
        })}
      />
    )
  },
}
