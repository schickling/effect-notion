/** Full lint log with 100+ lines including checkout, cachix push, and git cleanup (--full bypasses truncation). */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import {
  ALL_OUTPUT_TABS,
  TuiStoryPreview,
  commonArgTypes,
  createInteractiveProps,
  defaultStoryArgs,
} from '@overeng/tui-react/storybook'

import { LogsApp } from '../app.ts'
import { LogsView } from '../view.tsx'
import { createLongLogTimeline, loadingState, longLogState } from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  target: string
}

export default {
  title: 'gh-ci-utils/Logs/LongOutput',
  component: LogsView,
  argTypes: {
    ...commonArgTypes,
    target: {
      description: 'Target (run ID, #PR, branch, owner/repo, owner/repo#PR, owner/repo@branch)',
      control: 'text',
    },
    playbackSpeed: {
      description: 'Playback speed',
      control: { type: 'range', min: 1, max: 100, step: 5 },
      if: { arg: 'interactive' },
    },
  },
  args: { ...defaultStoryArgs, target: '', playbackSpeed: 50 },
} satisfies Meta

type Story = StoryObj<StoryArgs>

export const HundredPlusLines: Story = {
  render: function Render(args) {
    return (
      <TuiStoryPreview
        View={LogsView}
        app={LogsApp}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command={`gh-ci-utils logs${args.target ? ` ${args.target}` : ''} --job lint --full${args.interactive ? ' --watch' : ''}`}
        {...createInteractiveProps({
          args,
          staticState: longLogState(),
          idleState: loadingState(),
          createTimeline: () => createLongLogTimeline(),
        })}
      />
    )
  },
}
