/**
 * Test fixtures for CiOutput stories based on real dotfiles CI runs.
 */

import type { ApiMeta } from '../../../lib/apiMeta.ts'
import { computeSummary, directRunSelection } from '../../../lib/summary.ts'
import type {
  AnnotationInfo,
  JobError,
  PrHealth,
  RunInfo,
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

let _id = 68716421100
const nextId = () => _id++

// =============================================================================
// Factories
// =============================================================================

export const makeRun = (overrides: Partial<RunInfo> = {}): RunInfo => {
  const id = overrides.id ?? nextId()
  return {
    id,
    name: 'CI',
    runNumber: 1940 + (id % 100),
    headBranch: 'schickling/2026-03-22-better-ci-runner',
    status: 'completed',
    conclusion: 'success',
    event: 'push',
    workflowPath: '.github/workflows/ci.yml',
    htmlUrl: `https://github.com/schickling/dotfiles/actions/runs/${id}`,
    elapsedSeconds: 960,
    ...overrides,
  }
}

export const makeJob = (overrides: Partial<WorkflowJobVM> = {}): WorkflowJobVM => {
  const id = overrides.id ?? nextId()
  const steps = overrides.steps
  return {
    id,
    name: 'build',
    status: 'completed',
    conclusion: 'success',
    durationSeconds: 300,
    runner: 'dev3',
    jobUrl: `https://github.com/schickling/dotfiles/actions/runs/0/job/${id}`,
    ...(steps !== undefined ? { steps } : {}),
    failedStepName:
      overrides.failedStepName ?? steps?.find((s) => s.conclusion === 'failure')?.name ?? null,
    ...overrides,
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
  jobName: 'flake-build',
  stepName: 'Build flake outputs',
  errors: [
    "error: hash mismatch in fixed-output derivation '/nix/store/abc-foo-pnpm-deps.drv':",
    '         specified: sha256-Bmz3rCZlVPbo9LNQO0Kj7ePwnXBkkM0qoAedRcWYOP8=',
    '            got:    sha256-D0hZ7lywB4yxAvZECPJFOoHR2vnO0S+wbtOj4HdhO7U=',
  ],
  ...overrides,
})

export const prHealthConflicting: PrHealth = {
  prNumber: 506,
  mergeable: 'CONFLICTING',
  behindBy: 3,
  baseRefName: 'main',
}

export const prHealthBehind: PrHealth = {
  prNumber: 506,
  mergeable: 'MERGEABLE',
  behindBy: 7,
  baseRefName: 'main',
}

export const prHealthClean: PrHealth = {
  prNumber: 506,
  mergeable: 'MERGEABLE',
  behindBy: 0,
  baseRefName: 'main',
}

export const makeAnnotation = (overrides: Partial<AnnotationInfo> = {}): AnnotationInfo => ({
  jobName: 'flake-build',
  path: 'flake.nix',
  line: 1,
  message: 'Process completed with exit code 1',
  title: null,
  ...overrides,
})

// =============================================================================
// Real dotfiles CI: 12 jobs in typical start order
// =============================================================================

const DOTFILES_JOBS_ALL_PASS: Partial<WorkflowJobVM>[] = [
  { name: 'external-flakes-build', durationSeconds: 28, runner: 'dev3' },
  { name: 'molty2-build', durationSeconds: 244, runner: 'dev4' },
  { name: 'dev3-config-build', durationSeconds: 149, runner: 'dev3' },
  { name: 'mbp2025-config-build', durationSeconds: 204, runner: 'mbp2021' },
  { name: 'flake-build', durationSeconds: 317, runner: 'dev3' },
  { name: 'test-molty-proxy', durationSeconds: 695, runner: 'dev3' },
  { name: 'test-op-proxy', durationSeconds: 708, runner: 'dev3' },
  { name: 'test-oi', durationSeconds: 682, runner: 'dev3' },
  { name: 'test-factory', durationSeconds: 732, runner: 'dev3' },
  { name: 'test-gh-ci-exporter', durationSeconds: 719, runner: 'dev3' },
  { name: 'lint', durationSeconds: 954, runner: 'dev3' },
  { name: 'test-otel-cli', durationSeconds: 979, runner: 'dev3' },
]

// =============================================================================
// Pre-built Configs
// =============================================================================

export const allPassingJobs: readonly WorkflowJobVM[] = DOTFILES_JOBS_ALL_PASS.map((j) =>
  makeJob(j),
)

export const nixHashMismatchJobs: readonly WorkflowJobVM[] = [
  makeJob({ name: 'external-flakes-build', durationSeconds: 28, runner: 'dev3' }),
  makeJob({
    name: 'molty2-build',
    conclusion: 'failure',
    durationSeconds: 102,
    runner: 'dev4',
    steps: [{ name: 'Build NixOS configuration', status: 'completed', conclusion: 'failure' }],
  }),
  makeJob({
    name: 'dev3-config-build',
    conclusion: 'failure',
    durationSeconds: 163,
    runner: 'dev3',
    steps: [{ name: 'Build NixOS configuration', status: 'completed', conclusion: 'failure' }],
  }),
  makeJob({
    name: 'mbp2025-config-build',
    conclusion: 'failure',
    durationSeconds: 106,
    runner: 'mbp2021',
    steps: [{ name: 'Build nix-darwin configuration', status: 'completed', conclusion: 'failure' }],
  }),
  makeJob({
    name: 'flake-build',
    conclusion: 'failure',
    durationSeconds: 112,
    runner: 'dev3',
    steps: [{ name: 'Build flake outputs', status: 'completed', conclusion: 'failure' }],
  }),
  makeJob({ name: 'test-molty-proxy', durationSeconds: 695, runner: 'dev3' }),
  makeJob({ name: 'test-op-proxy', durationSeconds: 708, runner: 'dev3' }),
  makeJob({ name: 'test-oi', durationSeconds: 682, runner: 'dev3' }),
  makeJob({ name: 'test-factory', durationSeconds: 732, runner: 'dev3' }),
  makeJob({ name: 'test-gh-ci-exporter', durationSeconds: 719, runner: 'dev3' }),
  makeJob({ name: 'lint', durationSeconds: 954, runner: 'dev3' }),
  makeJob({ name: 'test-otel-cli', durationSeconds: 979, runner: 'dev3' }),
]

export const nixHashMismatchErrors: readonly JobError[] = [
  makeJobError({
    jobName: 'molty2-build',
    stepName: 'Build NixOS configuration',
    errors: [
      "error: hash mismatch in fixed-output derivation '/nix/store/86rvglikpzgrw7aad3x8i8ck26cdz5gj-op-proxy-pnpm-deps-47g6kspc-v3-0.0.0.drv':",
      '         specified: sha256-Bmz3rCZlVPbo9LNQO0Kj7ePwnXBkkM0qoAedRcWYOP8=',
      '            got:    sha256-D0hZ7lywB4yxAvZECPJFOoHR2vnO0S+wbtOj4HdhO7U=',
      '(12 downstream build failures omitted)',
    ],
  }),
  makeJobError({
    jobName: 'dev3-config-build',
    stepName: 'Build NixOS configuration',
    errors: [
      "error: hash mismatch in fixed-output derivation '/nix/store/x9vqrn6ph60f40jc322sjab9i4s05bas-agent-exporter-pnpm-deps.drv':",
      '         specified: sha256-MJXkpclNpd/v8URmWc9lDbzP8fAFuj+xzlyGnpciZfU=',
      '            got:    sha256-G3BjWmdqH4K2UsHPeNQFUPA9meQL3xi66Hwi0jdEDR0=',
      '(8 downstream build failures omitted)',
    ],
  }),
  makeJobError({
    jobName: 'mbp2025-config-build',
    stepName: 'Build nix-darwin configuration',
    errors: [
      "error: hash mismatch in fixed-output derivation '/nix/store/qihzy4zw146vrkp33lr47xbamyk5x9g8-discord-agent-pnpm-deps.drv':",
      '         specified: sha256-Z/P87R6hco6HZXWoQPHyw0Cl9CP5AgtH6y/oXLX2Wvg=',
      '            got:    sha256-ClsQzg6Nr8EU5jlSrEsOSzqOYMpBMGPldba+jmjtL2o=',
      '(5 downstream build failures omitted)',
    ],
  }),
  makeJobError({
    jobName: 'flake-build',
    stepName: 'Build flake outputs',
    errors: [
      "error: hash mismatch in fixed-output derivation '/nix/store/sc35mxna4l3i6grinhsf21bs1v91h4s9-op-proxy-pnpm-deps.drv':",
      '         specified: sha256-GuH/VFisQ1udB9qE4PcLjMYVQcyyaUYIjMPNeYdXchA=',
      '            got:    sha256-XlwsWSwwS48KO7RGCZWeoygtS3LAnHzgYvrAy+DDyuM=',
    ],
  }),
]

export const nixHashMismatchAnnotations: readonly AnnotationInfo[] = [
  makeAnnotation({
    jobName: 'molty2-build',
    path: 'flake.nix',
    line: 127,
    message: 'Process completed with exit code 1',
  }),
  makeAnnotation({
    jobName: 'dev3-config-build',
    path: 'nixpkgs/nixos/dev3/configuration.nix',
    line: 47,
    message: 'Process completed with exit code 1',
  }),
]

export const lintFailureJobs: readonly WorkflowJobVM[] = [
  makeJob({ name: 'external-flakes-build', durationSeconds: 28, runner: 'dev3' }),
  makeJob({ name: 'molty2-build', durationSeconds: 244, runner: 'dev4' }),
  makeJob({ name: 'dev3-config-build', durationSeconds: 149, runner: 'dev3' }),
  makeJob({ name: 'mbp2025-config-build', durationSeconds: 204, runner: 'mbp2021' }),
  makeJob({ name: 'flake-build', durationSeconds: 317, runner: 'dev3' }),
  makeJob({ name: 'test-molty-proxy', durationSeconds: 695, runner: 'dev3' }),
  makeJob({ name: 'test-op-proxy', durationSeconds: 708, runner: 'dev3' }),
  makeJob({ name: 'test-oi', durationSeconds: 682, runner: 'dev3' }),
  makeJob({ name: 'test-factory', durationSeconds: 732, runner: 'dev3' }),
  makeJob({ name: 'test-gh-ci-exporter', durationSeconds: 719, runner: 'dev3' }),
  makeJob({
    name: 'lint',
    conclusion: 'failure',
    durationSeconds: 954,
    runner: 'dev3',
    steps: [{ name: 'Format + lint', status: 'completed', conclusion: 'failure' }],
  }),
  makeJob({ name: 'test-otel-cli', durationSeconds: 979, runner: 'dev3' }),
]

export const lintFailureErrors: readonly JobError[] = [
  makeJobError({
    jobName: 'lint',
    stepName: 'Format + lint',
    errors: [
      'Checking formatting...',
      'flakes/gh-ci-utils/src/commands/show.ts (0ms)',
      'Format issues found in above 15 files.',
    ],
  }),
]

export const inProgressJobs: readonly WorkflowJobVM[] = [
  makeJob({ name: 'external-flakes-build', durationSeconds: 28, runner: 'dev3' }),
  makeJob({ name: 'molty2-build', durationSeconds: 244, runner: 'dev4' }),
  makeJob({ name: 'dev3-config-build', durationSeconds: 149, runner: 'dev3' }),
  makeJob({ name: 'mbp2025-config-build', durationSeconds: 204, runner: 'mbp2021' }),
  makeJob({
    name: 'flake-build',
    status: 'in_progress',
    conclusion: null,
    durationSeconds: 210,
    runner: 'dev3',
  }),
  makeJob({
    name: 'test-molty-proxy',
    status: 'in_progress',
    conclusion: null,
    durationSeconds: 340,
    runner: 'dev3',
  }),
  makeJob({
    name: 'test-op-proxy',
    status: 'in_progress',
    conclusion: null,
    durationSeconds: 335,
    runner: 'dev3',
  }),
  makeJob({
    name: 'test-oi',
    status: 'in_progress',
    conclusion: null,
    durationSeconds: 320,
    runner: 'dev3',
  }),
  makeJob({
    name: 'test-factory',
    status: 'in_progress',
    conclusion: null,
    durationSeconds: 310,
    runner: 'dev3',
  }),
  makeJob({
    name: 'test-gh-ci-exporter',
    status: 'in_progress',
    conclusion: null,
    durationSeconds: 315,
    runner: 'dev3',
  }),
  makeJob({
    name: 'lint',
    status: 'in_progress',
    conclusion: null,
    durationSeconds: 180,
    runner: 'dev3',
  }),
  makeJob({
    name: 'test-otel-cli',
    status: 'in_progress',
    conclusion: null,
    durationSeconds: 120,
    runner: 'dev3',
  }),
]

export const allQueuedJobs: readonly WorkflowJobVM[] = DOTFILES_JOBS_ALL_PASS.map((j) =>
  makeJob({
    ...j,
    status: 'queued',
    conclusion: null,
    durationSeconds: 0,
    runner: '—',
  }),
)

export const cancelledJobs: readonly WorkflowJobVM[] = [
  makeJob({ name: 'external-flakes-build', durationSeconds: 28, runner: 'dev3' }),
  makeJob({ name: 'molty2-build', durationSeconds: 102, runner: 'dev4' }),
  makeJob({
    name: 'dev3-config-build',
    conclusion: 'cancelled',
    durationSeconds: 85,
    runner: 'dev3',
  }),
  makeJob({
    name: 'mbp2025-config-build',
    conclusion: 'cancelled',
    durationSeconds: 72,
    runner: 'mbp2021',
  }),
  makeJob({
    name: 'flake-build',
    conclusion: 'cancelled',
    durationSeconds: 95,
    runner: 'dev3',
  }),
  makeJob({
    name: 'test-molty-proxy',
    conclusion: 'cancelled',
    durationSeconds: 0,
    runner: '—',
  }),
  makeJob({
    name: 'test-op-proxy',
    conclusion: 'cancelled',
    durationSeconds: 0,
    runner: '—',
  }),
  makeJob({
    name: 'test-oi',
    conclusion: 'cancelled',
    durationSeconds: 0,
    runner: '—',
  }),
  makeJob({
    name: 'test-factory',
    conclusion: 'cancelled',
    durationSeconds: 0,
    runner: '—',
  }),
  makeJob({
    name: 'test-gh-ci-exporter',
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
    name: 'test-otel-cli',
    conclusion: 'cancelled',
    durationSeconds: 0,
    runner: '—',
  }),
]

// =============================================================================
// State Factories
// =============================================================================

const DEFAULT_RUN = makeRun({
  id: 23601797547,
  runNumber: 1940,
  headBranch: 'schickling/2026-03-22-better-ci-runner',
  event: 'pull_request',
})

const IN_PROGRESS_RUN = makeRun({
  id: 23601797547,
  runNumber: 1940,
  headBranch: 'schickling/2026-03-22-better-ci-runner',
  event: 'pull_request',
  status: 'in_progress',
  conclusion: null,
  elapsedSeconds: 380,
})

const CANCELLED_RUN = makeRun({
  id: 23601797547,
  runNumber: 1940,
  headBranch: 'schickling/2026-03-22-better-ci-runner',
  event: 'pull_request',
  status: 'completed',
  conclusion: 'cancelled',
  elapsedSeconds: 130,
})

const FAILURE_RUN = makeRun({
  id: 23601797547,
  runNumber: 1940,
  headBranch: 'schickling/2026-03-22-better-ci-runner',
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
  steps?: WorkflowJobVM['steps']
}

type JobState = {
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: string | null
  runner: string
  /** For completed jobs: final duration. For in-progress: unused (computed from startedAtSeconds). */
  durationSeconds: number
  /** Real-time seconds when the job started (for computing elapsed time on in-progress jobs). */
  startedAtSeconds: number
  steps: WorkflowJobVM['steps']
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
// Dotfiles job names (canonical order)
// =============================================================================

const DOTFILES_JOB_NAMES = DOTFILES_JOBS_ALL_PASS.map((j) => j.name!)

// =============================================================================
// AllPassing timeline (~38 beats)
// =============================================================================

export const createAllPassingTimeline = (): TimelineStep[] => {
  const events: JobEvent[] = [
    // t=0: all 12 queued
    ...DOTFILES_JOB_NAMES.map((name): JobEvent => ({ realTimeSeconds: 0, name, event: 'queued' })),

    // t=2: first wave runners assigned + start
    { realTimeSeconds: 2, name: 'external-flakes-build', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 2, name: 'external-flakes-build', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 2, name: 'molty2-build', event: 'runner_assigned', runner: 'dev4' },
    { realTimeSeconds: 2, name: 'molty2-build', event: 'in_progress', runner: 'dev4' },
    { realTimeSeconds: 2, name: 'dev3-config-build', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 2, name: 'dev3-config-build', event: 'in_progress', runner: 'dev3' },

    // t=3: second wave
    {
      realTimeSeconds: 8,
      name: 'mbp2025-config-build',
      event: 'runner_assigned',
      runner: 'mbp2021',
    },
    { realTimeSeconds: 8, name: 'mbp2025-config-build', event: 'in_progress', runner: 'mbp2021' },
    { realTimeSeconds: 8, name: 'test-molty-proxy', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 8, name: 'test-molty-proxy', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 8, name: 'test-op-proxy', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 8, name: 'test-op-proxy', event: 'in_progress', runner: 'dev3' },

    // t=14: third wave
    { realTimeSeconds: 14, name: 'test-oi', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 14, name: 'test-oi', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 14, name: 'test-factory', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 14, name: 'test-factory', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 14, name: 'test-gh-ci-exporter', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 14, name: 'test-gh-ci-exporter', event: 'in_progress', runner: 'dev3' },

    // t=28: external-flakes-build done
    {
      realTimeSeconds: 28,
      name: 'external-flakes-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=45: flake-build picks up freed runner
    { realTimeSeconds: 45, name: 'flake-build', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 45, name: 'flake-build', event: 'in_progress', runner: 'dev3' },

    // t=102: molty2-build done
    {
      realTimeSeconds: 102,
      name: 'molty2-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev4',
    },

    // t=120: lint starts on freed runner
    { realTimeSeconds: 120, name: 'lint', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 120, name: 'lint', event: 'in_progress', runner: 'dev3' },

    // t=149: dev3-config done
    {
      realTimeSeconds: 149,
      name: 'dev3-config-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=180: test-otel-cli starts
    { realTimeSeconds: 180, name: 'test-otel-cli', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 180, name: 'test-otel-cli', event: 'in_progress', runner: 'dev3' },

    // t=204: mbp2025 done
    {
      realTimeSeconds: 204,
      name: 'mbp2025-config-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'mbp2021',
    },

    // t=317: flake-build done
    {
      realTimeSeconds: 317,
      name: 'flake-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=450: poll tick (jobs still running, duration updates)
    { realTimeSeconds: 450, name: 'test-oi', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 450, name: 'test-molty-proxy', event: 'in_progress', runner: 'dev3' },

    // t=550: poll tick
    { realTimeSeconds: 550, name: 'test-op-proxy', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 550, name: 'lint', event: 'in_progress', runner: 'dev3' },

    // t=630: poll tick
    { realTimeSeconds: 630, name: 'test-factory', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 630, name: 'test-gh-ci-exporter', event: 'in_progress', runner: 'dev3' },

    // t=682: test-oi done
    {
      realTimeSeconds: 682,
      name: 'test-oi',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=695: test-molty-proxy done
    {
      realTimeSeconds: 695,
      name: 'test-molty-proxy',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=708: test-op-proxy done
    {
      realTimeSeconds: 708,
      name: 'test-op-proxy',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=719: test-gh-ci-exporter done
    {
      realTimeSeconds: 719,
      name: 'test-gh-ci-exporter',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=732: test-factory done
    {
      realTimeSeconds: 732,
      name: 'test-factory',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=800: poll tick (lint + otel still going)
    { realTimeSeconds: 800, name: 'lint', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 800, name: 'test-otel-cli', event: 'in_progress', runner: 'dev3' },

    // t=900: poll tick
    { realTimeSeconds: 900, name: 'lint', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 900, name: 'test-otel-cli', event: 'in_progress', runner: 'dev3' },

    // t=954: lint done
    {
      realTimeSeconds: 954,
      name: 'lint',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=979: test-otel-cli done -> RUN COMPLETE
    {
      realTimeSeconds: 979,
      name: 'test-otel-cli',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },
  ]

  return buildTimeline({
    events,
    allJobNames: DOTFILES_JOB_NAMES,
    run: IN_PROGRESS_RUN,
    finalRun: DEFAULT_RUN,
  })
}

// =============================================================================
// NixHashMismatch timeline (~30 beats)
// =============================================================================

export const createNixHashMismatchTimeline = (): TimelineStep[] => {
  const errorsByJob = new Map<string, readonly JobError[]>([
    ['molty2-build', [nixHashMismatchErrors[0]!]],
    ['dev3-config-build', [nixHashMismatchErrors[1]!]],
    ['mbp2025-config-build', [nixHashMismatchErrors[2]!]],
    ['flake-build', [nixHashMismatchErrors[3]!]],
  ])
  const annotationsByJob = new Map<string, readonly AnnotationInfo[]>([
    ['molty2-build', [nixHashMismatchAnnotations[0]!]],
    ['dev3-config-build', [nixHashMismatchAnnotations[1]!]],
  ])

  const events: JobEvent[] = [
    // t=0: all queued
    ...DOTFILES_JOB_NAMES.map((name): JobEvent => ({ realTimeSeconds: 0, name, event: 'queued' })),

    // t=2: first wave starts
    { realTimeSeconds: 2, name: 'external-flakes-build', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 2, name: 'external-flakes-build', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 2, name: 'molty2-build', event: 'runner_assigned', runner: 'dev4' },
    { realTimeSeconds: 2, name: 'molty2-build', event: 'in_progress', runner: 'dev4' },
    { realTimeSeconds: 2, name: 'dev3-config-build', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 2, name: 'dev3-config-build', event: 'in_progress', runner: 'dev3' },

    // t=8: second wave
    {
      realTimeSeconds: 8,
      name: 'mbp2025-config-build',
      event: 'runner_assigned',
      runner: 'mbp2021',
    },
    { realTimeSeconds: 8, name: 'mbp2025-config-build', event: 'in_progress', runner: 'mbp2021' },
    { realTimeSeconds: 8, name: 'test-molty-proxy', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 8, name: 'test-molty-proxy', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 8, name: 'test-op-proxy', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 8, name: 'test-op-proxy', event: 'in_progress', runner: 'dev3' },

    // t=14: third wave
    { realTimeSeconds: 14, name: 'test-oi', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 14, name: 'test-oi', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 14, name: 'test-factory', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 14, name: 'test-factory', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 14, name: 'test-gh-ci-exporter', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 14, name: 'test-gh-ci-exporter', event: 'in_progress', runner: 'dev3' },

    // t=28: external-flakes-build done
    {
      realTimeSeconds: 28,
      name: 'external-flakes-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=36: molty2-build FAILS (hash mismatch)
    {
      realTimeSeconds: 36,
      name: 'molty2-build',
      event: 'completed',
      conclusion: 'failure',
      runner: 'dev4',
      steps: [{ name: 'Build NixOS configuration', status: 'completed', conclusion: 'failure' }],
    },

    // t=43: dev3-config-build FAILS (cascade)
    {
      realTimeSeconds: 43,
      name: 'dev3-config-build',
      event: 'completed',
      conclusion: 'failure',
      runner: 'dev3',
      steps: [{ name: 'Build NixOS configuration', status: 'completed', conclusion: 'failure' }],
    },

    // t=46: mbp2025 FAILS (cascade)
    {
      realTimeSeconds: 50,
      name: 'mbp2025-config-build',
      event: 'completed',
      conclusion: 'failure',
      runner: 'mbp2021',
      steps: [
        { name: 'Build nix-darwin configuration', status: 'completed', conclusion: 'failure' },
      ],
    },

    // t=52: flake-build starts and immediately fails
    { realTimeSeconds: 52, name: 'flake-build', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 52, name: 'flake-build', event: 'in_progress', runner: 'dev3' },
    {
      realTimeSeconds: 58,
      name: 'flake-build',
      event: 'completed',
      conclusion: 'failure',
      runner: 'dev3',
      steps: [{ name: 'Build flake outputs', status: 'completed', conclusion: 'failure' }],
    },

    // t=70: lint starts on freed runner
    { realTimeSeconds: 70, name: 'lint', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 70, name: 'lint', event: 'in_progress', runner: 'dev3' },

    // t=80: test-otel-cli starts
    { realTimeSeconds: 80, name: 'test-otel-cli', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 80, name: 'test-otel-cli', event: 'in_progress', runner: 'dev3' },

    // Poll ticks while tests run
    { realTimeSeconds: 200, name: 'test-oi', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 300, name: 'test-molty-proxy', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 400, name: 'test-op-proxy', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 500, name: 'test-factory', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 500, name: 'test-gh-ci-exporter', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 600, name: 'lint', event: 'in_progress', runner: 'dev3' },

    // t=682: test-oi done
    {
      realTimeSeconds: 682,
      name: 'test-oi',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=695: test-molty-proxy done
    {
      realTimeSeconds: 695,
      name: 'test-molty-proxy',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=708: test-op-proxy done
    {
      realTimeSeconds: 708,
      name: 'test-op-proxy',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=719: test-gh-ci-exporter done
    {
      realTimeSeconds: 719,
      name: 'test-gh-ci-exporter',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=732: test-factory done
    {
      realTimeSeconds: 732,
      name: 'test-factory',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=800: poll tick
    { realTimeSeconds: 800, name: 'lint', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 800, name: 'test-otel-cli', event: 'in_progress', runner: 'dev3' },

    // t=954: lint done
    {
      realTimeSeconds: 954,
      name: 'lint',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=979: test-otel-cli done -> COMPLETE (with failures)
    {
      realTimeSeconds: 979,
      name: 'test-otel-cli',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },
  ]

  return buildTimeline({
    events,
    allJobNames: DOTFILES_JOB_NAMES,
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
    ...DOTFILES_JOB_NAMES.map((name): JobEvent => ({ realTimeSeconds: 0, name, event: 'queued' })),

    // t=2: first wave
    { realTimeSeconds: 2, name: 'external-flakes-build', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 2, name: 'external-flakes-build', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 2, name: 'molty2-build', event: 'runner_assigned', runner: 'dev4' },
    { realTimeSeconds: 2, name: 'molty2-build', event: 'in_progress', runner: 'dev4' },
    { realTimeSeconds: 2, name: 'dev3-config-build', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 2, name: 'dev3-config-build', event: 'in_progress', runner: 'dev3' },

    // t=8: second wave
    {
      realTimeSeconds: 8,
      name: 'mbp2025-config-build',
      event: 'runner_assigned',
      runner: 'mbp2021',
    },
    { realTimeSeconds: 8, name: 'mbp2025-config-build', event: 'in_progress', runner: 'mbp2021' },
    { realTimeSeconds: 8, name: 'test-molty-proxy', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 8, name: 'test-molty-proxy', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 8, name: 'test-op-proxy', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 8, name: 'test-op-proxy', event: 'in_progress', runner: 'dev3' },

    // t=14: third wave
    { realTimeSeconds: 14, name: 'test-oi', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 14, name: 'test-oi', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 14, name: 'test-factory', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 14, name: 'test-factory', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 14, name: 'test-gh-ci-exporter', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 14, name: 'test-gh-ci-exporter', event: 'in_progress', runner: 'dev3' },

    // t=28: external-flakes-build done
    {
      realTimeSeconds: 28,
      name: 'external-flakes-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=45: flake-build starts
    { realTimeSeconds: 45, name: 'flake-build', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 45, name: 'flake-build', event: 'in_progress', runner: 'dev3' },

    // t=102: molty2-build done
    {
      realTimeSeconds: 102,
      name: 'molty2-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev4',
    },

    // t=120: lint starts
    { realTimeSeconds: 120, name: 'lint', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 120, name: 'lint', event: 'in_progress', runner: 'dev3' },

    // t=149: dev3-config done
    {
      realTimeSeconds: 149,
      name: 'dev3-config-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=180: test-otel-cli starts
    { realTimeSeconds: 180, name: 'test-otel-cli', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 180, name: 'test-otel-cli', event: 'in_progress', runner: 'dev3' },

    // t=204: mbp2025 done
    {
      realTimeSeconds: 204,
      name: 'mbp2025-config-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'mbp2021',
    },

    // t=317: flake-build done
    {
      realTimeSeconds: 317,
      name: 'flake-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // Poll ticks
    { realTimeSeconds: 450, name: 'test-oi', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 450, name: 'test-molty-proxy', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 550, name: 'test-op-proxy', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 550, name: 'lint', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 630, name: 'test-factory', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 630, name: 'test-gh-ci-exporter', event: 'in_progress', runner: 'dev3' },

    // t=682: test-oi done
    {
      realTimeSeconds: 682,
      name: 'test-oi',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=695: test-molty-proxy done
    {
      realTimeSeconds: 695,
      name: 'test-molty-proxy',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=708: test-op-proxy done
    {
      realTimeSeconds: 708,
      name: 'test-op-proxy',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=719: test-gh-ci-exporter done
    {
      realTimeSeconds: 719,
      name: 'test-gh-ci-exporter',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=732: test-factory done
    {
      realTimeSeconds: 732,
      name: 'test-factory',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=800: poll tick
    { realTimeSeconds: 800, name: 'lint', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 800, name: 'test-otel-cli', event: 'in_progress', runner: 'dev3' },

    // t=900: poll tick
    { realTimeSeconds: 900, name: 'lint', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 900, name: 'test-otel-cli', event: 'in_progress', runner: 'dev3' },

    // t=954: lint FAILS
    {
      realTimeSeconds: 954,
      name: 'lint',
      event: 'completed',
      conclusion: 'failure',
      runner: 'dev3',
      steps: [{ name: 'Format + lint', status: 'completed', conclusion: 'failure' }],
    },

    // t=979: test-otel-cli done -> COMPLETE
    {
      realTimeSeconds: 979,
      name: 'test-otel-cli',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },
  ]

  return buildTimeline({
    events,
    allJobNames: DOTFILES_JOB_NAMES,
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
    ...DOTFILES_JOB_NAMES.map((name): JobEvent => ({ realTimeSeconds: 0, name, event: 'queued' })),

    // t=2: first wave
    { realTimeSeconds: 2, name: 'external-flakes-build', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 2, name: 'external-flakes-build', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 2, name: 'molty2-build', event: 'runner_assigned', runner: 'dev4' },
    { realTimeSeconds: 2, name: 'molty2-build', event: 'in_progress', runner: 'dev4' },
    { realTimeSeconds: 2, name: 'dev3-config-build', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 2, name: 'dev3-config-build', event: 'in_progress', runner: 'dev3' },

    // t=8: second wave
    {
      realTimeSeconds: 8,
      name: 'mbp2025-config-build',
      event: 'runner_assigned',
      runner: 'mbp2021',
    },
    { realTimeSeconds: 8, name: 'mbp2025-config-build', event: 'in_progress', runner: 'mbp2021' },
    { realTimeSeconds: 8, name: 'test-molty-proxy', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 8, name: 'test-molty-proxy', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 8, name: 'test-op-proxy', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 8, name: 'test-op-proxy', event: 'in_progress', runner: 'dev3' },

    // t=14: third wave
    { realTimeSeconds: 14, name: 'test-oi', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 14, name: 'test-oi', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 14, name: 'test-factory', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 14, name: 'test-factory', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 14, name: 'test-gh-ci-exporter', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 14, name: 'test-gh-ci-exporter', event: 'in_progress', runner: 'dev3' },

    // t=28: external-flakes-build done
    {
      realTimeSeconds: 28,
      name: 'external-flakes-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=45: flake-build starts
    { realTimeSeconds: 45, name: 'flake-build', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 45, name: 'flake-build', event: 'in_progress', runner: 'dev3' },

    // t=102: molty2-build done
    {
      realTimeSeconds: 102,
      name: 'molty2-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev4',
    },

    // t=120: lint starts
    { realTimeSeconds: 120, name: 'lint', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 120, name: 'lint', event: 'in_progress', runner: 'dev3' },

    // t=149: dev3-config done
    {
      realTimeSeconds: 149,
      name: 'dev3-config-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=180: test-otel-cli starts
    { realTimeSeconds: 180, name: 'test-otel-cli', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 180, name: 'test-otel-cli', event: 'in_progress', runner: 'dev3' },

    // t=204: mbp2025 done
    {
      realTimeSeconds: 204,
      name: 'mbp2025-config-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'mbp2021',
    },

    // Poll ticks showing progress
    { realTimeSeconds: 280, name: 'flake-build', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 280, name: 'test-molty-proxy', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 350, name: 'test-op-proxy', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 350, name: 'test-oi', event: 'in_progress', runner: 'dev3' },

    // t=380: snapshot freezes here (story stays at this state)
    { realTimeSeconds: 380, name: 'test-factory', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 380, name: 'test-gh-ci-exporter', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 380, name: 'lint', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 380, name: 'test-otel-cli', event: 'in_progress', runner: 'dev3' },
  ]

  return buildTimeline({
    events,
    allJobNames: DOTFILES_JOB_NAMES,
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
    ...DOTFILES_JOB_NAMES.map((name): JobEvent => ({ realTimeSeconds: 0, name, event: 'queued' })),

    // t=2: first wave
    { realTimeSeconds: 2, name: 'external-flakes-build', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 2, name: 'external-flakes-build', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 2, name: 'molty2-build', event: 'runner_assigned', runner: 'dev4' },
    { realTimeSeconds: 2, name: 'molty2-build', event: 'in_progress', runner: 'dev4' },
    { realTimeSeconds: 2, name: 'dev3-config-build', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 2, name: 'dev3-config-build', event: 'in_progress', runner: 'dev3' },

    // t=8: second wave
    {
      realTimeSeconds: 8,
      name: 'mbp2025-config-build',
      event: 'runner_assigned',
      runner: 'mbp2021',
    },
    { realTimeSeconds: 8, name: 'mbp2025-config-build', event: 'in_progress', runner: 'mbp2021' },
    { realTimeSeconds: 8, name: 'test-molty-proxy', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 8, name: 'test-molty-proxy', event: 'in_progress', runner: 'dev3' },
    { realTimeSeconds: 8, name: 'test-op-proxy', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 8, name: 'test-op-proxy', event: 'in_progress', runner: 'dev3' },

    // t=14: third wave (some start)
    { realTimeSeconds: 14, name: 'test-oi', event: 'runner_assigned', runner: 'dev3' },
    { realTimeSeconds: 14, name: 'test-oi', event: 'in_progress', runner: 'dev3' },

    // t=28: external-flakes-build done
    {
      realTimeSeconds: 28,
      name: 'external-flakes-build',
      event: 'completed',
      conclusion: 'success',
      runner: 'dev3',
    },

    // t=50: poll tick
    { realTimeSeconds: 50, name: 'molty2-build', event: 'in_progress', runner: 'dev4' },
    { realTimeSeconds: 50, name: 'dev3-config-build', event: 'in_progress', runner: 'dev3' },

    // t=80: poll tick
    { realTimeSeconds: 80, name: 'mbp2025-config-build', event: 'in_progress', runner: 'mbp2021' },

    // t=95: user cancels -> running jobs transition to cancelled one by one
    {
      realTimeSeconds: 95,
      name: 'molty2-build',
      event: 'completed',
      conclusion: 'cancelled',
      runner: 'dev4',
    },
    {
      realTimeSeconds: 95,
      name: 'test-oi',
      event: 'completed',
      conclusion: 'cancelled',
      runner: 'dev3',
    },

    {
      realTimeSeconds: 97,
      name: 'dev3-config-build',
      event: 'completed',
      conclusion: 'cancelled',
      runner: 'dev3',
    },
    {
      realTimeSeconds: 97,
      name: 'mbp2025-config-build',
      event: 'completed',
      conclusion: 'cancelled',
      runner: 'mbp2021',
    },
    {
      realTimeSeconds: 97,
      name: 'test-molty-proxy',
      event: 'completed',
      conclusion: 'cancelled',
      runner: 'dev3',
    },

    {
      realTimeSeconds: 100,
      name: 'test-op-proxy',
      event: 'completed',
      conclusion: 'cancelled',
      runner: 'dev3',
    },
    { realTimeSeconds: 100, name: 'flake-build', event: 'completed', conclusion: 'cancelled' },
    { realTimeSeconds: 100, name: 'test-factory', event: 'completed', conclusion: 'cancelled' },
    {
      realTimeSeconds: 100,
      name: 'test-gh-ci-exporter',
      event: 'completed',
      conclusion: 'cancelled',
    },
    { realTimeSeconds: 100, name: 'lint', event: 'completed', conclusion: 'cancelled' },
    { realTimeSeconds: 100, name: 'test-otel-cli', event: 'completed', conclusion: 'cancelled' },
  ]

  return buildTimeline({
    events,
    allJobNames: DOTFILES_JOB_NAMES,
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
