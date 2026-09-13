import type { Atom } from 'effect/unstable/reactivity'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import type { ApiMeta } from '../../lib/apiMeta.ts'
import type { LogsState, Truncation } from './schema.ts'

/** Props for the LogsView component */
export interface LogsViewProps {
  readonly stateAtom: Atom.Atom<LogsState>
}

/** Display a sole retained job/step verdict without replacing the workflow verdict used for exit. */
export const logsHeaderConclusion = (
  state: Extract<LogsState, { readonly _tag: 'Loaded' }>,
): string => (state.sections?.length === 1 ? state.sections[0]!.conclusion : state.conclusion)

/** TUI view rendering paginated log output */
export const LogsView = ({ stateAtom }: LogsViewProps) => {
  const state = useTuiAtomValue(stateAtom) as LogsState
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
        <MetaFooter meta={state._meta} />
      </Box>
    )
  }

  if (state._tag === 'NoLogs') {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color="gray">{symbols.status.circle}</Text>
          <Text color="gray"> {state.message}</Text>
        </Box>
        <MetaFooter meta={state._meta} />
      </Box>
    )
  }

  const headerConclusion = logsHeaderConclusion(state)
  const conclusionColor =
    headerConclusion === 'failure' ? 'red' : headerConclusion === 'success' ? 'green' : 'gray'

  const baseOffset = state.truncation?.offset ?? 0
  const keyedLines = state.lines.map((content, ord) => ({
    key: String(baseOffset + ord),
    content,
  }))

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text bold>{state.jobName}</Text>
        <Text color={conclusionColor}> ({headerConclusion})</Text>
      </Box>
      <Text> </Text>
      {state.notice === null ? null : <Text color="gray">{state.notice}</Text>}
      <TruncationNote truncation={state.truncation} position="above" />
      {keyedLines.map((entry) => (
        <Text key={entry.key}>{entry.content}</Text>
      ))}
      <TruncationNote truncation={state.truncation} position="below" />
      <MetaFooter meta={state._meta} />
    </Box>
  )
}

const TruncationNote = ({
  truncation,
  position,
}: {
  readonly truncation: Truncation | null
  readonly position: 'above' | 'below'
}) => {
  if (!truncation) return null
  const { totalLines, offset, pageSize } = truncation
  const linesAbove = totalLines - offset - pageSize
  const linesBelow = offset

  if (position === 'above' && linesAbove > 0) {
    const nextOffset = offset + pageSize
    return (
      <Text color="gray">
        {`\u2191 ${linesAbove} lines above (--offset ${nextOffset} for earlier, --full for all)`}
      </Text>
    )
  }

  if (position === 'below' && linesBelow > 0) {
    const prevOffset = Math.max(0, offset - pageSize)
    return (
      <Text color="gray">
        {`\u2193 ${linesBelow} lines below (--offset ${prevOffset} for later, --full for all)`}
      </Text>
    )
  }

  return null
}

const MetaFooter = ({ meta }: { readonly meta: ApiMeta }) =>
  meta.apiRequests > 0 ? (
    <Text color="gray">
      {meta.apiRequests} reqs · {meta.rateLimitRemaining}/{meta.rateLimitLimit} rate limit
    </Text>
  ) : null
