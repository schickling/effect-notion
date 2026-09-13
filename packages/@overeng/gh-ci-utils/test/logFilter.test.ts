import { Effect, Option } from 'effect'
import { describe, expect, it } from 'vitest'

import { GitHubApiError, LogsUnavailableError } from '../src/isomorphic/Errors.ts'
import type { WorkflowJob } from '../src/isomorphic/GitHubSchemas.ts'
import {
  extractErrorLines,
  grepLines,
  selectLogLines,
  shouldIncludeFailedLog,
} from '../src/isomorphic/lib/logFilter.ts'
import {
  collectJobLog,
  collectLogText,
  isLogsWatchComplete,
  shouldRetryStepLogLookup,
} from '../src/node/commands/logs.ts'

describe('extractErrorLines', () => {
  it('extracts ##[error] lines', () => {
    const log =
      'line1\n2026-01-01T00:00:00Z ##[error]Type error in foo.ts\nline3\n2026-01-01T00:00:01Z ##[error]Cannot find module\n'
    expect(extractErrorLines(log)).toEqual(['Type error in foo.ts', 'Cannot find module'])
  })

  it('returns last 10 lines for clean logs', () => {
    expect(extractErrorLines('all good\nno errors')).toEqual(['all good', 'no errors'])
  })

  it('extracts nix hash mismatch with specified/got continuation lines', () => {
    const log = [
      '2026-01-01T00:00:00Z building foo',
      "2026-01-01T00:00:01Z error: hash mismatch in fixed-output derivation '/nix/store/abc-foo.drv':",
      '2026-01-01T00:00:01Z          specified: sha256-ABC',
      '2026-01-01T00:00:01Z             got:    sha256-XYZ',
      '2026-01-01T00:00:02Z ##[error]Process completed with exit code 1.',
    ].join('\n')
    expect(extractErrorLines(log)).toMatchInlineSnapshot(`
      [
        "error: hash mismatch in fixed-output derivation '/nix/store/abc-foo.drv':",
        "         specified: sha256-ABC",
        "            got:    sha256-XYZ",
      ]
    `)
  })

  it('deduplicates cascade noise from downstream build failures', () => {
    const log = [
      "2026-04-04T08:20:59Z error: hash mismatch in fixed-output derivation '/nix/store/abc-bird-pnpm-deps.drv':",
      '2026-04-04T08:20:59Z          specified: sha256-qvLUzupc3M0=',
      '2026-04-04T08:20:59Z             got:    sha256-jAjjMdBREgH=',
      "2026-04-04T08:20:59Z error: Cannot build '/nix/store/m0hv-bird.drv'.",
      '2026-04-04T08:20:59Z        Reason: 1 dependency failed.',
      '2026-04-04T08:20:59Z        Output paths:',
      '2026-04-04T08:20:59Z          /nix/store/4r5m-bird',
      '2026-04-04T08:20:59Z error: Build failed due to failed dependency',
      "2026-04-04T08:20:59Z error: Cannot build '/nix/store/pcyb-bird.drv'.",
      '2026-04-04T08:20:59Z        Reason: 1 dependency failed.',
      '2026-04-04T08:20:59Z        Output paths:',
      '2026-04-04T08:20:59Z          /nix/store/fkkh-bird',
      '2026-04-04T08:20:59Z error: Build failed due to failed dependency',
      '2026-04-04T08:20:59Z error: Build failed due to failed dependency',
      '2026-04-04T08:20:59Z error: Build failed due to failed dependency',
      '2026-04-04T08:21:00Z ##[error]Process completed with exit code 1.',
    ].join('\n')
    expect(extractErrorLines(log)).toMatchInlineSnapshot(`
      [
        "error: hash mismatch in fixed-output derivation '/nix/store/abc-bird-pnpm-deps.drv':",
        "         specified: sha256-qvLUzupc3M0=",
        "            got:    sha256-jAjjMdBREgH=",
        "(6 downstream build failures omitted)",
      ]
    `)
  })

  it('preserves multiple distinct root-cause errors', () => {
    const log = [
      "2026-01-01T00:00:01Z error: hash mismatch in fixed-output derivation '/nix/store/aaa.drv':",
      '2026-01-01T00:00:01Z          specified: sha256-AAA',
      '2026-01-01T00:00:01Z             got:    sha256-BBB',
      "2026-01-01T00:00:02Z error: hash mismatch in fixed-output derivation '/nix/store/ccc.drv':",
      '2026-01-01T00:00:02Z          specified: sha256-CCC',
      '2026-01-01T00:00:02Z             got:    sha256-DDD',
      '2026-01-01T00:00:03Z ##[error]Process completed with exit code 1.',
    ].join('\n')
    const result = extractErrorLines(log)
    expect(result).toContain('         specified: sha256-AAA')
    expect(result).toContain('            got:    sha256-BBB')
    expect(result).toContain('         specified: sha256-CCC')
    expect(result).toContain('            got:    sha256-DDD')
  })
})

