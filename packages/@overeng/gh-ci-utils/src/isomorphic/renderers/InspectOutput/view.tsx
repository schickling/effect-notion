/**
 * Inspect TUI view.
 *
 * The layout mirrors the JSON contract: the verdict first, then the two fact
 * groups it was derived from, so a reader can always see which source said
 * what — and, when nothing could be observed, that the GitHub facts survived.
 */
import type { Atom } from 'effect/unstable/reactivity'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import type { ApiMeta } from '../../lib/apiMeta.ts'
import { formatDuration } from '../../lib/format.ts'
import type {
  InspectAssessment,
  InspectDisposition,
  InspectGitHubFacts,
  InspectNamespaceFacts,
} from '../../lib/inspectFacts.ts'
import type { InspectState } from './schema.ts'

/** Props for the InspectView component */
export interface InspectViewProps {
  readonly stateAtom: Atom.Atom<InspectState>
}

/** TUI view rendering a single job's runner diagnosis */
export const InspectView = ({ stateAtom }: InspectViewProps) => {
  const state = useTuiAtomValue(stateAtom) as InspectState
  const symbols = useSymbols()

  if (state._tag === 'Loading') {
    return (
      <Box flexDirection="row">
        <Text color="blue">{symbols.status.circle}</Text>
        <Text> {state.message}</Text>
      </Box>
    )
  }

  if (state._tag === 'Error') {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color="red">{symbols.status.cross}</Text>
          <Text color="red" bold>
            {' '}
            Error: {state.error}
          </Text>
        </Box>
        <Text color="gray">{state.message}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <AssessmentSection assessment={state.assessment} />
      <Text> </Text>
      <GitHubSection github={state.github} />
      <Text> </Text>
      <NamespaceSection namespace={state.namespace} />
      <MetaFooter meta={state._meta} />
    </Box>
  )
}
const DISPOSITION_COLOR = {
  active: 'green',
  idle: 'blue',
  'resource-pressure': 'yellow',
  unknown: 'gray',
} as const satisfies Readonly<Record<InspectDisposition, string>>

const AssessmentSection = ({ assessment }: { readonly assessment: InspectAssessment }) => {
  const symbols = useSymbols()
  const color = DISPOSITION_COLOR[assessment.disposition]

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={color}>
          {assessment.disposition === 'unknown' ? symbols.status.circle : symbols.status.check}
        </Text>
        <Text> </Text>
        <Text color={color} bold>
          {assessment.disposition}
        </Text>
      </Box>
      {assessment.evidence.map((line) => (
        <Box key={line} flexDirection="row">
          <Text color="gray"> {symbols.status.dot} </Text>
          <Text>{line}</Text>
        </Box>
      ))}
      {assessment.limitations.map((line) => (
        <Box key={line} flexDirection="row">
          <Text color="yellow"> {symbols.status.warning} </Text>
          <Text color="gray">{line}</Text>
        </Box>
      ))}
    </Box>
  )
}

const GitHubSection = ({ github }: { readonly github: InspectGitHubFacts }) => (
  <Box flexDirection="column">
    <Text bold>github</Text>
    <Text color="gray">
      {' '}
      {github.repo} job {github.jobId} ({github.name}) in run {github.runId}
    </Text>
    <Text color="gray">
      {' '}
      {github.status}
      {github.conclusion === null ? '' : ` / ${github.conclusion}`} ·{' '}
      {formatDuration(github.durationSeconds)} · {github.steps.length} step(s)
    </Text>
    <Text color="gray">
      {' '}
      runner {github.runnerName ?? '(none assigned)'} · kind {github.runnerKind} · instance{' '}
      {github.runnerInstance ?? '—'}
    </Text>
  </Box>
)

const NamespaceSection = ({ namespace }: { readonly namespace: InspectNamespaceFacts }) => {
  if (namespace._tag === 'not-namespace-job') {
    return (
      <Box flexDirection="column">
        <Text bold>namespace</Text>
        <Text color="gray"> not a Namespace job ({namespace.runnerKind} runner); nsc not run</Text>
      </Box>
    )
  }

  if (namespace._tag === 'unavailable') {
    return (
      <Box flexDirection="column">
        <Text bold>namespace</Text>
        <Text color="gray">
          {' '}
          unavailable: {namespace.reason}
          {namespace.detail === null ? '' : ` — ${namespace.detail}`}
        </Text>
      </Box>
    )
  }

  const { job, usage } = namespace
  return (
    <Box flexDirection="column">
      <Text bold>namespace</Text>
      <Text color="gray">
        {' '}
        instance {job.instanceId} · {job.instanceStatus}
        {job.runnerName === null ? '' : ` · runner ${job.runnerName}`}
        {job.containerName === null ? '' : ` · container ${job.containerName}`}
      </Text>
      {usage._tag === 'sampled' ? (
        <Text color="gray">
          {' '}
          peak {(usage.sample.cpuMaxFraction * 100).toFixed(1)}% of {usage.sample.allocatedCpu} CPU
          · {(usage.sample.ramMaxFraction * 100).toFixed(1)}% of {usage.sample.allocatedRamGb} GB
          RAM
        </Text>
      ) : (
        <Text color="gray">
          {' '}
          usage {usage._tag === 'not-requested' ? 'not requested (--with-usage)' : usage.reason}
        </Text>
      )}
    </Box>
  )
}

const MetaFooter = ({ meta }: { readonly meta: ApiMeta }) =>
  meta.apiRequests > 0 ? (
    <Text color="gray">
      {meta.apiRequests} reqs · {meta.rateLimitRemaining}/{meta.rateLimitLimit} rate limit
    </Text>
  ) : null
