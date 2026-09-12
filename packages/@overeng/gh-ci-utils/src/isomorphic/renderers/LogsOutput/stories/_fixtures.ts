/** Test fixtures for Logs stories with realistic CI log data. */

import type { ApiMeta } from '../../../lib/apiMeta.ts'
import type { LogsAction, LogsState } from '../schema.ts'

const realisticMeta: ApiMeta = {
  apiRequests: 3,
  apiRequestsCached: 1,
  rateLimitRemaining: 4997,
  rateLimitLimit: 5000,
}

// =============================================================================
// State Factories
// =============================================================================

export const loadingState = (): LogsState => ({
  _tag: 'Loading',
  message: 'Fetching logs...',
  _meta: { apiRequests: 0, apiRequestsCached: 0, rateLimitRemaining: 0, rateLimitLimit: 0 },
})

export const noLogsState = (): LogsState => ({
  _tag: 'NoLogs',
  message: 'No logs available for this job. The job may still be queued.',
  conclusion: 'success',
  _meta: realisticMeta,
})

// ---------------------------------------------------------------------------
// Synthetic CI log lines with realistic parser shapes
// ---------------------------------------------------------------------------

const LINT_LOG_LINES: readonly string[] = [
  '2026-03-26T15:48:09.3840428Z Configuring shell',
  '2026-03-26T15:48:20.4050769Z Configuring shell in 11.0s',
  '2026-03-26T15:48:20.4211065Z Loading tasks',
  '2026-03-26T15:48:20.4246136Z Loading tasks in 3.58ms',
  '2026-03-26T15:48:20.5182884Z Running tasks     lint:check',
  '2026-03-26T15:48:20.5184457Z Running           lint:check:oxlint',
  '2026-03-26T15:48:20.5184633Z Running           setup:gate',
  '2026-03-26T15:48:20.5185018Z Running           lint:check:format',
  '2026-03-26T15:48:20.5261114Z Running           mr:fetch-apply',
  '2026-03-26T15:48:22.7087804Z Succeeded         lint:check:format (2.19s)',
  '2026-03-26T15:48:22.8113200Z Succeeded         setup:gate (2.29s)',
  '2026-03-26T15:48:24.5920381Z Running           lint:check:genie',
  '2026-03-26T15:48:24.5921100Z Running           pnpm:install:example-app-utils',
  '2026-03-26T15:48:24.5921350Z Running           pnpm:install:example-lib-utils',
  '2026-03-26T15:48:24.6204537Z Succeeded         lint:check:oxlint (4.10s)',
  '2026-03-26T15:48:27.3041872Z Succeeded         mr:fetch-apply (6.78s)',
  '2026-03-26T15:48:27.4051872Z Running           mr:check',
  '2026-03-26T15:48:27.5061872Z Running           pnpm:install',
  '2026-03-26T15:48:28.1061872Z Succeeded         pnpm:install:example-app-utils (3.52s)',
  '2026-03-26T15:48:29.2061872Z Succeeded         pnpm:install:example-lib-utils (4.61s)',
  '2026-03-26T15:48:30.6061872Z Succeeded         lint:check:genie (6.01s)',
  '2026-03-26T15:48:31.2061872Z Running           lint:check:genie:coverage',
  '2026-03-26T15:48:31.5061872Z Running           lint:check:lockfile',
  '2026-03-26T15:48:32.1061872Z Cached            mr:check',
  '2026-03-26T15:48:33.5061872Z Succeeded         lint:check:lockfile (2.00s)',
  '2026-03-26T15:48:34.2061872Z Succeeded         pnpm:install (6.70s)',
  '2026-03-26T15:48:34.8061872Z Running           lint:check',
  '2026-03-26T15:48:35.2061872Z Succeeded         lint:check:genie:coverage (4.00s)',
  '2026-03-26T15:48:36.4061872Z Running           ts:check',
  '2026-03-26T15:48:42.1061872Z Succeeded         lint:check (7.30s)',
  '2026-03-26T15:57:10.5061872Z Succeeded         ts:check (8m 34s)',
  '2026-03-26T15:57:10.6061872Z Running tasks in 8m 50s',
  '2026-03-26T15:57:10.7061872Z 0 Skipped, 15 Succeeded, 0 Failed',
]