describe('extractErrorLines — echoed step scripts', () => {
  it('ignores ::error:: echoes in the run: template and reports the failing tail', () => {
    const log = [
      '2026-07-27T10:40:00Z ##[group]Run scripts/ci.sh',
      '2026-07-27T10:40:00Z \u001B[36;1m  echo "::error::CI helper script directory is missing: $scripts_src"\u001B[0m',
      "2026-07-27T10:40:00Z \u001B[36;1m    echo '::error::devenv.lock missing .nodes.devenv.locked.rev'\u001B[0m",
      '2026-07-27T10:40:00Z ##[endgroup]',
      '2026-07-27T10:45:20Z ✖ Running pnpm:install in 18.9s (failed)',
      '2026-07-27T10:45:21Z ##[warning]pnpm install failed; see pnpm-install.log',
      '2026-07-27T10:45:26Z ##[error]Process completed with exit code 1.',
    ].join('\n')

    expect(extractErrorLines(log)).toEqual([
      '✖ Running pnpm:install in 18.9s (failed)',
      '##[warning]pnpm install failed; see pnpm-install.log',
      '##[error]Process completed with exit code 1.',
    ])
  })

  it('anchors the fallback on the last ##[error], not on post-job steps', () => {
    const log = [
      '2026-09-03T07:22:50Z ✖ Evaluating shell in 333s (failed)',
      '2026-09-03T07:22:52Z ##[error]Process completed with exit code 1.',
      '2026-09-03T07:22:53Z ##[group]Run actions/upload-artifact@v4',
      '2026-09-03T07:22:53Z \u001B[36;1mwith: name: nix-store-diagnostics\u001B[0m',
      '2026-09-03T07:22:54Z ##[endgroup]',
      '2026-09-03T07:22:59Z Artifact upload complete',
    ].join('\n')

    expect(extractErrorLines(log)).toEqual([
      '✖ Evaluating shell in 333s (failed)',
      '##[error]Process completed with exit code 1.',
    ])
  })

  it('keeps the Nix trace that precedes an error: line and drops ANSI styling', () => {
    const log = [
      '2026-09-03T07:22:50Z \u001B[31;1m  × Failed to realize shell derivation:\u001B[0m',
      "2026-09-03T07:22:50Z     … while waiting for the build environment for '/nix/store/abc-x.drv'",
      '2026-09-03T07:22:50Z    ',
      '2026-09-03T07:22:50Z     \u001B[31;1merror:\u001B[0m unexpected EOF reading a line',
      '2026-09-03T07:22:52Z ##[error]Process completed with exit code 1.',
    ].join('\n')

    expect(extractErrorLines(log)).toEqual([
      '  × Failed to realize shell derivation:',
      "    … while waiting for the build environment for '/nix/store/abc-x.drv'",
      '    error: unexpected EOF reading a line',
    ])
  })

  it('stops an unbalanced ##[group]Run at the next group header', () => {
    const log = [
      '2026-09-03T07:22:50Z ##[group]Run scripts/ci.sh',
      '2026-09-03T07:22:50Z \u001B[36;1m  echo "::error::CI helper script directory is missing"\u001B[0m',
      '2026-09-03T07:22:51Z ##[group]Post Job Cleanup',
      '2026-09-03T07:22:52Z ##[error]flake-build failed: exit 1',
    ].join('\n')

    expect(extractErrorLines(log)).toEqual(['flake-build failed: exit 1'])
  })

  it('keeps ignoring echoes when a nested ##[group]Run opens inside one', () => {
    const log = [
      '2026-09-03T07:22:50Z ##[group]Run scripts/ci.sh',
      '2026-09-03T07:22:50Z \u001B[36;1m  echo "::error::outer template line"\u001B[0m',
      '2026-09-03T07:22:50Z ##[group]Run scripts/inner.sh',
      '2026-09-03T07:22:50Z \u001B[36;1m  echo "::error::inner template line"\u001B[0m',
      '2026-09-03T07:22:51Z ##[endgroup]',
      '2026-09-03T07:22:51Z ✖ Running build in 3.2s (failed)',
      '2026-09-03T07:22:52Z ##[error]Process completed with exit code 1.',
    ].join('\n')

    expect(extractErrorLines(log)).toEqual([
      '✖ Running build in 3.2s (failed)',
      '##[error]Process completed with exit code 1.',
    ])
  })

  it('strips the trailing \\r of CRLF logs', () => {
    const log = [
      "2026-01-01T00:00:01Z error: hash mismatch in fixed-output derivation '/nix/store/abc.drv':\r",
      '2026-01-01T00:00:01Z          specified: sha256-ABC\r',
      '2026-01-01T00:00:02Z ##[error]Process completed with exit code 1.\r',
    ].join('\n')

    expect(extractErrorLines(log)).toEqual([
      "error: hash mismatch in fixed-output derivation '/nix/store/abc.drv':",
      '         specified: sha256-ABC',
    ])
  })
})

