/** Synthetic CiOutput story fixtures with realistic CI shapes. */

import type { ApiMeta } from '../../../lib/apiMeta.ts'
import { parseRunnerIdentity } from '../../../lib/format.ts'
import { computeSummary, directRunSelection } from '../../../lib/summary.ts'
import type {
  AnnotationInfo,
  JobError,
  PrHealth,
  RunInfo,
  StepInfo,
  Summary,
  WorkflowJobVM,
} from '../../../lib/viewModels.ts'
import type { CiAction, CiState, RunnerHostMap } from '../schema.ts'

// =============================================================================
// Helpers
// =============================================================================

const loadingMeta: ApiMeta = {
  apiRequests: 0,
  apiRequestsCached: 0,
  rateLimitRemaining: 0,
  rateLimitLimit: 0,
}
const realisticMeta: ApiMeta = {
  apiRequests: 7,
  apiRequestsCached: 2,
  rateLimitRemaining: 4993,
  rateLimitLimit: 5000,
}

let _id = 10_000_000_000
const nextId = () => _id++

// =============================================================================
// Factories
// =============================================================================

export const makeRun = (overrides: Partial<RunInfo> = {}): RunInfo => {
  const id = overrides.id ?? nextId()
  return {
    id,
    name: 'CI',
    runNumber: 100 + (id % 100),
    headBranch: 'example/ci-update',
    status: 'completed',
    conclusion: 'success',
    event: 'push',
    workflowPath: '.github/workflows/ci.yml',
    htmlUrl: `https://github.com/example-org/example-repo/actions/runs/${id}`,
    elapsedSeconds: 960,
    ...overrides,
  }
}

/** Stories only care about a step's name/status/conclusion; ordering and timestamps are filled in. */
export type StepOverrides = Pick<StepInfo, 'name' | 'status' | 'conclusion'> & Partial<StepInfo>

const makeStep = ({ step, ord }: { step: StepOverrides; ord: number }): StepInfo => ({
  number: ord + 1,
  startedAt: null,
  completedAt: null,
  ...step,
})

type JobOverrides = Omit<Partial<WorkflowJobVM>, 'steps'> & {
  steps?: readonly StepOverrides[] | undefined
}

export const makeJob = (overrides: JobOverrides = {}): WorkflowJobVM => {
  const { steps: stepOverrides, ...rest } = overrides
  const id = rest.id ?? nextId()
  const steps = stepOverrides?.map((step, ord) => makeStep({ step, ord }))
  /** Stories set the abbreviated `runner`; derive a plausible raw name from it. */
  const runnerName =
    rest.runnerName !== undefined
      ? rest.runnerName
      : rest.runner === '—'
        ? null
        : (rest.runner ?? 'dev3')
  const identity = parseRunnerIdentity({ name: runnerName })
  return {
    id,
    name: 'build',
    status: 'completed',
    conclusion: 'success',
    durationSeconds: 300,
    runner: 'linux-runner-a',
    runnerName,
    runnerKind: identity._tag,
    runnerInstance: identity.instance,
    jobUrl: `https://github.com/example-org/example-repo/actions/runs/0/job/${id}`,
    ...(steps !== undefined ? { steps } : {}),
    failedStepName:
      rest.failedStepName ?? steps?.find((s) => s.conclusion === 'failure')?.name ?? null,
    ...rest,
  }
}

/**
 * Compute a fixture summary with the production verdict logic, so stories and
 * snapshots can never disagree with the CLI about what "passing" means.
 */
export const makeSummary = ({
  run,
  jobs,
  prHealth = null,
}: {
  run: RunInfo
  jobs: readonly WorkflowJobVM[]
  prHealth?: PrHealth | null
}): Summary => computeSummary({ run, jobs, prHealth, selection: directRunSelection })

export const makeJobError = (overrides: Partial<JobError> = {}): JobError => ({
  jobName: 'workspace-build',
  stepName: 'Build flake outputs',
  errors: [
    "error: hash mismatch in fixed-output derivation '/nix/store/00000000000000000000000000000000-example-package-deps.drv':",
    '         specified: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    '            got:    sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
  ],
  ...overrides,
})

export const prHealthConflicting: PrHealth = {
  prNumber: 42,
  mergeable: 'CONFLICTING',
  behindBy: 3,
  baseRefName: 'main',
}

export const prHealthBehind: PrHealth = {
  prNumber: 42,
  mergeable: 'MERGEABLE',
  behindBy: 7,
  baseRefName: 'main',
}

export const prHealthClean: PrHealth = {
  prNumber: 42,
  mergeable: 'MERGEABLE',
  behindBy: 0,
  baseRefName: 'main',
}

export const makeAnnotation = (overrides: Partial<AnnotationInfo> = {}): AnnotationInfo => ({
  jobName: 'workspace-build',
  path: 'flake.nix',
  line: 1,
  message: 'Process completed with exit code 1',
  title: null,
  ...overrides,
})

// =============================================================================
// Synthetic CI: 12 jobs in a representative start order
// =============================================================================

const EXAMPLE_JOBS_ALL_PASS: Partial<WorkflowJobVM>[] = [
  { name: 'dependencies-build', durationSeconds: 28, runner: 'linux-runner-a' },
  { name: 'service-build', durationSeconds: 244, runner: 'linux-runner-b' },
  { name: 'linux-config-build', durationSeconds: 149, runner: 'linux-runner-a' },
  { name: 'macos-config-build', durationSeconds: 204, runner: 'macos-runner-a' },
  { name: 'workspace-build', durationSeconds: 317, runner: 'linux-runner-a' },
  { name: 'test-service', durationSeconds: 695, runner: 'linux-runner-a' },
  { name: 'test-auth-helper', durationSeconds: 708, runner: 'linux-runner-a' },
  { name: 'test-library', durationSeconds: 682, runner: 'linux-runner-a' },
  { name: 'test-workflows', durationSeconds: 732, runner: 'linux-runner-a' },
  { name: 'test-ci-exporter', durationSeconds: 719, runner: 'linux-runner-a' },
  { name: 'lint', durationSeconds: 954, runner: 'linux-runner-a' },
  { name: 'test-observability-cli', durationSeconds: 979, runner: 'linux-runner-a' },
]

// =============================================================================
// Pre-built Configs
// =============================================================================

export const allPassingJobs: readonly WorkflowJobVM[] = EXAMPLE_JOBS_ALL_PASS.map((j) => makeJob(j))

