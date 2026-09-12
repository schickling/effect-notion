/** A running job on a live Namespace instance: both sources agree. */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import {
  ALL_OUTPUT_TABS,
  TuiStoryPreview,
  commonArgTypes,
  createInteractiveProps,
  defaultStoryArgs,
} from '@overeng/tui-react/storybook'

import { InspectApp } from '../app.ts'
import { InspectView } from '../view.tsx'
import { activeState, createActiveTimeline, loadingState } from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
}

export default {
  title: 'gh-ci-utils/Inspect/Active',
  component: InspectView,
  argTypes: { ...commonArgTypes },
  args: { ...defaultStoryArgs },
} satisfies Meta

type Story = StoryObj<StoryArgs>

export const Active: Story = {
  render: function Render(args) {
    const state = useMemo(() => activeState(), [])

    return (
      <TuiStoryPreview
        View={InspectView}
        app={InspectApp}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command="gh-ci-utils inspect --job 1001 --with-usage"
        {...createInteractiveProps({
          args,
          staticState: state,
          idleState: loadingState(),
          createTimeline: () => createActiveTimeline(),
        })}
      />
    )
  },
}