describe('selectLogLines', () => {
  it('reports the tail with a notice when --error finds nothing structured', () => {
    const log = 'buck2 build ok\nnothing to report'
    expect(selectLogLines({ logText: log, errorOnly: true, grep: undefined })).toEqual({
      lines: ['buck2 build ok', 'nothing to report'],
      notice: 'No structured error lines found — showing the tail of the log.',
    })
  })

  it('reports no notice when --error finds a structured error', () => {
    const log = '2026-01-01T00:00:00Z ##[error]Type error in foo.ts'
    expect(selectLogLines({ logText: log, errorOnly: true, grep: undefined })).toEqual({
      lines: ['Type error in foo.ts'],
      notice: null,
    })
  })

  it('falls back to the raw log when --error has no line to show at all', () => {
    const log = ['##[group]Run scripts/ci.sh', '  echo "::error::nothing ran"', ''].join('\n')
    expect(selectLogLines({ logText: log, errorOnly: true, grep: undefined })).toEqual({
      lines: ['##[group]Run scripts/ci.sh', '  echo "::error::nothing ran"', ''],
      notice: 'No error lines matched — showing the raw log instead.',
    })
  })

  it('falls back to the raw log when --grep matches nothing', () => {
    const log = 'buck2 build ok\nnothing to report'
    expect(selectLogLines({ logText: log, errorOnly: false, grep: 'specified' })).toEqual({
      lines: ['buck2 build ok', 'nothing to report'],
      notice: "No lines matched 'specified' — showing the raw log instead.",
    })
  })

  it('returns grep matches when the filter hits', () => {
    const log = 'specified: sha256-AAA\nunrelated'
    expect(selectLogLines({ logText: log, errorOnly: false, grep: 'specified' })).toEqual({
      lines: ['specified: sha256-AAA'],
      notice: null,
    })
  })

  it('passes the whole log through when no filter is given', () => {
    expect(selectLogLines({ logText: 'a\nb', errorOnly: false, grep: undefined })).toEqual({
      lines: ['a', 'b'],
      notice: null,
    })
  })
})

describe('live and completed step log pagination', () => {
  it('applies grep before shared tail and offset pagination', () => {
    const result = collectLogText({
      logText: ['noise', 'match-1', 'match-2', 'match-3', 'match-4'].join('\n'),
      jobName: 'build > compile',
      conclusion: 'in_progress',
      filters: {
        tail: 2,
        offset: 1,
        errorOnly: false,
        grep: Option.some('match'),
        full: false,
      },
    })

    expect(result).toMatchObject({
      lines: ['match-2', 'match-3'],
      notice: null,
      truncation: { totalLines: 4, offset: 1, pageSize: 2 },
    })
  })

  it('clamps an offset beyond the start to an empty page with accurate metadata', () => {
    const result = collectLogText({
      logText: Array.from({ length: 100 }, (_, index) => `line-${index + 1}`).join('\n'),
      jobName: 'build',
      conclusion: 'failure',
      filters: {
        tail: 10,
        offset: 150,
        errorOnly: false,
        grep: Option.none(),
        full: false,
      },
    })

    expect(result).toMatchObject({
      lines: [],
      truncation: { totalLines: 100, offset: 100, pageSize: 10 },
    })
  })

  it('retains pagination metadata for a partial page at the start', () => {
    const result = collectLogText({
      logText: ['line-1', 'line-2', 'line-3', 'line-4'].join('\n'),
      jobName: 'build',
      conclusion: 'failure',
      filters: {
        tail: 2,
        offset: 3,
        errorOnly: false,
        grep: Option.none(),
        full: false,
      },
    })

    expect(result).toMatchObject({
      lines: ['line-1'],
      truncation: { totalLines: 4, offset: 3, pageSize: 2 },
    })
  })

  it('applies error extraction and lets --full bypass tail and offset', () => {
    const result = collectLogText({
      logText: [
        '2026-01-01T00:00:00Z ##[error]first synthetic failure',
        '2026-01-01T00:00:01Z ##[error]second synthetic failure',
      ].join('\n'),
      jobName: 'build > compile',
      conclusion: 'failure',
      filters: {
        tail: 1,
        offset: 99,
        errorOnly: true,
        grep: Option.none(),
        full: true,
      },
    })

    expect(result).toMatchObject({
      lines: ['first synthetic failure', 'second synthetic failure'],
      notice: null,
      truncation: null,
    })
  })
})