export const nixHashMismatchJobs: readonly WorkflowJobVM[] = [
  makeJob({ name: 'dependencies-build', durationSeconds: 28, runner: 'linux-runner-a' }),
  makeJob({
    name: 'service-build',
    conclusion: 'failure',
    durationSeconds: 102,
    runner: 'linux-runner-b',
    steps: [{ name: 'Build NixOS configuration', status: 'completed', conclusion: 'failure' }],
  }),
  makeJob({
    name: 'linux-config-build',
    conclusion: 'failure',
    durationSeconds: 163,
    runner: 'linux-runner-a',
    steps: [{ name: 'Build NixOS configuration', status: 'completed', conclusion: 'failure' }],
  }),
  makeJob({
    name: 'macos-config-build',
    conclusion: 'failure',
    durationSeconds: 106,
    runner: 'macos-runner-a',
    steps: [{ name: 'Build nix-darwin configuration', status: 'completed', conclusion: 'failure' }],
  }),
  makeJob({
    name: 'workspace-build',
    conclusion: 'failure',
    durationSeconds: 112,
    runner: 'linux-runner-a',
    steps: [{ name: 'Build flake outputs', status: 'completed', conclusion: 'failure' }],
  }),
  makeJob({ name: 'test-service', durationSeconds: 695, runner: 'linux-runner-a' }),
  makeJob({ name: 'test-auth-helper', durationSeconds: 708, runner: 'linux-runner-a' }),
  makeJob({ name: 'test-library', durationSeconds: 682, runner: 'linux-runner-a' }),
  makeJob({ name: 'test-workflows', durationSeconds: 732, runner: 'linux-runner-a' }),
  makeJob({ name: 'test-ci-exporter', durationSeconds: 719, runner: 'linux-runner-a' }),
  makeJob({ name: 'lint', durationSeconds: 954, runner: 'linux-runner-a' }),
  makeJob({ name: 'test-observability-cli', durationSeconds: 979, runner: 'linux-runner-a' }),
]

export const nixHashMismatchErrors: readonly JobError[] = [
  makeJobError({
    jobName: 'service-build',
    stepName: 'Build NixOS configuration',
    errors: [
      "error: hash mismatch in fixed-output derivation '/nix/store/11111111111111111111111111111111-example-service-deps.drv':",
      '         specified: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      '            got:    sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
      '(12 downstream build failures omitted)',
    ],
  }),
  makeJobError({
    jobName: 'linux-config-build',
    stepName: 'Build NixOS configuration',
    errors: [
      "error: hash mismatch in fixed-output derivation '/nix/store/22222222222222222222222222222222-example-exporter-deps.drv':",
      '         specified: sha256-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=',
      '            got:    sha256-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=',
      '(8 downstream build failures omitted)',
    ],
  }),
  makeJobError({
    jobName: 'macos-config-build',
    stepName: 'Build nix-darwin configuration',
    errors: [
      "error: hash mismatch in fixed-output derivation '/nix/store/33333333333333333333333333333333-example-agent-deps.drv':",
      '         specified: sha256-EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE=',
      '            got:    sha256-FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF=',
      '(5 downstream build failures omitted)',
    ],
  }),
  makeJobError({
    jobName: 'workspace-build',
    stepName: 'Build flake outputs',
    errors: [
      "error: hash mismatch in fixed-output derivation '/nix/store/44444444444444444444444444444444-example-service-deps.drv':",
      '         specified: sha256-GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG=',
      '            got:    sha256-HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH=',
    ],
  }),
]

export const nixHashMismatchAnnotations: readonly AnnotationInfo[] = [
  makeAnnotation({
    jobName: 'service-build',
    path: 'flake.nix',
    line: 127,
    message: 'Process completed with exit code 1',
  }),
  makeAnnotation({
    jobName: 'linux-config-build',
    path: 'infrastructure/linux/runner-a/configuration.nix',
    line: 47,
    message: 'Process completed with exit code 1',
  }),
]

export const lintFailureJobs: readonly WorkflowJobVM[] = [
  makeJob({ name: 'dependencies-build', durationSeconds: 28, runner: 'linux-runner-a' }),
  makeJob({ name: 'service-build', durationSeconds: 244, runner: 'linux-runner-b' }),
  makeJob({ name: 'linux-config-build', durationSeconds: 149, runner: 'linux-runner-a' }),
  makeJob({ name: 'macos-config-build', durationSeconds: 204, runner: 'macos-runner-a' }),
  makeJob({ name: 'workspace-build', durationSeconds: 317, runner: 'linux-runner-a' }),
  makeJob({ name: 'test-service', durationSeconds: 695, runner: 'linux-runner-a' }),
  makeJob({ name: 'test-auth-helper', durationSeconds: 708, runner: 'linux-runner-a' }),
  makeJob({ name: 'test-library', durationSeconds: 682, runner: 'linux-runner-a' }),
  makeJob({ name: 'test-workflows', durationSeconds: 732, runner: 'linux-runner-a' }),
  makeJob({ name: 'test-ci-exporter', durationSeconds: 719, runner: 'linux-runner-a' }),
  makeJob({
    name: 'lint',
    conclusion: 'failure',
    durationSeconds: 954,
    runner: 'linux-runner-a',
    steps: [{ name: 'Format + lint', status: 'completed', conclusion: 'failure' }],
  }),
  makeJob({ name: 'test-observability-cli', durationSeconds: 979, runner: 'linux-runner-a' }),
]

export const lintFailureErrors: readonly JobError[] = [
  makeJobError({
    jobName: 'lint',
    stepName: 'Format + lint',
    errors: [
      'Checking formatting...',
      'packages/example-cli/src/commands/status.ts (0ms)',
      'Format issues found in above 15 files.',
    ],
  }),
]

