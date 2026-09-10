/** All jobs passing but branch is behind base — informational warning shown. */

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
  allPassingJobs,
  createAllPassingTimeline,
  createSingleRunState,
  loadingState,
  prHealthBehind,
} from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
}

export default {
  title: 'gh-ci-utils/Status/BranchBehind',
  component: CiView,
  argTypes: {
    ...commonArgTypes,
    playbackSpeed: {
      description: 'Playback speed',
      control: { type: 'range', min: 1, max: 100, step: 5 },
      if: { arg: 'interactive' },
    },
  },
  args: { ...defaultStoryArgs, playbackSpeed: 50 },
} satisfies Meta

type Story = StoryObj<StoryArgs>

export const BranchBehind: Story = {
  render: function Render(args) {
    return (
      <TuiStoryPreview
        View={CiView}
        app={CiApp}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command="gh-ci-utils status '#506'"
        {...createInteractiveProps({
          args,
          staticState: createSingleRunState({ jobs: allPassingJobs, prHealth: prHealthBehind }),
          idleState: loadingState(),
          createTimeline: () => createAllPassingTimeline(),
        })}
      />
    )
  },
}