describe('completed log retrieval', () => {
  const completedJob = {
    id: 80000000002,
    run_id: 70000000001,
    name: 'build',
    status: 'completed',
    conclusion: 'success',
    started_at: new Date('2026-09-13T10:00:00Z'),
    completed_at: new Date('2026-09-13T10:05:00Z'),
    runner_name: 'runner-a',
    labels: ['self-hosted'],
    steps: [],
  } satisfies WorkflowJob
  const filters = {
    tail: 100,
    offset: 0,
    errorOnly: false,
    grep: Option.none<string>(),
    full: false,
  }

  it('waits for the completed timestamp before requesting logs', async () => {
    let requests = 0
    const job = { ...completedJob, completed_at: null }
    const result = await collectJobLog({
      github: {
        getJobLogs: () =>
          Effect.sync(() => {
            requests++
            return 'real logs'
          }),
      },
      repo: 'example-org/example-repo',
      job,
      filters,
    }).pipe(Effect.runPromise)

    expect(result.availability).toBe('retryable')
    expect(requests).toBe(0)
    expect(
      isLogsWatchComplete({
        runCompleted: true,
        jobs: [job],
        displayedJobIds: new Set(),
      }),
    ).toBe(false)
  })

  it('retries unavailable completed logs and only completes after real retrieval', async () => {
    let requests = 0
    const github = {
      getJobLogs: () =>
        Effect.suspend(() => {
          requests++
          return requests === 1
            ? Effect.fail(
                new LogsUnavailableError({
                  message: 'GitHub returned an empty log body for this job',
                  jobId: completedJob.id,
                }),
              )
            : Effect.succeed('real logs')
        }),
    }
    const displayedJobIds = new Set<number>()

    const unavailable = await collectJobLog({
      github,
      repo: 'example-org/example-repo',
      job: completedJob,
      filters,
    }).pipe(Effect.runPromise)
    if (unavailable.availability === 'retrieved') displayedJobIds.add(completedJob.id)

    expect(unavailable).toMatchObject({
      availability: 'retryable',
      lines: ['Logs not available: GitHub returned an empty log body for this job'],
    })
    expect(isLogsWatchComplete({ runCompleted: true, jobs: [completedJob], displayedJobIds })).toBe(
      false,
    )

    const retrieved = await collectJobLog({
      github,
      repo: 'example-org/example-repo',
      job: completedJob,
      filters,
    }).pipe(Effect.runPromise)
    if (retrieved.availability === 'retrieved') displayedJobIds.add(completedJob.id)

    expect(retrieved).toMatchObject({ availability: 'retrieved', lines: ['real logs'] })
    expect(isLogsWatchComplete({ runCompleted: true, jobs: [completedJob], displayedJobIds })).toBe(
      true,
    )
    expect(requests).toBe(2)
  })

  it('classifies authorization failures as terminal instead of retryable', async () => {
    const result = await collectJobLog({
      github: {
        getJobLogs: () =>
          Effect.fail(
            new GitHubApiError({
              message: 'GitHub API returned 403: GET job logs — forbidden',
              cause: 'HTTP 403',
            }),
          ),
      },
      repo: 'example-org/example-repo',
      job: completedJob,
      filters,
    }).pipe(Effect.runPromise)

    expect(result).toMatchObject({
      availability: 'terminal',
      lines: ['Failed to fetch logs: GitHub API returned 403: GET job logs — forbidden'],
    })
  })
})

describe('selected-step watch retry', () => {
  it.each(['failed internal job-id resolution', 'step not visible yet'])(
    'keeps watching after %s',
    () => {
      expect(
        shouldRetryStepLogLookup({
          watch: true,
          candidateJobCount: 1,
          displayedJobCount: 0,
        }),
      ).toBe(true)
    },
  )

  it('stops retrying after a completed selected step was displayed', () => {
    expect(
      shouldRetryStepLogLookup({
        watch: true,
        candidateJobCount: 1,
        displayedJobCount: 1,
      }),
    ).toBe(false)
  })
})

describe('grepLines', () => {
  it('filters case-insensitive', () => {
    const log = 'Hello World\ngoodbye world\nHELLO again'
    expect(grepLines({ logText: log, pattern: 'hello' })).toEqual(['Hello World', 'HELLO again'])
  })
})

describe('shouldIncludeFailedLog', () => {
  it.each(['failure', 'timed_out', 'action_required', 'stale', 'startup_failure'])(
    'includes blocking conclusion %s',
    (conclusion) => {
      expect(shouldIncludeFailedLog(conclusion)).toBe(true)
    },
  )

  it.each(['success', 'skipped', 'neutral', 'cancelled', null])(
    'excludes non-blocking conclusion %s',
    (conclusion) => {
      expect(shouldIncludeFailedLog(conclusion)).toBe(false)
    },
  )
})