const FLAKE_BUILD_FAILED_LINES: readonly string[] = [
  '2026-03-28T09:29:49.1976782Z Pinned devenv rev: 1111111111111111111111111111111111111111',
  '2026-03-28T09:29:50.4821000Z Fetching flake inputs...',
  '2026-03-28T09:29:50.9103200Z Fetching github:example-org/base-packages/2222222...',
  '2026-03-28T09:29:51.3421800Z Fetching github:example-org/example-infra/main...',
  '2026-03-28T09:29:52.2152068Z Resolving deltas: 100% (481/481), done.',
  '2026-03-28T09:29:52.5012300Z Evaluating flake outputs...',
  '2026-03-28T09:29:52.8134500Z Building derivation /nix/store/0123456789abcdfghijklmnpqrsvwxyz-example-service.drv...',
  '2026-03-28T09:29:53.0532800Z error:',
  "2026-03-28T09:29:53.0533357Z        … while calling the 'derivationStrict' builtin",
  '2026-03-28T09:29:53.0533899Z          at «nix-internal»/derivation-internal.nix:38:12:',
  '2026-03-28T09:29:53.0534192Z            37|',
  '2026-03-28T09:29:53.0534439Z            38|   strict = drvFunc drvAttrs;',
  '2026-03-28T09:29:53.0534963Z              |            ^',
  '2026-03-28T09:29:53.0535153Z            39|',
  "2026-03-28T09:29:53.0535414Z        … while evaluating derivation 'example-service'",
  '2026-03-28T09:29:53.0536572Z          whose name attribute is located at «github:example-org/base-packages/2222222»/pkgs/stdenv/generic/make-derivation.nix:536:13',
  "2026-03-28T09:29:53.0538123Z        (stack trace truncated; use '--show-trace' to show the full, detailed trace)",
  '2026-03-28T09:29:53.0538834Z        error: Failed to open archive (Source threw exception: error:',
  "2026-03-28T09:29:53.0539340Z               … during download of 'https://api.example.invalid/repos/example-org/shared-source/tarball/3333333333'",
  "2026-03-28T09:29:53.0539968Z               error: unable to download '...': HTTP error 401",
  '2026-03-28T09:29:53.0540443Z               response body:',
  '2026-03-28T09:29:53.0540597Z               {',
  '2026-03-28T09:29:53.0541000Z                 "message": "Bad credentials",',
  '2026-03-28T09:29:53.0541200Z                 "documentation_url": "https://docs.example.invalid/rest"',
  '2026-03-28T09:29:53.0541400Z               })',
  '2026-03-28T09:29:53.0541800Z ##[error]Process completed with exit code 1.',
]

const ERROR_FILTERED_LINES: readonly string[] = [
  '##[error]resolve_devenv failed. Last 30 lines of log:',
  '##[error]Process completed with exit code 1.',
]

const GREP_NIX_LINES: readonly string[] = [
  '2026-03-28T09:29:49.1976782Z Pinned devenv rev: 1111111111111111111111111111111111111111',
  '2026-03-28T09:29:53.0532800Z error:',
  "2026-03-28T09:29:53.0535414Z        … while evaluating derivation 'example-service'",
  '2026-03-28T09:29:53.0538834Z        error: Failed to open archive (Source threw exception: error:',
  "2026-03-28T09:29:53.0539968Z               error: unable to download '...': HTTP error 401",
]

// ---------------------------------------------------------------------------
// State factories
// ---------------------------------------------------------------------------

export const successState = (): LogsState => ({
  _tag: 'Loaded',
  jobName: 'lint',
  conclusion: 'success',
  lines: [...LINT_LOG_LINES],
  notice: null,
  truncation: null,
  _meta: realisticMeta,
})

export const failedState = (): LogsState => ({
  _tag: 'Loaded',
  jobName: 'flake-build',
  conclusion: 'failure',
  lines: [...FLAKE_BUILD_FAILED_LINES],
  notice: null,
  truncation: null,
  _meta: realisticMeta,
})

export const failedTruncatedState = (): LogsState => ({
  _tag: 'Loaded',
  jobName: 'flake-build',
  conclusion: 'failure',
  lines: [...FLAKE_BUILD_FAILED_LINES],
  notice: null,
  truncation: { totalLines: 847, offset: 0, pageSize: 100 },
  _meta: realisticMeta,
})

export const errorFilteredState = (): LogsState => ({
  _tag: 'Loaded',
  jobName: 'flake-build',
  conclusion: 'failure',
  lines: [...ERROR_FILTERED_LINES],
  notice: null,
  truncation: null,
  _meta: realisticMeta,
})

/** `--error` on a job GitHub never marked up: the tail of the log plus a notice. */
export const errorTailFallbackState = (): LogsState => ({
  _tag: 'Loaded',
  jobName: 'flake-build',
  conclusion: 'failure',
  lines: [...GREP_NIX_LINES],
  notice: 'No structured error lines found — showing the tail of the log.',
  truncation: null,
  _meta: realisticMeta,
})

export const grepFilteredState = (): LogsState => ({
  _tag: 'Loaded',
  jobName: 'flake-build',
  conclusion: 'failure',
  lines: [...GREP_NIX_LINES],
  notice: null,
  truncation: null,
  _meta: realisticMeta,
})

