/** All 3 hosts reachable with multiple active jobs per host. */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import {
  ALL_OUTPUT_TABS,
  TuiStoryPreview,
  commonArgTypes,
  createInteractiveProps,
  defaultStoryArgs,
} from '@overeng/tui-react/storybook'

import { RunnersApp } from '../app.ts'
import { RunnersView } from '../view.tsx'
import { allActiveState, createAllActiveTimeline, loadingState } from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
}

export default {
  title: 'gh-ci-utils/Runners/AllActive',
  component: RunnersView,
  argTypes: { ...commonArgTypes },
  args: { ...defaultStoryArgs },
} satisfies Meta

type Story = StoryObj<StoryArgs>

export const AllActive: Story = {
  render: function Render(args) {
    const state = useMemo(() => allActiveState(), [])

    return (
      <TuiStoryPreview
        View={RunnersView}
        app={RunnersApp}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command="gh-ci-utils runners"
        {...createInteractiveProps({
          args,
          staticState: state,
          idleState: loadingState(),
          createTimeline: () => createAllActiveTimeline(),
        })}
      />
    )
  },
}
