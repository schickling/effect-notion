/** Failed job with truncation — shows "lines above" note and pagination hint. */

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
import { failedTruncatedState } from './_fixtures.ts'

type StoryArgs = {
  height: number
}

export default {
  title: 'gh-ci-utils/Logs/Truncated',
  component: LogsView,
  argTypes: commonArgTypes,
  args: defaultStoryArgs,
} satisfies Meta

type Story = StoryObj<StoryArgs>

const TypedTuiStoryPreview = TuiStoryPreview as any

export const TruncatedWithPaginationHint: Story = {
  render: function Render(args) {
    return (
      <TypedTuiStoryPreview
        View={LogsView}
        app={LogsApp}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command="gh-ci-utils logs --job flake-build"
        staticState={failedTruncatedState()}
      />
    )
  },
}