/** Full lint log with 100+ lines — includes cachix push + git ops after task runner output. */
export const longLogState = (): LogsState => ({
  _tag: 'Loaded',
  jobName: 'lint',
  conclusion: 'success',
  notice: null,
  truncation: null,
  _meta: realisticMeta,
  lines: [
    '2026-03-26T15:47:58.1020000Z ##[group]Run example-actions/checkout@v4',
    '2026-03-26T15:47:58.1030000Z with:',
    '2026-03-26T15:47:58.1040000Z   repository: example-org/example-repo',
    '2026-03-26T15:47:58.1050000Z   ref: refs/heads/example/ci-runner',
    '2026-03-26T15:47:58.1060000Z   token: ***',
    '2026-03-26T15:47:58.1070000Z   submodules: false',
    '2026-03-26T15:47:58.1080000Z ##[endgroup]',
    '2026-03-26T15:47:59.2100000Z Syncing repository: example-org/example-repo',
    '2026-03-26T15:47:59.5200000Z Getting Git version info',
    '2026-03-26T15:47:59.6300000Z git version 2.47.2',
    '2026-03-26T15:48:00.1000000Z Temporarily overriding HOME',
    '2026-03-26T15:48:00.3000000Z Deleting the contents of /home/runner/work/example-repo/example-repo',
    '2026-03-26T15:48:00.5000000Z Initializing the repository',
    '2026-03-26T15:48:01.2000000Z Disabling automatic garbage collection',
    '2026-03-26T15:48:01.4000000Z Setting up auth',
    '2026-03-26T15:48:01.8000000Z Fetching the repository',
    '2026-03-26T15:48:03.5000000Z Determining the checkout info',
    '2026-03-26T15:48:03.7000000Z Checking out the ref',
    '2026-03-26T15:48:04.1000000Z /usr/bin/git log -1 --format=%H',
    '2026-03-26T15:48:04.2000000Z 4444444444444444444444444444444444444444',
    '2026-03-26T15:48:04.5000000Z ##[group]Run example-cache/install-nix-action@v30',
    '2026-03-26T15:48:04.6000000Z Installing Nix...',
    '2026-03-26T15:48:06.1000000Z nix (Nix) 2.28.3',
    '2026-03-26T15:48:06.2000000Z ##[endgroup]',
    '2026-03-26T15:48:06.5000000Z ##[group]Run example-cache/cache-action@v15',
    '2026-03-26T15:48:06.6000000Z Using Cachix: example-cache',
    '2026-03-26T15:48:07.1000000Z Cachix: using signing key',
    '2026-03-26T15:48:07.2000000Z ##[endgroup]',
    '2026-03-26T15:48:07.5000000Z ##[group]Resolve devenv',
    '2026-03-26T15:48:07.6000000Z Pinned devenv rev: 1111111111111111111111111111111111111111',
    '2026-03-26T15:48:08.2000000Z Fetching github:example-org/dev-environment/111111111111...',
    '2026-03-26T15:48:08.9000000Z Resolved devenv in 1.30s',
    '2026-03-26T15:48:09.1000000Z ##[endgroup]',
    '2026-03-26T15:48:09.2000000Z ##[group]Configure shell',
    ...LINT_LOG_LINES,
    '2026-03-26T15:57:10.8000000Z ##[endgroup]',
    '2026-03-26T15:57:11.0000000Z ##[group]Post example-cache/cache-action@v15',
    '2026-03-26T15:57:11.1000000Z Pushing paths to cachix example-cache...',
    '2026-03-26T15:57:12.3000000Z compressing and pushing /nix/store/11111111111111111111111111111111-example-shell (42.1 MiB)',
    '2026-03-26T15:57:14.5000000Z compressing and pushing /nix/store/22222222222222222222222222222222-example-linter-1.2.3 (18.3 MiB)',
    '2026-03-26T15:57:16.2000000Z compressing and pushing /nix/store/33333333333333333333333333333333-example-formatter-4.5.6 (12.7 MiB)',
    '2026-03-26T15:57:18.0000000Z compressing and pushing /nix/store/44444444444444444444444444444444-example-package-manager-7.8.9 (8.9 MiB)',
    '2026-03-26T15:57:19.5000000Z All done.',
    '2026-03-26T15:57:19.6000000Z ##[endgroup]',
    '2026-03-26T15:57:19.8000000Z ##[group]Post example-actions/checkout@v4',
    '2026-03-26T15:57:19.9000000Z Post job cleanup.',
    '2026-03-26T15:57:20.1000000Z /usr/bin/git submodule foreach --recursive git credential-manager reject',
    '2026-03-26T15:57:20.3000000Z /usr/bin/git config --local --name-only --get-regexp http.https://git.example.invalid/.extraheader',
    '2026-03-26T15:57:20.4000000Z http.https://git.example.invalid/.extraheader',
    '2026-03-26T15:57:20.5000000Z /usr/bin/git config --local --unset-all http.https://git.example.invalid/.extraheader',
    '2026-03-26T15:57:20.6000000Z ##[endgroup]',
    '2026-03-26T15:57:20.7000000Z Cleaning up orphan processes',
    '2026-03-26T15:57:20.8000000Z Terminate orphan process: pid (12847) (cachix)',
  ],
})

