/** Unified CI TUI view — problems-first layout with detail drilling. */
import type { Atom } from 'effect/unstable/reactivity'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import type { ApiMeta } from '../../lib/apiMeta.ts'
import { formatDuration } from '../../lib/format.ts'
import { isBlockingConclusion } from '../../lib/summary.ts'
import type {
  AnnotationInfo,
  JobError,
  Summary,
  WarningItem,
  WorkflowJobVM,
} from '../../lib/viewModels.ts'
import { lookupRunnerHost, type CiState, type RunInfo, type RunnerHostMap } from './schema.ts'

/** Props for the CiView component */
export interface CiViewProps {
  readonly stateAtom: Atom.Atom<CiState>
}

/** TUI view rendering CI run status, jobs, and steps */
export const CiView = ({ stateAtom }: CiViewProps) => {
  const state = useTuiAtomValue(stateAtom) as CiState
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
    <LoadedView
      run={state.run}
      jobs={state.jobs}
      errors={state.errors}
      annotations={state.annotations}
      runnerHostMap={state.runnerHostMap}
      summary={state.summary}
      _meta={state._meta}
    />
  )
}

// =============================================================================
// Loaded View
// =============================================================================

const LoadedView = ({
  run,
  jobs,
  errors,
  annotations,
  runnerHostMap,
  summary,
  _meta,
}: {
  readonly run: RunInfo
  readonly jobs: readonly WorkflowJobVM[]
  readonly errors: readonly JobError[]
  readonly annotations: readonly AnnotationInfo[]
  readonly runnerHostMap: RunnerHostMap
  readonly summary: Summary
  readonly _meta: ApiMeta
}) => {
  const failedJobs = jobs.filter((j) => isBlockingConclusion(j.conclusion))
  const failedCount = failedJobs.length
  const passedCount = jobs.filter((j) => j.conclusion === 'success').length
  const queuedCount = jobs.filter((j) => j.status === 'queued' || j.status === 'waiting').length
  const inProgressCount = jobs.filter((j) => j.status === 'in_progress').length

  const repoFromUrl = run.htmlUrl.match(/github\.com\/([^/]+\/[^/]+)/)?.[1] ?? ''
  const branch = run.headBranch ?? ''
  const truncatedBranch = branch.length > 25 ? `${branch.slice(0, 22)}...` : branch

  return (
    <Box flexDirection="column">
      {failedJobs.length > 0 && (
        <CriticalSection failedJobs={failedJobs} run={run} runnerHostMap={runnerHostMap} />
      )}
      {(summary.overallStatus === 'no_checks' || summary.overallStatus === 'skipped') && (
        <InconclusiveSection overallStatus={summary.overallStatus} />
      )}
      {summary.warnings.length > 0 && <WarningsSection warnings={summary.warnings} />}
      <Box flexDirection="row">
        <Text bold>{repoFromUrl}</Text>
        <Text> </Text>
        <Text color="gray" href={run.htmlUrl}>
          #{run.runNumber}
        </Text>
        <Text color="gray"> {truncatedBranch}</Text>
      </Box>
      <Text color="gray">
        {' '}
        {run.workflowPath.replace('.github/workflows/', '')} on: {run.event}
      </Text>
      <Text> </Text>
      <JobTableHeader />
      {jobs.map((job) => (
        <JobRow key={job.id} job={job} runnerHostMap={runnerHostMap} />
      ))}
      {(errors.length > 0 || annotations.length > 0) && (
        <>
          <Text> </Text>
          <Text color="red" bold>
            ERRORS
          </Text>
          <Text> </Text>
        </>
      )}
      {errors.map((err, ord) => (
        // eslint-disable-next-line react/no-array-index-key -- duplicate upstream errors have no stable identity
        <ErrorBlock key={`${err.jobName}-${err.stepName}-${ord}`} error={err} />
      ))}
      {annotations.length > 0 && <AnnotationsBlock annotations={annotations} />}
      <Text> </Text>
      <Text color="gray">
        {jobs.length} jobs{failedCount > 0 ? ` · ${failedCount} failed` : ''}
        {queuedCount > 0 ? ` · ${queuedCount} queued` : ''}
        {inProgressCount > 0 ? ` · ${inProgressCount} running` : ''}
        {passedCount > 0 ? ` · ${passedCount} passed` : ''}
      </Text>
      <MetaFooter meta={_meta} />
    </Box>
  )
}

