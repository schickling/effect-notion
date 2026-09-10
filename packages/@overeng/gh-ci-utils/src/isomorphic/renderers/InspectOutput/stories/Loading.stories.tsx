/** Initial state while the job is being fetched. */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import {
  ALL_OUTPUT_TABS,
  TuiStoryPreview,
  commonArgTypes,
  defaultStoryArgs,
} from '@overeng/tui-react/storybook'

import { InspectApp } from '../app.ts'
import { InspectView } from '../view.tsx'
import { loadingState } from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
}

export default {
  title: 'gh-ci-utils/Inspect/Loading',
  component: InspectView,
  argTypes: { ...commonArgTypes },
  args: { ...defaultStoryArgs },
} satisfies Meta

type Story = StoryObj<StoryArgs>

export const Loading: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={InspectView}
      app={InspectApp}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command="gh-ci-utils inspect --job 69067527707"
      initialState={loadingState()}
    />
  ),
}