export const errorState = (): LogsState => ({
  _tag: 'Error',
  error: 'NotFound',
  message: 'Job not found. The run may have been deleted or the job ID is invalid.',
  _meta: realisticMeta,
})

// =============================================================================
// Timeline Factories
// =============================================================================

type TimelineStep = { at: number; action: LogsAction }

/** Slice an array of lines into progressive chunks for multi-beat timelines. */
const sliceLines = ({
  lines,
  fraction,
}: {
  lines: readonly string[]
  fraction: number
}): string[] => [...lines].slice(0, Math.ceil(lines.length * fraction))

/** Build a multi-beat timeline that streams lines progressively. */
const createStreamingTimeline = (opts: {
  jobName: string
  conclusion: string
  lines: readonly string[]
  /** Timeline beats as [atMs, fractionOfLines] pairs */
  beats: readonly (readonly [number, number])[]
}): TimelineStep[] =>
  opts.beats.map(([at, fraction]) => ({
    at,
    action: {
      _tag: 'SetLogs' as const,
      jobName: opts.jobName,
      conclusion: opts.conclusion,
      lines: fraction >= 1 ? [...opts.lines] : sliceLines({ lines: opts.lines, fraction }),
      notice: null,
      truncation: null,
    },
  }))

/**
 * Success: Loading -> (2s) header lines -> (5s) first half streams -> (10s) full log
 */
export const createSuccessTimeline = (): TimelineStep[] =>
  createStreamingTimeline({
    jobName: 'lint',
    conclusion: 'success',
    lines: LINT_LOG_LINES,
    beats: [
      [2000, 0.15],
      [5000, 0.5],
      [10000, 1],
    ],
  })

/**
 * Failed: Loading -> (2s) log starts -> (5s) error appears -> (8s) full error with stack trace
 */
export const createFailedTimeline = (): TimelineStep[] =>
  createStreamingTimeline({
    jobName: 'flake-build',
    conclusion: 'failure',
    lines: FLAKE_BUILD_FAILED_LINES,
    beats: [
      [2000, 0.2],
      [5000, 0.6],
      [8000, 1],
    ],
  })

/** NoLogs: Loading -> (2s) no logs message */
export const createNoLogsTimeline = (): TimelineStep[] => {
  const s = noLogsState() as Extract<LogsState, { _tag: 'NoLogs' }>
  return [
    {
      at: 2000,
      action: {
        _tag: 'SetNoLogs',
        message: s.message,
        conclusion: s.conclusion,
      },
    },
  ]
}

/** Error filtered: Loading -> (2s) error lines appear */
export const createErrorFilteredTimeline = (): TimelineStep[] => [
  {
    at: 2000,
    action: {
      _tag: 'SetLogs',
      jobName: 'flake-build',
      conclusion: 'failure',
      lines: [...ERROR_FILTERED_LINES],
      notice: null,
      truncation: null,
    },
  },
]

/** Error filtered with no structured match: Loading -> (2s) tail plus notice */
export const createErrorTailFallbackTimeline = (): TimelineStep[] => [
  {
    at: 2000,
    action: {
      _tag: 'SetLogs',
      jobName: 'flake-build',
      conclusion: 'failure',
      lines: [...GREP_NIX_LINES],
      notice: 'No structured error lines found — showing the tail of the log.',
      truncation: null,
    },
  },
]

/** Grep filtered: Loading -> (2s) matching lines appear */
export const createGrepFilteredTimeline = (): TimelineStep[] => [
  {
    at: 2000,
    action: {
      _tag: 'SetLogs',
      jobName: 'flake-build',
      conclusion: 'failure',
      lines: [...GREP_NIX_LINES],
      notice: null,
      truncation: null,
    },
  },
]

/**
 * LongOutput: Loading -> (2s) first chunk -> (6s) mid -> (12s) full 100+ lines
 */
export const createLongLogTimeline = (): TimelineStep[] => {
  const state = longLogState() as Extract<LogsState, { _tag: 'Loaded' }>
  return createStreamingTimeline({
    jobName: state.jobName,
    conclusion: state.conclusion,
    lines: state.lines,
    beats: [
      [2000, 0.2],
      [6000, 0.5],
      [12000, 1],
    ],
  })
}