export const inProgressJobs: readonly WorkflowJobVM[] = [
  makeJob({ name: 'dependencies-build', durationSeconds: 28, runner: 'linux-runner-a' }),
  makeJob({ name: 'service-build', durationSeconds: 244, runner: 'linux-runner-b' }),
  makeJob({ name: 'linux-config-build', durationSeconds: 149, runner: 'linux-runner-a' }),
  makeJob({ name: 'macos-config-build', durationSeconds: 204, runner: 'macos-runner-a' }),
  makeJob({
    name: 'workspace-build',
    status: 'in_progress',
    conclusion: null,
    durationSeconds: 210,
    runner: 'linux-runner-a',
  }),
  makeJob({
    name: 'test-service',
    status: 'in_progress',
    conclusion: null,
    durationSeconds: 340,
    runner: 'linux-runner-a',
  }),
  makeJob({
    name: 'test-auth-helper',
    status: 'in_progress',
    conclusion: null,
    durationSeconds: 335,
    runner: 'linux-runner-a',
  }),
  makeJob({
    name: 'test-library',
    status: 'in_progress',
    conclusion: null,
    durationSeconds: 320,
    runner: 'linux-runner-a',
  }),
  makeJob({
    name: 'test-workflows',
    status: 'in_progress',
    conclusion: null,
    durationSeconds: 310,
    runner: 'linux-runner-a',
  }),
  makeJob({
    name: 'test-ci-exporter',
    status: 'in_progress',
    conclusion: null,
    durationSeconds: 315,
    runner: 'linux-runner-a',
  }),
  makeJob({
    name: 'lint',
    status: 'in_progress',
    conclusion: null,
    durationSeconds: 180,
    runner: 'linux-runner-a',
  }),
  makeJob({
    name: 'test-observability-cli',
    status: 'in_progress',
    conclusion: null,
    durationSeconds: 120,
    runner: 'linux-runner-a',
  }),
]

export const allQueuedJobs: readonly WorkflowJobVM[] = EXAMPLE_JOBS_ALL_PASS.map((j) =>
  makeJob({
    ...j,
    status: 'queued',
    conclusion: null,
    durationSeconds: 0,
    runner: '—',
  }),
)

export const cancelledJobs: readonly WorkflowJobVM[] = [
  makeJob({ name: 'dependencies-build', durationSeconds: 28, runner: 'linux-runner-a' }),
  makeJob({ name: 'service-build', durationSeconds: 102, runner: 'linux-runner-b' }),
  makeJob({
    name: 'linux-config-build',
    conclusion: 'cancelled',
    durationSeconds: 85,
    runner: 'linux-runner-a',
  }),
  makeJob({
    name: 'macos-config-build',
    conclusion: 'cancelled',
    durationSeconds: 72,
    runner: 'macos-runner-a',
  }),
  makeJob({
    name: 'workspace-build',
    conclusion: 'cancelled',
    durationSeconds: 95,
    runner: 'linux-runner-a',
  }),
  makeJob({
    name: 'test-service',
    conclusion: 'cancelled',
    durationSeconds: 0,
    runner: '—',
  }),
  makeJob({
    name: 'test-auth-helper',
    conclusion: 'cancelled',
    durationSeconds: 0,
    runner: '—',
  }),
  makeJob({
    name: 'test-library',
    conclusion: 'cancelled',
    durationSeconds: 0,
    runner: '—',
  }),
  makeJob({
    name: 'test-workflows',
    conclusion: 'cancelled',
    durationSeconds: 0,
    runner: '—',
  }),
  makeJob({
    name: 'test-ci-exporter',
    conclusion: 'cancelled',
    durationSeconds: 0,
    runner: '—',
  }),
  makeJob({
    name: 'lint',
    conclusion: 'cancelled',
    durationSeconds: 0,
    runner: '—',
  }),
  makeJob({
    name: 'test-observability-cli',
    conclusion: 'cancelled',
    durationSeconds: 0,
    runner: '—',
  }),
]

// =============================================================================
// State Factories
// =============================================================================

const DEFAULT_RUN = makeRun({
  id: 20_000_000_001,
  runNumber: 100,
  headBranch: 'example/ci-update',
  event: 'pull_request',
})

const IN_PROGRESS_RUN = makeRun({
  id: 20_000_000_001,
  runNumber: 100,
  headBranch: 'example/ci-update',
  event: 'pull_request',
  status: 'in_progress',
  conclusion: null,
  elapsedSeconds: 380,
})

const CANCELLED_RUN = makeRun({
  id: 20_000_000_001,
  runNumber: 100,
  headBranch: 'example/ci-update',
  event: 'pull_request',
  status: 'completed',
  conclusion: 'cancelled',
  elapsedSeconds: 130,
})

const FAILURE_RUN = makeRun({
  id: 20_000_000_001,
  runNumber: 100,
  headBranch: 'example/ci-update',
  event: 'pull_request',
  status: 'completed',
  conclusion: 'failure',
})

export const loadingState = (): CiState => ({
  _tag: 'Loading',
  message: 'Fetching CI status...',
  _meta: loadingMeta,
})

export const errorState = (): CiState => ({
  _tag: 'Error',
  error: 'AuthError',
  message: 'GitHub token is missing or expired. Run `gh auth login` to authenticate.',
  _meta: realisticMeta,
})

export const createSingleRunState = ({
  jobs,
  errors = [],
  annotations = [],
  run = DEFAULT_RUN,
  runnerHostMap = [],
  prHealth = null,
}: {
  jobs: readonly WorkflowJobVM[]
  errors?: readonly JobError[]
  annotations?: readonly AnnotationInfo[]
  run?: RunInfo
  runnerHostMap?: RunnerHostMap
  prHealth?: PrHealth | null
}): CiState => ({
  _tag: 'Loaded',
  run,
  jobs,
  errors,
  annotations,
  runnerHostMap,
  prHealth,
  summary: makeSummary({ run, jobs, prHealth }),
  _meta: realisticMeta,
})

// =============================================================================
// Timeline Helpers
// =============================================================================

type TimelineStep = { at: number; action: CiAction }

const loadedAction = ({
  jobs,
  errors = [],
  annotations = [],
  run = DEFAULT_RUN,
  runnerHostMap = [],
  prHealth = null,
}: {
  jobs: readonly WorkflowJobVM[]
  errors?: readonly JobError[]
  annotations?: readonly AnnotationInfo[]
  run?: RunInfo
  runnerHostMap?: RunnerHostMap
  prHealth?: PrHealth | null
}): CiAction => ({
  _tag: 'SetLoaded',
  run,
  jobs,
  errors,
  annotations,
  runnerHostMap,
  prHealth,
  summary: makeSummary({ run, jobs, prHealth }),
})

// =============================================================================
// Event-driven timeline builder
// =============================================================================

type JobEvent = {
  /** Simulated seconds into the run when this event happens */
  realTimeSeconds: number
  name: string
  event: 'queued' | 'runner_assigned' | 'in_progress' | 'completed'
  conclusion?: 'success' | 'failure' | 'cancelled'
  runner?: string
  /** For completed-failure jobs: step overrides */
  steps?: readonly StepOverrides[]
}

