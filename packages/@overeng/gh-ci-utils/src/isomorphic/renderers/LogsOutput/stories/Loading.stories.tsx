/** Initial loading state while fetching job logs. */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import {
  ALL_OUTPUT_TABS,
  TuiStoryPreview,
  commonArgTypes,
  defaultStoryArgs,
} from '@overeng/tui-react/storybook'

import { LogsApp } from '../app.ts'
import { LogsView } from '../view.tsx'
import { loadingState } from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  target: string
}

export default {
  title: 'gh-ci-utils/Logs/Loading',
  component: LogsView,
  argTypes: {
    ...commonArgTypes,
    target: {
      description: 'Target (run ID, #PR, branch, owner/repo, owner/repo#PR, owner/repo@branch)',
      control: 'text',
    },
  },
  args: {
    ...defaultStoryArgs,
    target: '',
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

export const FetchingLogs: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={LogsView}
      app={LogsApp}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command={`gh-ci-utils logs${args.target ? ` ${args.target}` : ''} --job lint`}
      initialState={loadingState()}
    />
  ),
}
