import type { Atom } from 'effect/unstable/reactivity'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import type { ApiMeta } from '../../lib/apiMeta.ts'
import type { MutationState } from './schema.ts'

/** Props for the MutationView component */
export interface MutationViewProps {
  readonly stateAtom: Atom.Atom<MutationState>
}

/** TUI view rendering a mutation operation result */
export const MutationView = ({ stateAtom }: MutationViewProps) => {
  const state = useTuiAtomValue(stateAtom) as MutationState
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
            {state.error}
          </Text>
        </Box>
        <Text color="gray">{state.message}</Text>
        <MetaFooter meta={state._meta} />
      </Box>
    )
  }

  if (state._tag === 'Dispatched') {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color="green">{symbols.status.check}</Text>
          <Text> {state.message}</Text>
        </Box>
        {state.url && <Text color="gray">{state.url}</Text>}
        <MetaFooter meta={state._meta} />
      </Box>
    )
  }

  if (state._tag === 'Done') {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color="green">{symbols.status.check}</Text>
          <Text> {state.message}</Text>
        </Box>
        <MetaFooter meta={state._meta} />
      </Box>
    )
  }

  /** Watching state — show job progress */
  const { conclusion } = state
  const statusColor = conclusion === 'failure' ? 'red' : conclusion === 'success' ? 'green' : 'blue'

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={statusColor}>{symbols.status.circle}</Text>
        <Text>
          {' '}
          Run {state.runId}: {state.status}
          {conclusion ? ` (${conclusion})` : ''}
        </Text>
      </Box>
      {state.jobs.map((job) => {
        const jobColor =
          job.conclusion === 'success'
            ? 'green'
            : job.conclusion === 'failure'
              ? 'red'
              : job.status === 'in_progress'
                ? 'blue'
                : 'gray'
        return (
          <Text key={job.name} color={jobColor}>
            {'  '}
            {(job.conclusion ?? job.status).padEnd(12)} {job.name}
            {job.runner ? ` [${job.runner}]` : ''}
          </Text>
        )
      })}
      <MetaFooter meta={state._meta} />
    </Box>
  )
}

const MetaFooter = ({ meta }: { readonly meta: ApiMeta }) =>
  meta.apiRequests > 0 ? (
    <Text color="gray">
      {meta.apiRequests} reqs · {meta.rateLimitRemaining}/{meta.rateLimitLimit} rate limit
    </Text>
  ) : null
