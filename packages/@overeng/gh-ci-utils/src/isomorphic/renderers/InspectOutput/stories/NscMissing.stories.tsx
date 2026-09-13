/** No `nsc` on the machine: GitHub facts survive, the verdict degrades to unknown. */

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
import { createNscMissingTimeline, loadingState, nscMissingState } from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
}

export default {
  title: 'gh-ci-utils/Inspect/NscMissing',
  component: InspectView,
  argTypes: { ...commonArgTypes },
  args: { ...defaultStoryArgs },
} satisfies Meta

type Story = StoryObj<StoryArgs>

export const NscMissing: Story = {
  render: function Render(args) {
    const state = useMemo(() => nscMissingState(), [])

    return (
      <TuiStoryPreview
        View={InspectView}
        app={InspectApp}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command="gh-ci-utils inspect --job 1001"
        {...createInteractiveProps({
          args,
          staticState: state,
          idleState: loadingState(),
          createTimeline: () => createNscMissingTimeline(),
        })}
      />
    )
  },
}
