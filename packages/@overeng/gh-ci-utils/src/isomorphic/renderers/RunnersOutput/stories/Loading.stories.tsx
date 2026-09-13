/** Loading state while fetching runner status. */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import {
  ALL_OUTPUT_TABS,
  TuiStoryPreview,
  commonArgTypes,
  defaultStoryArgs,
} from '@overeng/tui-react/storybook'

import { RunnersApp } from '../app.ts'
import { RunnersView } from '../view.tsx'
import { loadingState } from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
}

export default {
  title: 'gh-ci-utils/Runners/Loading',
  component: RunnersView,
  argTypes: { ...commonArgTypes },
  args: { ...defaultStoryArgs },
} satisfies Meta

type Story = StoryObj<StoryArgs>

export const FetchingRunners: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={RunnersView}
      app={RunnersApp}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command="gh-ci-utils runners"
      initialState={loadingState()}
    />
  ),
}