type JobState = {
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: string | null
  runner: string
  /** For completed jobs: final duration. For in-progress: unused (computed from startedAtSeconds). */
  durationSeconds: number
  /** Real-time seconds when the job started (for computing elapsed time on in-progress jobs). */
  startedAtSeconds: number
  steps: readonly StepOverrides[] | undefined
  failedStepName: string | null
}

/** Groups events within `windowSeconds` real-seconds into one beat */
const groupEvents = ({
  events,
  windowSeconds,
}: {
  events: readonly JobEvent[]
  windowSeconds: number
}): JobEvent[][] => {
  const sorted = [...events].toSorted((a, b) => a.realTimeSeconds - b.realTimeSeconds)
  const groups: JobEvent[][] = []
  let current: JobEvent[] = []
  let groupStart = -Infinity

  for (const ev of sorted) {
    if (ev.realTimeSeconds - groupStart > windowSeconds && current.length > 0) {
      groups.push(current)
      current = []
      groupStart = ev.realTimeSeconds
    }
    if (current.length === 0) groupStart = ev.realTimeSeconds
    current.push(ev)
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/**
 * Convert real-time job events into storybook timeline beats.
 * Each group of events within a poll window becomes one state snapshot.
 */
const buildTimeline = (opts: {
  events: readonly JobEvent[]
  allJobNames: readonly string[]
  run: RunInfo
  finalRun?: RunInfo
  errors?: readonly JobError[]
  annotations?: readonly AnnotationInfo[]
  /** Map from jobName -> errors that appear when that job completes with failure */
  errorsByJob?: ReadonlyMap<string, readonly JobError[]>
  /** Map from jobName -> annotations that appear when that job completes with failure */
  annotationsByJob?: ReadonlyMap<string, readonly AnnotationInfo[]>
  /** Real seconds -> story milliseconds. Default ~50x compression (979s -> 20s story) */
  compressionRatio?: number
  /** Grouping window in real seconds. Default 5s (one poll cycle) */
  pollWindowSeconds?: number
  /** Initial story offset in ms (accounts for loading state). Default 600 */
  initialOffsetMs?: number
}): TimelineStep[] => {
  const {
    events,
    allJobNames,
    run,
    finalRun,
    errors = [],
    annotations = [],
    errorsByJob = new Map(),
    annotationsByJob = new Map(),
    compressionRatio = 1,
    pollWindowSeconds = 5,
    initialOffsetMs = 600,
  } = opts

  const jobStates = new Map<string, JobState>()
  for (const name of allJobNames) {
    jobStates.set(name, {
      status: 'queued',
      conclusion: null,
      runner: '—',
      durationSeconds: 0,
      startedAtSeconds: 0,
      steps: undefined,
      failedStepName: null,
    })
  }

  const groups = groupEvents({ events, windowSeconds: pollWindowSeconds })
  const steps: TimelineStep[] = []
  let accumulatedErrors: JobError[] = []
  let accumulatedAnnotations: AnnotationInfo[] = []

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi]!
    const groupTime = group[0]!.realTimeSeconds

    for (const ev of group) {
      const state = jobStates.get(ev.name)!
      switch (ev.event) {
        case 'queued':
          state.status = 'queued'
          state.conclusion = null
          state.runner = '—'
          state.durationSeconds = 0
          break
        case 'runner_assigned':
          state.runner = ev.runner ?? state.runner
          break
        case 'in_progress':
          state.status = 'in_progress'
          state.conclusion = null
          state.runner = ev.runner ?? state.runner
          state.startedAtSeconds = ev.realTimeSeconds
          break
        case 'completed':
          state.status = 'completed'
          state.conclusion = ev.conclusion ?? 'success'
          state.durationSeconds = ev.realTimeSeconds - state.startedAtSeconds
          if (ev.steps) {
            state.steps = ev.steps
            state.failedStepName = ev.steps.find((s) => s.conclusion === 'failure')?.name ?? null
          }
          if (ev.runner) state.runner = ev.runner
          if (state.conclusion === 'failure' || state.conclusion === 'cancelled') {
            const jobErrors = errorsByJob.get(ev.name)
            if (jobErrors) accumulatedErrors.push(...jobErrors)
            const jobAnnotations = annotationsByJob.get(ev.name)
            if (jobAnnotations) accumulatedAnnotations.push(...jobAnnotations)
          }
          break
      }
    }

    const isLast = gi === groups.length - 1
    const jobs: WorkflowJobVM[] = allJobNames.map((name) => {
      const s = jobStates.get(name)!
      const elapsed = s.status === 'in_progress' ? Math.round(groupTime - s.startedAtSeconds) : 0
      return makeJob({
        name,
        status: s.status,
        conclusion: s.conclusion,
        durationSeconds: s.status === 'completed' ? s.durationSeconds : elapsed,
        runner: s.runner,
        ...(s.steps !== undefined ? { steps: s.steps } : {}),
        failedStepName: s.failedStepName,
      })
    })

    const currentRun =
      isLast && finalRun
        ? finalRun
        : { ...run, status: 'in_progress' as const, conclusion: null, elapsedSeconds: groupTime }

    const storyMs = initialOffsetMs + Math.round((groupTime * 1000) / compressionRatio)

    steps.push({
      at: storyMs,
      action: loadedAction({
        jobs,
        errors:
          accumulatedErrors.length > 0
            ? [...accumulatedErrors]
            : errors.length > 0 && isLast
              ? [...errors]
              : [],
        annotations:
          accumulatedAnnotations.length > 0
            ? [...accumulatedAnnotations]
            : annotations.length > 0 && isLast
              ? [...annotations]
              : [],
        run: currentRun,
      }),
    })
  }

  return steps
}

// =============================================================================
// Synthetic job names (canonical order)
// =============================================================================

const EXAMPLE_JOB_NAMES = EXAMPLE_JOBS_ALL_PASS.map((j) => j.name!)

// =============================================================================
// AllPassing timeline (~38 beats)
// =============================================================================