// =============================================================================
// Shared Components
// =============================================================================

const CriticalSection = ({
  failedJobs,
  run,
  runnerHostMap,
}: {
  readonly failedJobs: readonly WorkflowJobVM[]
  readonly run: RunInfo
  readonly runnerHostMap: RunnerHostMap
}) => {
  const symbols = useSymbols()

  return (
    <>
      <Text color="red" bold>
        {' '}
        CRITICAL
      </Text>
      <Text> </Text>
      <Box flexDirection="column">
        {failedJobs.map((job) => {
          const runner = resolveRunnerDisplay({ runner: job.runner, runnerHostMap })
          return (
            <Box key={job.id} flexDirection="column">
              <Box flexDirection="row">
                <Text color="red">{symbols.status.cross}</Text>
                <Text> </Text>
                <Text bold>{job.name}</Text>
                <Text color="red"> failed</Text>
                <Text color="gray"> {formatDuration(job.durationSeconds)}</Text>
                <Text color="gray"> {runner}</Text>
              </Box>
              {job.failedStepName && <Text color="gray"> step: "{job.failedStepName}"</Text>}
              <Text color="gray">
                {' '}
                fix: gh-ci-utils logs {run.id} --job {job.id}
              </Text>
            </Box>
          )
        })}
        <Text> </Text>
      </Box>
      <Text color="gray">{'─'.repeat(40)}</Text>
      <Text> </Text>
    </>
  )
}

/**
 * Verdict banner for the states where nothing authoritative ran for the commit
 * under review. Without it the job table reads as a green run.
 */
const InconclusiveSection = ({
  overallStatus,
}: {
  readonly overallStatus: 'no_checks' | 'skipped'
}) => {
  const symbols = useSymbols()

  return (
    <>
      <Box flexDirection="row">
        <Text color="yellow">{symbols.status.circle}</Text>
        <Text color="yellow" bold>
          {' '}
          {overallStatus === 'no_checks' ? 'NO CHECKS' : 'SKIPPED'}
        </Text>
        <Text color="gray">
          {overallStatus === 'no_checks'
            ? ' — no authoritative run for the commit under review'
            : ' — every job was skipped'}
        </Text>
      </Box>
      <Text> </Text>
    </>
  )
}

/** One-line phrasing for each warning the verdict attached. */
const warningText = (warning: WarningItem): string => {
  switch (warning._tag) {
    case 'MergeConflicts':
      return `PR #${warning.prNumber} has merge conflicts`
    case 'BranchBehind':
      return `Branch is ${warning.behindBy} commit${warning.behindBy > 1 ? 's' : ''} behind ${warning.baseRefName}`
    case 'ExpectedWorkflowMissing':
      return `${warning.workflow} has no run for ${
        warning.headSha === null ? 'this commit' : warning.headSha.slice(0, 7)
      } — inspecting ${warning.inspectedWorkflowPath} instead`
    case 'StaleRun':
      return `Run describes ${warning.runHeadSha.slice(0, 7)}, not the commit under review ${warning.expectedHeadSha.slice(0, 7)}`
  }
}

const WarningsSection = ({ warnings }: { readonly warnings: readonly WarningItem[] }) => {
  const symbols = useSymbols()

  return (
    <>
      <Text color="yellow" bold>
        {' '}
        WARNINGS
      </Text>
      <Text> </Text>
      {warnings.map((warning) => (
        <Box key={warning._tag} flexDirection="row">
          <Text color={warning._tag === 'MergeConflicts' ? 'red' : 'yellow'}>
            {warning._tag === 'MergeConflicts' ? symbols.status.cross : symbols.status.circle}
          </Text>
          <Text> {warningText(warning)}</Text>
        </Box>
      ))}
      <Text> </Text>
      <Text color="gray">{'─'.repeat(40)}</Text>
      <Text> </Text>
    </>
  )
}

const JOB_NAME_WIDTH = 30
const STATUS_WIDTH = 12
const ID_WIDTH = 12

const COL_GAP = '  '

