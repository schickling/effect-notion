/** All 12 jobs queued with no runners assigned yet. */

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
import { CiView } from '../view.tsx'
import {
  allQueuedJobs,
  createAllQueuedTimeline,
  createSingleRunState,
  loadingState,
} from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  target: string
  workflow: string
}

export default {
  title: 'gh-ci-utils/Status/AllQueued',
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

export const AllQueued: Story = {
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
          staticState: createSingleRunState({ jobs: allQueuedJobs }),
          idleState: loadingState(),
          createTimeline: () => createAllQueuedTimeline(),
        })}
      />
    )
  },
}
