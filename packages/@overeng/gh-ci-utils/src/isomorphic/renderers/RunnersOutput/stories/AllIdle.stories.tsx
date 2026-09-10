/** All hosts reachable but no active jobs. */

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
import { allIdleState, createAllIdleTimeline, loadingState } from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
}

export default {
  title: 'gh-ci-utils/Runners/AllIdle',
  component: RunnersView,
  argTypes: { ...commonArgTypes },
  args: { ...defaultStoryArgs },
} satisfies Meta

type Story = StoryObj<StoryArgs>

export const AllIdle: Story = {
  render: function Render(args) {
    const state = useMemo(() => allIdleState(), [])

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
          createTimeline: () => createAllIdleTimeline(),
        })}
      />
    )
  },
}