const JobTableHeader = () => (
  <Box flexDirection="row">
    <Text color="gray">
      {'  '}
      {'JOB'.padEnd(JOB_NAME_WIDTH)}
      {COL_GAP}
      {'STATUS'.padEnd(STATUS_WIDTH)}
      {COL_GAP}
      {'DURATION'.padStart(8)}
      {COL_GAP}
      {'ID'.padEnd(ID_WIDTH)}
      {COL_GAP}
      {'RUNNER'}
    </Text>
  </Box>
)

const JobRow = ({
  job,
  runnerHostMap,
}: {
  readonly job: WorkflowJobVM
  readonly runnerHostMap: RunnerHostMap
}) => {
  const symbols = useSymbols()

  const { symbol, color } = getJobSymbol({ job, symbols })
  const statusText = job.conclusion ?? job.status
  const duration = formatDuration(job.durationSeconds)
  const runner = resolveRunnerDisplay({ runner: job.runner, runnerHostMap })
  const jobId = String(job.id)

  return (
    <Box flexDirection="row">
      <Text color={color}>{symbol}</Text>
      <Text> </Text>
      <Text>{job.name.padEnd(JOB_NAME_WIDTH)}</Text>
      <Text>{COL_GAP}</Text>
      <Text color={color}>{statusText.padEnd(STATUS_WIDTH)}</Text>
      <Text>{COL_GAP}</Text>
      <Text color="gray">{duration.padStart(8)}</Text>
      <Text>{COL_GAP}</Text>
      <Text color="gray" href={job.jobUrl}>
        {jobId.padEnd(ID_WIDTH)}
      </Text>
      <Text>{COL_GAP}</Text>
      <Text color="gray">{runner}</Text>
    </Box>
  )
}

const getJobSymbol = ({
  job,
  symbols,
}: {
  job: WorkflowJobVM
  symbols: ReturnType<typeof useSymbols>
}) => {
  if (job.conclusion === 'success') return { symbol: symbols.status.check, color: 'green' as const }
  if (job.conclusion === 'failure') return { symbol: symbols.status.cross, color: 'red' as const }
  if (job.conclusion === 'cancelled')
    return { symbol: symbols.status.cross, color: 'gray' as const }
  if (job.conclusion === 'skipped') return { symbol: symbols.status.circle, color: 'gray' as const }
  if (job.status === 'in_progress') return { symbol: symbols.status.circle, color: 'blue' as const }
  return { symbol: symbols.status.circle, color: 'gray' as const }
}

const resolveRunnerDisplay = ({
  runner,
  runnerHostMap,
}: {
  runner: string
  runnerHostMap: RunnerHostMap
}): string => {
  if (runner === '—') return runner
  return lookupRunnerHost({ entries: runnerHostMap, runnerName: runner }) ?? runner
}

const ErrorBlock = ({ error }: { readonly error: JobError }) => (
  <Box flexDirection="column">
    <Text>
      {'  '}
      {error.jobName} {'>'} {error.stepName}:
    </Text>
    {error.errors.map((line, ord) => (
      // eslint-disable-next-line react/no-array-index-key -- log lines are positional and can repeat verbatim
      <Text key={`${error.jobName}:${error.stepName}:${ord}`} wrap="wrap">
        {'    '}
        {line}
      </Text>
    ))}
    <Text> </Text>
  </Box>
)

const AnnotationsBlock = ({ annotations }: { readonly annotations: readonly AnnotationInfo[] }) => (
  <Box flexDirection="column">
    <Text>{'  '}Annotations:</Text>
    {annotations.map((a) => {
      const title = a.title ? ` ${a.title}` : ''
      return (
        <Text key={`${a.jobName}:${a.path}:${a.line}`} wrap="wrap">
          {'    '}
          {a.jobName} {a.path}:{a.line} {a.message}
          {title}
        </Text>
      )
    })}
    <Text> </Text>
  </Box>
)

const MetaFooter = ({ meta }: { readonly meta: ApiMeta }) =>
  meta.apiRequests > 0 ? (
    <Text color="gray">
      {meta.apiRequests} reqs · {meta.rateLimitRemaining}/{meta.rateLimitLimit} rate limit
    </Text>
  ) : null