export const createAllPassingTimeline = (): TimelineStep[] => {
  const events: JobEvent[] = [
    // t=0: all 12 queued
    ...EXAMPLE_JOB_NAMES.map((name): JobEvent => ({ realTimeSeconds: 0, name, event: 'queued' })),

    // t=2: first wave runners assigned + start
    {
      realTimeSeconds: 2,
      name: 'dependencies-build',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 2,
      name: 'dependencies-build',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 2,
      name: 'service-build',
      event: 'runner_assigned',
      runner: 'linux-runner-b',
    },
    { realTimeSeconds: 2, name: 'service-build', event: 'in_progress', runner: 'linux-runner-b' },
    {
      realTimeSeconds: 2,
      name: 'linux-config-build',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 2,
      name: 'linux-config-build',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=3: second wave
    {
      realTimeSeconds: 8,
      name: 'macos-config-build',
      event: 'runner_assigned',
      runner: 'macos-runner-a',
    },
    {
      realTimeSeconds: 8,
      name: 'macos-config-build',
      event: 'in_progress',
      runner: 'macos-runner-a',
    },
    {
      realTimeSeconds: 8,
      name: 'test-service',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    { realTimeSeconds: 8, name: 'test-service', event: 'in_progress', runner: 'linux-runner-a' },
    {
      realTimeSeconds: 8,
      name: 'test-auth-helper',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 8,
      name: 'test-auth-helper',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=14: third wave
    {
      realTimeSeconds: 14,
      name: 'test-library',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    { realTimeSeconds: 14, name: 'test-library', event: 'in_progress', runner: 'linux-runner-a' },
    {
      realTimeSeconds: 14,
      name: 'test-workflows',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    { realTimeSeconds: 14, name: 'test-workflows', event: 'in_progress', runner: 'linux-runner-a' },
    {
      realTimeSeconds: 14,
      name: 'test-ci-exporter',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 14,
      name: 'test-ci-exporter',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=28: dependencies-build done
    {
      realTimeSeconds: 28,
      name: 'dependencies-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=45: workspace-build picks up freed runner
    {
      realTimeSeconds: 45,
      name: 'workspace-build',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 45,
      name: 'workspace-build',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=102: service-build done
    {
      realTimeSeconds: 102,
      name: 'service-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-b',
    },

    // t=120: lint starts on freed runner
    { realTimeSeconds: 120, name: 'lint', event: 'runner_assigned', runner: 'linux-runner-a' },
    { realTimeSeconds: 120, name: 'lint', event: 'in_progress', runner: 'linux-runner-a' },

    // t=149: linux-config-build done
    {
      realTimeSeconds: 149,
      name: 'linux-config-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=180: test-observability-cli starts
    {
      realTimeSeconds: 180,
      name: 'test-observability-cli',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 180,
      name: 'test-observability-cli',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=204: macos-config-build done
    {
      realTimeSeconds: 204,
      name: 'macos-config-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'macos-runner-a',
    },

    // t=317: workspace-build done
    {
      realTimeSeconds: 317,
      name: 'workspace-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=450: poll tick (jobs still running, duration updates)
    { realTimeSeconds: 450, name: 'test-library', event: 'in_progress', runner: 'linux-runner-a' },
    { realTimeSeconds: 450, name: 'test-service', event: 'in_progress', runner: 'linux-runner-a' },

    // t=550: poll tick
    {
      realTimeSeconds: 550,
      name: 'test-auth-helper',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },
    { realTimeSeconds: 550, name: 'lint', event: 'in_progress', runner: 'linux-runner-a' },

    // t=630: poll tick
    {
      realTimeSeconds: 630,
      name: 'test-workflows',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 630,
      name: 'test-ci-exporter',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=682: test-library done
    {
      realTimeSeconds: 682,
      name: 'test-library',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=695: test-service done
    {
      realTimeSeconds: 695,
      name: 'test-service',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=708: test-auth-helper done
    {
      realTimeSeconds: 708,
      name: 'test-auth-helper',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=719: test-ci-exporter done
    {
      realTimeSeconds: 719,
      name: 'test-ci-exporter',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=732: test-workflows done
    {
      realTimeSeconds: 732,
      name: 'test-workflows',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=800: poll tick (lint + otel still going)
    { realTimeSeconds: 800, name: 'lint', event: 'in_progress', runner: 'linux-runner-a' },
    {
      realTimeSeconds: 800,
      name: 'test-observability-cli',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=900: poll tick
    { realTimeSeconds: 900, name: 'lint', event: 'in_progress', runner: 'linux-runner-a' },
    {
      realTimeSeconds: 900,
      name: 'test-observability-cli',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=954: lint done
    {
      realTimeSeconds: 954,
      name: 'lint',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=979: test-observability-cli done -> RUN COMPLETE
    {
      realTimeSeconds: 979,
      name: 'test-observability-cli',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },
  ]

  return buildTimeline({
    events,
    allJobNames: EXAMPLE_JOB_NAMES,
    run: IN_PROGRESS_RUN,
    finalRun: DEFAULT_RUN,
  })
}

// =============================================================================
// NixHashMismatch timeline (~30 beats)
// =============================================================================

export const createNixHashMismatchTimeline = (): TimelineStep[] => {
  const errorsByJob = new Map<string, readonly JobError[]>([
    ['service-build', [nixHashMismatchErrors[0]!]],
    ['linux-config-build', [nixHashMismatchErrors[1]!]],
    ['macos-config-build', [nixHashMismatchErrors[2]!]],
    ['workspace-build', [nixHashMismatchErrors[3]!]],
  ])
  const annotationsByJob = new Map<string, readonly AnnotationInfo[]>([
    ['service-build', [nixHashMismatchAnnotations[0]!]],
    ['linux-config-build', [nixHashMismatchAnnotations[1]!]],
  ])

  const events: JobEvent[] = [
    // t=0: all queued
    ...EXAMPLE_JOB_NAMES.map((name): JobEvent => ({ realTimeSeconds: 0, name, event: 'queued' })),

    // t=2: first wave starts
    {
      realTimeSeconds: 2,
      name: 'dependencies-build',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 2,
      name: 'dependencies-build',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 2,
      name: 'service-build',
      event: 'runner_assigned',
      runner: 'linux-runner-b',
    },
    { realTimeSeconds: 2, name: 'service-build', event: 'in_progress', runner: 'linux-runner-b' },
    {
      realTimeSeconds: 2,
      name: 'linux-config-build',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 2,
      name: 'linux-config-build',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=8: second wave
    {
      realTimeSeconds: 8,
      name: 'macos-config-build',
      event: 'runner_assigned',
      runner: 'macos-runner-a',
    },
    {
      realTimeSeconds: 8,
      name: 'macos-config-build',
      event: 'in_progress',
      runner: 'macos-runner-a',
    },
    {
      realTimeSeconds: 8,
      name: 'test-service',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    { realTimeSeconds: 8, name: 'test-service', event: 'in_progress', runner: 'linux-runner-a' },
    {
      realTimeSeconds: 8,
      name: 'test-auth-helper',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 8,
      name: 'test-auth-helper',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=14: third wave
    {
      realTimeSeconds: 14,
      name: 'test-library',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    { realTimeSeconds: 14, name: 'test-library', event: 'in_progress', runner: 'linux-runner-a' },
    {
      realTimeSeconds: 14,
      name: 'test-workflows',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    { realTimeSeconds: 14, name: 'test-workflows', event: 'in_progress', runner: 'linux-runner-a' },
    {
      realTimeSeconds: 14,
      name: 'test-ci-exporter',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 14,
      name: 'test-ci-exporter',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=28: dependencies-build done
    {
      realTimeSeconds: 28,
      name: 'dependencies-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=36: service-build FAILS (hash mismatch)
    {
      realTimeSeconds: 36,
      name: 'service-build',
      event: 'completed',
      conclusion: 'failure',
      runner: 'linux-runner-b',
      steps: [{ name: 'Build NixOS configuration', status: 'completed', conclusion: 'failure' }],
    },

    // t=43: linux-config-build FAILS (cascade)
    {
      realTimeSeconds: 43,
      name: 'linux-config-build',
      event: 'completed',
      conclusion: 'failure',
      runner: 'linux-runner-a',
      steps: [{ name: 'Build NixOS configuration', status: 'completed', conclusion: 'failure' }],
    },

    // t=46: macos-config-build FAILS (cascade)
    {
      realTimeSeconds: 50,
      name: 'macos-config-build',
      event: 'completed',
      conclusion: 'failure',
      runner: 'macos-runner-a',
      steps: [
        { name: 'Build nix-darwin configuration', status: 'completed', conclusion: 'failure' },
      ],
    },

    // t=52: workspace-build starts and immediately fails
    {
      realTimeSeconds: 52,
      name: 'workspace-build',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 52,
      name: 'workspace-build',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 58,
      name: 'workspace-build',
      event: 'completed',
      conclusion: 'failure',
      runner: 'linux-runner-a',
      steps: [{ name: 'Build flake outputs', status: 'completed', conclusion: 'failure' }],
    },

    // t=70: lint starts on freed runner
    { realTimeSeconds: 70, name: 'lint', event: 'runner_assigned', runner: 'linux-runner-a' },
    { realTimeSeconds: 70, name: 'lint', event: 'in_progress', runner: 'linux-runner-a' },

    // t=80: test-observability-cli starts
    {
      realTimeSeconds: 80,
      name: 'test-observability-cli',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 80,
      name: 'test-observability-cli',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // Poll ticks while tests run
    { realTimeSeconds: 200, name: 'test-library', event: 'in_progress', runner: 'linux-runner-a' },
    { realTimeSeconds: 300, name: 'test-service', event: 'in_progress', runner: 'linux-runner-a' },
    {
      realTimeSeconds: 400,
      name: 'test-auth-helper',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 500,
      name: 'test-workflows',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 500,
      name: 'test-ci-exporter',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },
    { realTimeSeconds: 600, name: 'lint', event: 'in_progress', runner: 'linux-runner-a' },

    // t=682: test-library done
    {
      realTimeSeconds: 682,
      name: 'test-library',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=695: test-service done
    {
      realTimeSeconds: 695,
      name: 'test-service',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=708: test-auth-helper done
    {
      realTimeSeconds: 708,
      name: 'test-auth-helper',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=719: test-ci-exporter done
    {
      realTimeSeconds: 719,
      name: 'test-ci-exporter',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=732: test-workflows done
    {
      realTimeSeconds: 732,
      name: 'test-workflows',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=800: poll tick
    { realTimeSeconds: 800, name: 'lint', event: 'in_progress', runner: 'linux-runner-a' },
    {
      realTimeSeconds: 800,
      name: 'test-observability-cli',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=954: lint done
    {
      realTimeSeconds: 954,
      name: 'lint',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=979: test-observability-cli done -> COMPLETE (with failures)
    {
      realTimeSeconds: 979,
      name: 'test-observability-cli',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },
  ]

  return buildTimeline({
    events,
    allJobNames: EXAMPLE_JOB_NAMES,
    run: IN_PROGRESS_RUN,
    finalRun: FAILURE_RUN,
    errorsByJob,
    annotationsByJob,
  })
}

// =============================================================================
// LintFailure timeline (~35 beats)
// =============================================================================

export const createLintFailureTimeline = (): TimelineStep[] => {
  const errorsByJob = new Map<string, readonly JobError[]>([['lint', [...lintFailureErrors]]])

  const events: JobEvent[] = [
    // t=0: all queued
    ...EXAMPLE_JOB_NAMES.map((name): JobEvent => ({ realTimeSeconds: 0, name, event: 'queued' })),

    // t=2: first wave
    {
      realTimeSeconds: 2,
      name: 'dependencies-build',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 2,
      name: 'dependencies-build',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 2,
      name: 'service-build',
      event: 'runner_assigned',
      runner: 'linux-runner-b',
    },
    { realTimeSeconds: 2, name: 'service-build', event: 'in_progress', runner: 'linux-runner-b' },
    {
      realTimeSeconds: 2,
      name: 'linux-config-build',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 2,
      name: 'linux-config-build',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=8: second wave
    {
      realTimeSeconds: 8,
      name: 'macos-config-build',
      event: 'runner_assigned',
      runner: 'macos-runner-a',
    },
    {
      realTimeSeconds: 8,
      name: 'macos-config-build',
      event: 'in_progress',
      runner: 'macos-runner-a',
    },
    {
      realTimeSeconds: 8,
      name: 'test-service',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    { realTimeSeconds: 8, name: 'test-service', event: 'in_progress', runner: 'linux-runner-a' },
    {
      realTimeSeconds: 8,
      name: 'test-auth-helper',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 8,
      name: 'test-auth-helper',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=14: third wave
    {
      realTimeSeconds: 14,
      name: 'test-library',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    { realTimeSeconds: 14, name: 'test-library', event: 'in_progress', runner: 'linux-runner-a' },
    {
      realTimeSeconds: 14,
      name: 'test-workflows',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    { realTimeSeconds: 14, name: 'test-workflows', event: 'in_progress', runner: 'linux-runner-a' },
    {
      realTimeSeconds: 14,
      name: 'test-ci-exporter',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 14,
      name: 'test-ci-exporter',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=28: dependencies-build done
    {
      realTimeSeconds: 28,
      name: 'dependencies-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=45: workspace-build starts
    {
      realTimeSeconds: 45,
      name: 'workspace-build',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 45,
      name: 'workspace-build',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=102: service-build done
    {
      realTimeSeconds: 102,
      name: 'service-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-b',
    },

    // t=120: lint starts
    { realTimeSeconds: 120, name: 'lint', event: 'runner_assigned', runner: 'linux-runner-a' },
    { realTimeSeconds: 120, name: 'lint', event: 'in_progress', runner: 'linux-runner-a' },

    // t=149: linux-config-build done
    {
      realTimeSeconds: 149,
      name: 'linux-config-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=180: test-observability-cli starts
    {
      realTimeSeconds: 180,
      name: 'test-observability-cli',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 180,
      name: 'test-observability-cli',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=204: macos-config-build done
    {
      realTimeSeconds: 204,
      name: 'macos-config-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'macos-runner-a',
    },

    // t=317: workspace-build done
    {
      realTimeSeconds: 317,
      name: 'workspace-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // Poll ticks
    { realTimeSeconds: 450, name: 'test-library', event: 'in_progress', runner: 'linux-runner-a' },
    { realTimeSeconds: 450, name: 'test-service', event: 'in_progress', runner: 'linux-runner-a' },
    {
      realTimeSeconds: 550,
      name: 'test-auth-helper',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },
    { realTimeSeconds: 550, name: 'lint', event: 'in_progress', runner: 'linux-runner-a' },
    {
      realTimeSeconds: 630,
      name: 'test-workflows',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 630,
      name: 'test-ci-exporter',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=682: test-library done
    {
      realTimeSeconds: 682,
      name: 'test-library',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=695: test-service done
    {
      realTimeSeconds: 695,
      name: 'test-service',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=708: test-auth-helper done
    {
      realTimeSeconds: 708,
      name: 'test-auth-helper',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=719: test-ci-exporter done
    {
      realTimeSeconds: 719,
      name: 'test-ci-exporter',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=732: test-workflows done
    {
      realTimeSeconds: 732,
      name: 'test-workflows',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=800: poll tick
    { realTimeSeconds: 800, name: 'lint', event: 'in_progress', runner: 'linux-runner-a' },
    {
      realTimeSeconds: 800,
      name: 'test-observability-cli',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=900: poll tick
    { realTimeSeconds: 900, name: 'lint', event: 'in_progress', runner: 'linux-runner-a' },
    {
      realTimeSeconds: 900,
      name: 'test-observability-cli',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=954: lint FAILS
    {
      realTimeSeconds: 954,
      name: 'lint',
      event: 'completed',
      conclusion: 'failure',
      runner: 'linux-runner-a',
      steps: [{ name: 'Format + lint', status: 'completed', conclusion: 'failure' }],
    },

    // t=979: test-observability-cli done -> COMPLETE
    {
      realTimeSeconds: 979,
      name: 'test-observability-cli',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },
  ]

  return buildTimeline({
    events,
    allJobNames: EXAMPLE_JOB_NAMES,
    run: IN_PROGRESS_RUN,
    finalRun: FAILURE_RUN,
    errorsByJob,
  })
}

// =============================================================================
// InProgress timeline (~25 beats, stops mid-run)
// =============================================================================

export const createInProgressTimeline = (): TimelineStep[] => {
  const events: JobEvent[] = [
    // t=0: all queued
    ...EXAMPLE_JOB_NAMES.map((name): JobEvent => ({ realTimeSeconds: 0, name, event: 'queued' })),

    // t=2: first wave
    {
      realTimeSeconds: 2,
      name: 'dependencies-build',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 2,
      name: 'dependencies-build',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 2,
      name: 'service-build',
      event: 'runner_assigned',
      runner: 'linux-runner-b',
    },
    { realTimeSeconds: 2, name: 'service-build', event: 'in_progress', runner: 'linux-runner-b' },
    {
      realTimeSeconds: 2,
      name: 'linux-config-build',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 2,
      name: 'linux-config-build',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=8: second wave
    {
      realTimeSeconds: 8,
      name: 'macos-config-build',
      event: 'runner_assigned',
      runner: 'macos-runner-a',
    },
    {
      realTimeSeconds: 8,
      name: 'macos-config-build',
      event: 'in_progress',
      runner: 'macos-runner-a',
    },
    {
      realTimeSeconds: 8,
      name: 'test-service',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    { realTimeSeconds: 8, name: 'test-service', event: 'in_progress', runner: 'linux-runner-a' },
    {
      realTimeSeconds: 8,
      name: 'test-auth-helper',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 8,
      name: 'test-auth-helper',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=14: third wave
    {
      realTimeSeconds: 14,
      name: 'test-library',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    { realTimeSeconds: 14, name: 'test-library', event: 'in_progress', runner: 'linux-runner-a' },
    {
      realTimeSeconds: 14,
      name: 'test-workflows',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    { realTimeSeconds: 14, name: 'test-workflows', event: 'in_progress', runner: 'linux-runner-a' },
    {
      realTimeSeconds: 14,
      name: 'test-ci-exporter',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 14,
      name: 'test-ci-exporter',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=28: dependencies-build done
    {
      realTimeSeconds: 28,
      name: 'dependencies-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=45: workspace-build starts
    {
      realTimeSeconds: 45,
      name: 'workspace-build',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 45,
      name: 'workspace-build',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=102: service-build done
    {
      realTimeSeconds: 102,
      name: 'service-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-b',
    },

    // t=120: lint starts
    { realTimeSeconds: 120, name: 'lint', event: 'runner_assigned', runner: 'linux-runner-a' },
    { realTimeSeconds: 120, name: 'lint', event: 'in_progress', runner: 'linux-runner-a' },

    // t=149: linux-config-build done
    {
      realTimeSeconds: 149,
      name: 'linux-config-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=180: test-observability-cli starts
    {
      realTimeSeconds: 180,
      name: 'test-observability-cli',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 180,
      name: 'test-observability-cli',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=204: macos-config-build done
    {
      realTimeSeconds: 204,
      name: 'macos-config-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'macos-runner-a',
    },

    // Poll ticks showing progress
    {
      realTimeSeconds: 280,
      name: 'workspace-build',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },
    { realTimeSeconds: 280, name: 'test-service', event: 'in_progress', runner: 'linux-runner-a' },
    {
      realTimeSeconds: 350,
      name: 'test-auth-helper',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },
    { realTimeSeconds: 350, name: 'test-library', event: 'in_progress', runner: 'linux-runner-a' },

    // t=380: snapshot freezes here (story stays at this state)
    {
      realTimeSeconds: 380,
      name: 'test-workflows',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 380,
      name: 'test-ci-exporter',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },
    { realTimeSeconds: 380, name: 'lint', event: 'in_progress', runner: 'linux-runner-a' },
    {
      realTimeSeconds: 380,
      name: 'test-observability-cli',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },
  ]

  return buildTimeline({
    events,
    allJobNames: EXAMPLE_JOB_NAMES,
    run: IN_PROGRESS_RUN,
  })
}

// =============================================================================
// AllQueued timeline: Loading -> all queued (stays)
// =============================================================================

export const createAllQueuedTimeline = (): TimelineStep[] => {
  const queuedRun = makeRun({
    ...IN_PROGRESS_RUN,
    status: 'queued',
    elapsedSeconds: 0,
  })
  return [{ at: 600, action: loadedAction({ jobs: allQueuedJobs, run: queuedRun }) }]
}

// =============================================================================
// CancelledRun timeline (~18 beats)
// =============================================================================

export const createCancelledRunTimeline = (): TimelineStep[] => {
  const events: JobEvent[] = [
    // t=0: all queued
    ...EXAMPLE_JOB_NAMES.map((name): JobEvent => ({ realTimeSeconds: 0, name, event: 'queued' })),

    // t=2: first wave
    {
      realTimeSeconds: 2,
      name: 'dependencies-build',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 2,
      name: 'dependencies-build',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 2,
      name: 'service-build',
      event: 'runner_assigned',
      runner: 'linux-runner-b',
    },
    { realTimeSeconds: 2, name: 'service-build', event: 'in_progress', runner: 'linux-runner-b' },
    {
      realTimeSeconds: 2,
      name: 'linux-config-build',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 2,
      name: 'linux-config-build',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=8: second wave
    {
      realTimeSeconds: 8,
      name: 'macos-config-build',
      event: 'runner_assigned',
      runner: 'macos-runner-a',
    },
    {
      realTimeSeconds: 8,
      name: 'macos-config-build',
      event: 'in_progress',
      runner: 'macos-runner-a',
    },
    {
      realTimeSeconds: 8,
      name: 'test-service',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    { realTimeSeconds: 8, name: 'test-service', event: 'in_progress', runner: 'linux-runner-a' },
    {
      realTimeSeconds: 8,
      name: 'test-auth-helper',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 8,
      name: 'test-auth-helper',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=14: third wave (some start)
    {
      realTimeSeconds: 14,
      name: 'test-library',
      event: 'runner_assigned',
      runner: 'linux-runner-a',
    },
    { realTimeSeconds: 14, name: 'test-library', event: 'in_progress', runner: 'linux-runner-a' },

    // t=28: dependencies-build done
    {
      realTimeSeconds: 28,
      name: 'dependencies-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'linux-runner-a',
    },

    // t=50: poll tick
    { realTimeSeconds: 50, name: 'service-build', event: 'in_progress', runner: 'linux-runner-b' },
    {
      realTimeSeconds: 50,
      name: 'linux-config-build',
      event: 'in_progress',
      runner: 'linux-runner-a',
    },

    // t=80: poll tick
    {
      realTimeSeconds: 80,
      name: 'macos-config-build',
      event: 'in_progress',
      runner: 'macos-runner-a',
    },

    // t=95: user cancels -> running jobs transition to cancelled one by one
    {
      realTimeSeconds: 95,
      name: 'service-build',
      event: 'completed',
      conclusion: 'cancelled',
      runner: 'linux-runner-b',
    },
    {
      realTimeSeconds: 95,
      name: 'test-library',
      event: 'completed',
      conclusion: 'cancelled',
      runner: 'linux-runner-a',
    },

    {
      realTimeSeconds: 97,
      name: 'linux-config-build',
      event: 'completed',
      conclusion: 'cancelled',
      runner: 'linux-runner-a',
    },
    {
      realTimeSeconds: 97,
      name: 'macos-config-build',
      event: 'completed',
      conclusion: 'cancelled',
      runner: 'macos-runner-a',
    },
    {
      realTimeSeconds: 97,
      name: 'test-service',
      event: 'completed',
      conclusion: 'cancelled',
      runner: 'linux-runner-a',
    },

    {
      realTimeSeconds: 100,
      name: 'test-auth-helper',
      event: 'completed',
      conclusion: 'cancelled',
      runner: 'linux-runner-a',
    },
    { realTimeSeconds: 100, name: 'workspace-build', event: 'completed', conclusion: 'cancelled' },
    { realTimeSeconds: 100, name: 'test-workflows', event: 'completed', conclusion: 'cancelled' },
    {
      realTimeSeconds: 100,
      name: 'test-ci-exporter',
      event: 'completed',
      conclusion: 'cancelled',
    },
    { realTimeSeconds: 100, name: 'lint', event: 'completed', conclusion: 'cancelled' },
    {
      realTimeSeconds: 100,
      name: 'test-observability-cli',
      event: 'completed',
      conclusion: 'cancelled',
    },
  ]

  return buildTimeline({
    events,
    allJobNames: EXAMPLE_JOB_NAMES,
    run: IN_PROGRESS_RUN,
    finalRun: CANCELLED_RUN,
    compressionRatio: 1,
  })
}

// =============================================================================
// Error timeline
// =============================================================================

export const createErrorTimeline = (): TimelineStep[] => [
  {
    at: 600,
    action: {
      _tag: 'SetError',
      error: 'AuthError',
      message: 'GitHub token is missing or expired. Run `gh auth login` to authenticate.',
    },
  },
]

// =============================================================================
// Simple single-step timeline factory
// =============================================================================

export const createSingleRunTimeline = ({
  jobs,
  errors = [],
  annotations = [],
  run = DEFAULT_RUN,
  runnerHostMap = [],
}: {
  jobs: readonly WorkflowJobVM[]
  errors?: readonly JobError[]
  annotations?: readonly AnnotationInfo[]
  run?: RunInfo
  runnerHostMap?: RunnerHostMap
}): TimelineStep[] => [
  { at: 600, action: loadedAction({ jobs, errors, annotations, run, runnerHostMap }) },
]
