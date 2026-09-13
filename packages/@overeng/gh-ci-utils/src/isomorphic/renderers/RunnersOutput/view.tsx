/** Runners TUI view — shows active jobs per host. */
import type { Atom } from 'effect/unstable/reactivity'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import type { ApiMeta } from '../../lib/apiMeta.ts'
import { formatDuration } from '../../lib/format.ts'
import type { HostResult, RunnersState } from './schema.ts'

/** Props for the RunnersView component */
export interface RunnersViewProps {
  readonly stateAtom: Atom.Atom<RunnersState>
}

/** TUI view rendering self-hosted runner status and active jobs */
export const RunnersView = ({ stateAtom }: RunnersViewProps) => {
  const state = useTuiAtomValue(stateAtom) as RunnersState
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

  const reachableHosts = state.hosts.filter((h) => h.status === 'reachable')
  const totalJobs = reachableHosts.reduce((sum, h) => sum + h.jobs.length, 0)

  return (
    <Box flexDirection="column">
      {state.hosts.map((host) => (
        <HostSection key={host.host} host={host} />
      ))}
      <Text> </Text>
      <Text color="gray">
        {totalJobs} active job(s) across {reachableHosts.length}/{state.hosts.length} host(s)
      </Text>
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

const HostSection = ({ host }: { readonly host: HostResult }) => {
  const symbols = useSymbols()

  if (host.status === 'unreachable') {
    return (
      <Box flexDirection="row">
        <Text color="red">{symbols.status.cross}</Text>
        <Text> </Text>
        <Text bold>{host.host}</Text>
        <Text color="red"> unreachable</Text>
      </Box>
    )
  }

  if (host.jobs.length === 0) {
    return (
      <Box flexDirection="row">
        <Text color="gray">{symbols.status.circle}</Text>
        <Text> </Text>
        <Text bold>{host.host}</Text>
        <Text color="gray"> idle</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color="green">{symbols.status.check}</Text>
        <Text> </Text>
        <Text bold>{host.host}</Text>
        <Text color="green"> {host.jobs.length} active job(s)</Text>
      </Box>
      {host.jobs.map((job) => (
        <Box key={job.runner} flexDirection="row">
          <Text> - </Text>
          <Text>{job.runner}</Text>
          <Text color="gray"> | {job.scaleSet}</Text>
          <Text color="gray"> | {formatDuration(job.durationSeconds)}</Text>
        </Box>
      ))}
    </Box>
  )
}
