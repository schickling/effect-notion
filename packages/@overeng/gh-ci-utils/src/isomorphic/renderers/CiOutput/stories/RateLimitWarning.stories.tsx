/** Successful run with rate limit warning annotation. */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import {
  ALL_OUTPUT_TABS,
  TuiStoryPreview,
  commonArgTypes,
  createInteractiveProps,
  defaultStoryArgs,
} from '@overeng/tui-react/storybook'

import type { AnnotationInfo } from '../../../lib/viewModels.ts'
import { CiApp } from '../app.ts'
import { CiView } from '../view.tsx'
import {
  allPassingJobs,
  createAllPassingTimeline,
  createSingleRunState,
  loadingState,
  makeAnnotation,
} from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  target: string
  workflow: string
}

export default {
  title: 'gh-ci-utils/Status/RateLimitWarning',
  component: CiView,
  argTypes: {
    ...commonArgTypes,
    playbackSpeed: {
      description: 'Playback speed',
      control: { type: 'range', min: 1, max: 100, step: 5 },
      if: { arg: 'interactive' },
    },
    target: {
      description: 'Target (run ID, #PR, branch, owner/repo, owner/repo#PR, owner/repo@branch)',
      control: 'text',
    },
    workflow: {
      description: 'Workflow file filter',
      control: 'text',
    },
  },
  args: { ...defaultStoryArgs, playbackSpeed: 50, target: '', workflow: 'ci.yml' },
} satisfies Meta

type Story = StoryObj<StoryArgs>

const rateLimitAnnotations: readonly AnnotationInfo[] = [
  makeAnnotation({
    jobName: 'flake-build',
    path: '.github/workflows/ci.yml',
    line: 1,
    message: 'GitHub API rate limit exceeded (5000/5000). Resets in 42 minutes.',
    title: 'Rate Limit Warning',
  }),
]

export const RateLimitWarning: Story = {
  render: function Render(args) {
    const annotations = useMemo(() => rateLimitAnnotations, [])

    return (
      <TuiStoryPreview
        View={CiView}
        app={CiApp}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command={`gh-ci-utils status${args.target ? ` ${args.target}` : ''}${args.workflow !== 'ci.yml' ? ` --workflow ${args.workflow}` : ''}${args.interactive ? ' --watch' : ''}`}
        {...createInteractiveProps({
          args,
          staticState: createSingleRunState({ jobs: allPassingJobs, errors: [], annotations }),
          idleState: loadingState(),
          createTimeline: () => createAllPassingTimeline(),
        })}
      />
    )
  },
}
