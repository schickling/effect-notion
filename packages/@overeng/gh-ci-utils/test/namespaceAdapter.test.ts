/**
 * `gh-ci-utils inspect` Namespace adapter.
 *
 * Two things are load-bearing here and both are asserted directly:
 *
 *  - the adapter only ever runs the three approved read-only `nsc` commands,
 *    and runs none at all for a runner Namespace does not own;
 *  - `nsc` being absent, unauthenticated, broken or unreadable degrades into
 *    tagged data, never into a failure that would cost the GitHub facts.
 *
 * The decoders are exercised as pure functions because the live `nsc` JSON
 * shape is not contractually stable: they must survive renames and nesting.
 */
import { Effect, Layer, Sink, Stream } from 'effect'
import * as PlatformError from 'effect/PlatformError'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import {
  ChildProcessSpawner,
  ExitCode,
  ProcessId,
  make as makeSpawner,
  makeHandle,
} from 'effect/unstable/process/ChildProcessSpawner'
import { describe, expect, it } from 'vitest'

import {
  RESOURCE_PRESSURE_FRACTION,
  type InspectGitHubFacts,
} from '../src/isomorphic/lib/inspectFacts.ts'
import {
  authCheckLoginArgv,
  deriveInstanceStatus,
  deriveReportWindow,
  instanceReportArgv,
  isAllowedArgv,
  jobDescribeArgv,
  observeNamespaceJob,
  parseInstanceReport,
  parseJobDescribe,
  selectUsageRow,
  splitCsvLine,
} from '../src/node/NamespaceClient.ts'

const INSTANCE = 'abc123example'
const JOB_ID = 1001

const githubFacts = (overrides: Partial<InspectGitHubFacts> = {}): InspectGitHubFacts => ({
  repo: 'example-org/example-repo',
  jobId: JOB_ID,
  runId: 2001,
  name: 'build',
  status: 'in_progress',
  conclusion: null,
  startedAt: '2026-01-15T11:00:00.000Z',
  completedAt: '2026-01-15T11:04:00.000Z',
  durationSeconds: 240,
  runnerName: `nsc-runner-${INSTANCE}`,
  runnerKind: 'namespace',
  runnerInstance: INSTANCE,
  labels: [],
  steps: [],
  ...overrides,
})

// =============================================================================
// Fake spawner
// =============================================================================

/** What a faked `nsc` invocation returns. */
type FakeResult =
  | {
      readonly _tag: 'output'
      readonly stdout: string
      readonly stderr: string
      readonly exitCode: number
    }
  | { readonly _tag: 'not-on-path' }

const output = (
  stdout: string,
  extra: { stderr?: string; exitCode?: number } = {},
): FakeResult => ({
  _tag: 'output',
  stdout,
  stderr: extra.stderr ?? '',
  exitCode: extra.exitCode ?? 0,
})

const encode = (text: string) => Stream.make(new TextEncoder().encode(text))

/**
 * A spawner that answers from `respond` and records every argv it saw.
 *
 * Recording is the point: the adapter's whole security property is which argv
 * it is capable of producing.
 */
const fakeSpawner = ({
  respond,
  recorded,
}: {
  respond: (argv: ReadonlyArray<string>) => FakeResult
  recorded: Array<ReadonlyArray<string>>
}) =>
  Layer.succeed(
    ChildProcessSpawner,
    makeSpawner((command) =>
      Effect.gen(function* () {
        if (ChildProcess.isStandardCommand(command) === false) {
          return yield* Effect.die(new Error('the inspect path must not build a piped command'))
        }
        const argv = [command.command, ...command.args]
        recorded.push(argv)
        const result = respond(command.args)
        if (result._tag === 'not-on-path') {
          return yield* PlatformError.systemError({
            _tag: 'NotFound',
            module: 'ChildProcess',
            method: 'spawn',
            description: 'nsc',
          })
        }
        return makeHandle({
          pid: ProcessId(4242),
          exitCode: Effect.succeed(ExitCode(result.exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: encode(result.stdout),
          stderr: encode(result.stderr),
          all: encode(result.stdout + result.stderr),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        })
      }),
    ),
  )

/** A spawner that must never be touched. */
const forbiddenSpawner = Layer.succeed(
  ChildProcessSpawner,
  makeSpawner(() => Effect.die(new Error('no subprocess may be spawned for this runner'))),
)

const DESCRIBE_JSON = JSON.stringify({
  job: { id: String(JOB_ID), job_name: 'build', workflow_name: 'CI' },
  repository: 'example-org/example-repo',
  runner: {
    instance_id: INSTANCE,
    instance_status: 'RUNNING',
    runner_name: `nsc-runner-${INSTANCE}`,
    container_name: 'runner',
  },
})

/** The documented report layout: a preamble line, then the CSV. */
const REPORT_CSV = `Writing output to path: stdout
instance_id,created_at,started_at,destroyed_at,resources_cpu,resources_ram_gb,resources_cpu_actual_max,resources_ram_gb_actual_max_percent,github_job_id,github_job_name,github_job_workflow_name,github_run_id,github_run_attempt,job_created_at,job_started_at,job_completed_at,github_profile,github_repository,github_branch,github_job_conclusion
${INSTANCE},2026-01-15 10:59:55 +0000 UTC,2026-01-15 11:00:00 +0000 UTC,,8,16,0.97,0.31,${JOB_ID},"build (linux, amd64)",CI,2001,1,2026-01-15 10:59:50 +0000 UTC,2026-01-15 11:00:00 +0000 UTC,,,example-org/example-repo,main,
`

// =============================================================================
// Pure decoders
// =============================================================================
const parseDescribe = (stdout: string) => parseJobDescribe({ stdout, expectedInstanceId: INSTANCE })

describe('parseJobDescribe', () => {
  it('finds the instance behind a nested runner block', () => {
    const parsed = parseDescribe(DESCRIBE_JSON)
    expect(parsed).toEqual({
      _tag: 'parsed',
      job: {
        instanceId: INSTANCE,
        instanceStatus: 'running',
        instanceStatusRaw: 'RUNNING',
        runnerName: `nsc-runner-${INSTANCE}`,
        containerName: 'runner',
        repository: 'example-org/example-repo',
        workflow: 'CI',
        jobName: 'build',
        destroyedAt: null,
      },
    })
  })

  it('selects the expected instance regardless of attempt order', () => {
    const previousAttempt = {
      instance_id: 'previous-instance',
      instance_status: 'DESTROYED',
      destroyed_at: '2026-01-15T10:55:00Z',
      runner_name: 'nsc-runner-previous-instance',
      container_name: 'previous-container',
      repository: 'previous-org/previous-repo',
      workflow_name: 'Previous CI',
      job_name: 'previous build',
    }
    const currentAttempt = {
      instance_id: INSTANCE,
      instance_status: 'RUNNING',
      runner_name: `nsc-runner-${INSTANCE}`,
      container_name: 'current-container',
      repository: 'example-org/example-repo',
      workflow_name: 'Current CI',
      job_name: 'current build',
    }

    for (const attempts of [
      [previousAttempt, currentAttempt],
      [currentAttempt, previousAttempt],
    ]) {
      expect(parseDescribe(JSON.stringify({ attempts }))).toEqual({
        _tag: 'parsed',
        job: {
          instanceId: INSTANCE,
          instanceStatus: 'running',
          instanceStatusRaw: 'RUNNING',
          runnerName: `nsc-runner-${INSTANCE}`,
          containerName: 'current-container',
          repository: 'example-org/example-repo',
          workflow: 'Current CI',
          jobName: 'current build',
          destroyedAt: null,
        },
      })
    }
  })

  it('reads generic status only from the record that owns the instance id', () => {
    const parsed = parseDescribe(
      JSON.stringify({
        status: 'completed',
        runner: {
          instance_id: INSTANCE,
          status: 'RUNNING',
        },
      }),
    )
    expect(parsed._tag === 'parsed' && parsed.job.instanceStatus).toBe('running')
    expect(parsed._tag === 'parsed' && parsed.job.instanceStatusRaw).toBe('RUNNING')
  })

  it('ignores status owned by a nested previous attempt', () => {
    const parsed = parseDescribe(
      JSON.stringify({
        runner: {
          instance_id: INSTANCE,
          status: 'RUNNING',
          previous_attempt: {
            instance_id: 'previous-instance',
            instance_status: 'DESTROYED',
          },
        },
      }),
    )
    expect(parsed._tag === 'parsed' && parsed.job.instanceStatus).toBe('running')
    expect(parsed._tag === 'parsed' && parsed.job.instanceStatusRaw).toBe('RUNNING')
  })

  it('ignores a destruction timestamp owned by an unrelated instance attempt', () => {
    const parsed = parseDescribe(
      JSON.stringify({
        runner: {
          instance_id: INSTANCE,
          instance_status: 'RUNNING',
        },
        attempts: [
          {
            instance_id: 'unrelated-instance',
            destroyed_at: '2026-01-15T10:55:00Z',
          },
        ],
      }),
    )
    expect(parsed._tag === 'parsed' && parsed.job.instanceStatus).toBe('running')
    expect(parsed._tag === 'parsed' && parsed.job.destroyedAt).toBeNull()
  })

  it('uses a destruction timestamp owned by the selected instance', () => {
    const parsed = parseDescribe(
      JSON.stringify({
        runner: {
          instance_id: INSTANCE,
          instance_status: 'RUNNING',
          destroyed_at: '2026-01-15T11:05:00Z',
        },
      }),
    )
    expect(parsed._tag === 'parsed' && parsed.job.instanceStatus).toBe('destroyed')
    expect(parsed._tag === 'parsed' && parsed.job.destroyedAt).toBe('2026-01-15T11:05:00Z')
  })

  it('reads camelCase field names too, since the CLI shape is not pinned', () => {
    const parsed = parseDescribe(
      JSON.stringify({ instanceId: INSTANCE, instanceStatus: 'running' }),
    )
    expect(parsed._tag === 'parsed' && parsed.job.instanceId).toBe(INSTANCE)
    expect(parsed._tag === 'parsed' && parsed.job.instanceStatus).toBe('running')
  })

  it('degrades an unrecognized status to unknown instead of assuming the instance is gone', () => {
    const parsed = parseDescribe(
      JSON.stringify({ instance_id: INSTANCE, instance_status: 'PROVISIONING_V2' }),
    )
    expect(parsed._tag === 'parsed' && parsed.job.instanceStatus).toBe('unknown')
    expect(parsed._tag === 'parsed' && parsed.job.instanceStatusRaw).toBe('PROVISIONING_V2')
  })

  it('treats a description with no instance id as unreadable rather than empty', () =>
    expect(parseDescribe(JSON.stringify({ job: { name: 'build' } }))._tag).toBe('unrecognized'))

  it('treats non-JSON stdout as unreadable', () =>
    expect(parseDescribe('Error: something went wrong')._tag).toBe('unrecognized'))

  it('treats empty stdout as unreadable', () =>
    expect(parseDescribe('   ')._tag).toBe('unrecognized'))
})

describe('deriveInstanceStatus', () => {
  it('lets a recorded destruction time override any status string', () =>
    expect(
      deriveInstanceStatus({ statusRaw: 'RUNNING', destroyedAt: '2026-01-15T11:05:00Z' }),
    ).toBe('destroyed'))

  it('reports unknown when there is no status at all', () =>
    expect(deriveInstanceStatus({ statusRaw: null, destroyedAt: null })).toBe('unknown'))
})

describe('splitCsvLine', () => {
  it('keeps commas inside quoted job names in one field', () =>
    expect(splitCsvLine(`a,"build (linux, amd64)",c`)).toEqual(['a', 'build (linux, amd64)', 'c']))

  it('unescapes doubled quotes', () =>
    expect(splitCsvLine(`a,"say ""hi""",c`)).toEqual(['a', 'say "hi"', 'c']))

  it('keeps trailing empty fields, so column positions never shift', () =>
    expect(splitCsvLine('a,,')).toEqual(['a', '', '']))
})

describe('parseInstanceReport', () => {
  it('skips the "Writing output to path" preamble and keys rows by column', () => {
    const parsed = parseInstanceReport(REPORT_CSV)
    expect(parsed._tag).toBe('parsed')
    if (parsed._tag !== 'parsed') return
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0]!['github_job_name']).toBe('build (linux, amd64)')
    expect(parsed.rows[0]!['github_repository']).toBe('example-org/example-repo')
  })

  it('reports output with no header as unreadable', () =>
    expect(parseInstanceReport('Writing output to path: stdout\n')._tag).toBe('unrecognized'))
})

describe('selectUsageRow', () => {
  const rows = (() => {
    const parsed = parseInstanceReport(REPORT_CSV)
    return parsed._tag === 'parsed' ? parsed.rows : []
  })()

  const selectCpuUsage = ({
    allocatedCpu,
    cpuMaxCores,
  }: {
    readonly allocatedCpu: string
    readonly cpuMaxCores: string
  }) =>
    selectUsageRow({
      rows: [
        {
          instance_id: INSTANCE,
          github_job_id: String(JOB_ID),
          resources_cpu: allocatedCpu,
          resources_ram_gb: '16',
          resources_cpu_actual_max: cpuMaxCores,
          resources_ram_gb_actual_max_percent: '0.31',
        },
      ],
      jobId: JOB_ID,
      instanceId: INSTANCE,
    })

  it('normalizes peak cores against a multi-CPU allocation, avoiding false pressure', () => {
    const usage = selectUsageRow({ rows, jobId: JOB_ID, instanceId: INSTANCE })

    expect(usage).toEqual({
      instanceId: INSTANCE,
      githubJobId: String(JOB_ID),
      allocatedCpu: 8,
      allocatedRamGb: 16,
      cpuMaxFraction: 0.97 / 8,
      ramMaxFraction: 0.31,
      createdAt: '2026-01-15 10:59:55 +0000 UTC',
      startedAt: '2026-01-15 11:00:00 +0000 UTC',
      destroyedAt: null,
    })
    expect(usage?.cpuMaxFraction).toBeCloseTo(0.121)
    expect(usage?.cpuMaxFraction).toBeLessThan(RESOURCE_PRESSURE_FRACTION)
  })

  it('normalizes peak cores against a fractional allocation, avoiding false negatives', () => {
    const usage = selectCpuUsage({ allocatedCpu: '0.5', cpuMaxCores: '0.48' })

    expect(usage?.allocatedCpu).toBe(0.5)
    expect(usage?.cpuMaxFraction).toBeCloseTo(0.96)
    expect(usage?.cpuMaxFraction).toBeGreaterThanOrEqual(RESOURCE_PRESSURE_FRACTION)
  })

  it('treats missing or zero CPU allocations as unavailable usage', () => {
    expect(selectCpuUsage({ allocatedCpu: '', cpuMaxCores: '0.48' })).toBeNull()
    expect(selectCpuUsage({ allocatedCpu: '0', cpuMaxCores: '0.48' })).toBeNull()
  })

  it('requires the instance to match, not just the job', () =>
    expect(selectUsageRow({ rows, jobId: JOB_ID, instanceId: 'someotherinstance' })).toBeNull())

  it('requires the job to match, not just the instance', () =>
    expect(selectUsageRow({ rows, jobId: 1, instanceId: INSTANCE })).toBeNull())
})

describe('deriveReportWindow', () => {
  it('brackets the job with padding on both sides', () =>
    expect(
      deriveReportWindow({
        startedAt: '2026-01-15T11:00:00.000Z',
        completedAt: '2026-01-15T11:04:00.000Z',
        now: new Date('2026-01-15T12:00:00.000Z'),
      }),
    ).toEqual({ start: '2026-01-15T10:55:00.000Z', end: '2026-01-15T11:09:00.000Z' }))

  it('ends a still-running job at now, not at an invented completion', () =>
    expect(
      deriveReportWindow({
        startedAt: '2026-01-15T11:00:00.000Z',
        completedAt: null,
        now: new Date('2026-01-15T11:02:00.000Z'),
      })?.end,
    ).toBe('2026-01-15T11:07:00.000Z'))

  it('refuses a window when GitHub gave no start time', () =>
    expect(deriveReportWindow({ startedAt: null, completedAt: null, now: new Date() })).toBeNull())
})

describe('isAllowedArgv', () => {
  it('accepts exactly the three read-only invocations the adapter builds', () => {
    expect(isAllowedArgv(authCheckLoginArgv())).toBe(true)
    expect(isAllowedArgv(jobDescribeArgv(JOB_ID))).toBe(true)
    expect(
      isAllowedArgv(
        instanceReportArgv({
          window: { start: 'a', end: 'b' },
          repository: 'o/r',
          jobName: 'build',
        }),
      ),
    ).toBe(true)
  })

  it('rejects lifecycle, login and remote-execution commands', () => {
    expect(isAllowedArgv(['auth', 'login'])).toBe(false)
    expect(isAllowedArgv(['instance', 'destroy', INSTANCE])).toBe(false)
    expect(isAllowedArgv(['ssh', INSTANCE])).toBe(false)
    expect(isAllowedArgv(['run', 'sh'])).toBe(false)
    expect(isAllowedArgv(['github', 'job', 'cancel', String(JOB_ID)])).toBe(false)
  })
})

// =============================================================================
// The observation
// =============================================================================

const observe = ({
  github,
  withUsage = false,
  respond,
}: {
  github: InspectGitHubFacts
  withUsage?: boolean
  respond: (argv: ReadonlyArray<string>) => FakeResult
}) => {
  const recorded: Array<ReadonlyArray<string>> = []
  return Effect.runPromise(
    observeNamespaceJob({ github, withUsage }).pipe(
      Effect.provide(fakeSpawner({ respond, recorded })),
      Effect.map((facts) => ({ facts, recorded })),
    ),
  )
}

describe('observeNamespaceJob', () => {
  it('spawns nothing at all for a self-hosted runner', async () => {
    const facts = await Effect.runPromise(
      observeNamespaceJob({
        github: githubFacts({
          runnerName: 'runnera-1234abcd',
          runnerKind: 'self-hosted',
          runnerInstance: 'runnera',
        }),
        withUsage: true,
      }).pipe(Effect.provide(forbiddenSpawner)),
    )
    expect(facts).toEqual({ _tag: 'not-namespace-job', runnerKind: 'self-hosted' })
  })

  it('spawns nothing for a job GitHub never assigned a runner to', async () => {
    const facts = await Effect.runPromise(
      observeNamespaceJob({
        github: githubFacts({ runnerName: null, runnerKind: 'unknown', runnerInstance: null }),
        withUsage: true,
      }).pipe(Effect.provide(forbiddenSpawner)),
    )
    expect(facts).toEqual({ _tag: 'not-namespace-job', runnerKind: 'unknown' })
  })

  it('reports a missing nsc as data and gets no further than check-login', async () => {
    const { facts, recorded } = await observe({
      github: githubFacts(),
      respond: () => ({ _tag: 'not-on-path' }),
    })
    expect(facts._tag).toBe('unavailable')
    expect(facts._tag === 'unavailable' && facts.reason).toBe('nsc-missing')
    expect(recorded).toEqual([['nsc', 'auth', 'check-login']])
  })

  it('reports an unusable session as not-authenticated without describing the job', async () => {
    const { facts, recorded } = await observe({
      github: githubFacts(),
      respond: () => output('', { stderr: 'not logged in', exitCode: 1 }),
    })
    expect(facts._tag === 'unavailable' && facts.reason).toBe('not-authenticated')
    expect(facts._tag === 'unavailable' && facts.detail).toBe('not logged in')
    expect(recorded).toEqual([['nsc', 'auth', 'check-login']])
  })

  it('distinguishes an unknown job from a broken command', async () => {
    const { facts } = await observe({
      github: githubFacts(),
      respond: (argv) =>
        argv[0] === 'auth'
          ? output('ok')
          : output('', { stderr: `job ${JOB_ID} not found`, exitCode: 1 }),
    })
    expect(facts._tag === 'unavailable' && facts.reason).toBe('job-not-found')
  })

  it('does not call an unrelated missing resource a missing GitHub job', async () => {
    const { facts } = await observe({
      github: githubFacts(),
      respond: (argv) =>
        argv[0] === 'auth'
          ? output('ok')
          : output('', {
              stderr: `failed to describe job ${JOB_ID}: workspace configuration not found`,
              exitCode: 1,
            }),
    })
    expect(facts._tag === 'unavailable' && facts.reason).toBe('command-failed')
  })

  it('reports output it cannot read as unrecognized rather than guessing', async () => {
    const { facts } = await observe({
      github: githubFacts(),
      respond: (argv) => (argv[0] === 'auth' ? output('ok') : output('{"job":{"name":"build"}}')),
    })
    expect(facts._tag === 'unavailable' && facts.reason).toBe('unrecognized-output')
  })

  it('keeps stderr out of the JSON it parses', async () => {
    const { facts } = await observe({
      github: githubFacts(),
      respond: (argv) =>
        argv[0] === 'auth'
          ? output('ok')
          : output(DESCRIBE_JSON, { stderr: 'warning: using cached tenant token' }),
    })
    expect(facts._tag).toBe('reported')
    expect(facts._tag === 'reported' && facts.job.instanceId).toBe(INSTANCE)
  })

  it('binds a multiple-attempt description to the GitHub runner instance', async () => {
    const describe = JSON.stringify({
      attempts: [
        {
          instance_id: 'previous-instance',
          instance_status: 'DESTROYED',
          runner_name: 'nsc-runner-previous-instance',
        },
        {
          instance_id: INSTANCE,
          instance_status: 'RUNNING',
          runner_name: `nsc-runner-${INSTANCE}`,
        },
      ],
    })
    const { facts } = await observe({
      github: githubFacts(),
      respond: (argv) => (argv[0] === 'auth' ? output('ok') : output(describe)),
    })

    expect(facts._tag).toBe('reported')
    expect(facts._tag === 'reported' && facts.job.instanceId).toBe(INSTANCE)
    expect(facts._tag === 'reported' && facts.job.instanceStatusRaw).toBe('RUNNING')
    expect(facts._tag === 'reported' && facts.job.runnerName).toBe(`nsc-runner-${INSTANCE}`)
  })

  it('scopes fallback metadata to the selected attempt and uses the GitHub job name for usage', async () => {
    const describe = JSON.stringify({
      attempts: [
        {
          job: { job_name: 'previous build', workflow_name: 'Previous CI' },
          repository: 'previous-org/previous-repo',
          runner: {
            instance_id: 'previous-instance',
            instance_status: 'DESTROYED',
            runner_name: 'nsc-runner-previous-instance',
            container_name: 'previous-container',
          },
        },
        {
          job: { workflow_name: 'Current CI' },
          repository: 'example-org/example-repo',
          runner: {
            instance_id: INSTANCE,
            instance_status: 'RUNNING',
            runner_name: `nsc-runner-${INSTANCE}`,
          },
        },
      ],
    })
    const { facts, recorded } = await observe({
      github: githubFacts(),
      withUsage: true,
      respond: (argv) =>
        argv[0] === 'auth'
          ? output('ok')
          : argv[0] === 'github'
            ? output(describe)
            : argv[argv.indexOf('--jobname') + 1] === 'build'
              ? output(REPORT_CSV)
              : output('instance_id\n'),
    })

    expect(facts._tag).toBe('reported')
    if (facts._tag !== 'reported') return
    expect(facts.job).toMatchObject({
      instanceId: INSTANCE,
      runnerName: `nsc-runner-${INSTANCE}`,
      containerName: null,
      repository: 'example-org/example-repo',
      workflow: 'Current CI',
      jobName: null,
    })
    expect(facts.usage._tag).toBe('sampled')
    expect(recorded.at(-1)?.slice(-2)).toEqual(['--jobname', 'build'])
  })

  it('isolates object-mapped attempts and falls back to the GitHub identity', async () => {
    const previous = {
      job: { job_name: 'previous build', workflow_name: 'Previous CI' },
      repository: 'previous-org/previous-repo',
      runner: {
        instance_id: 'previous-instance',
        instance_status: 'DESTROYED',
        runner_name: 'nsc-runner-previous-instance',
        container_name: 'previous-container',
      },
    }
    const current = {
      runner: {
        instance_id: INSTANCE,
        instance_status: 'RUNNING',
        runner_name: `nsc-runner-${INSTANCE}`,
      },
    }

    for (const attempts of [
      { previous, current },
      { current, previous },
    ]) {
      const { facts, recorded } = await observe({
        github: githubFacts(),
        withUsage: true,
        respond: (argv) =>
          argv[0] === 'auth'
            ? output('ok')
            : argv[0] === 'github'
              ? output(JSON.stringify({ attempts }))
              : argv[argv.indexOf('--jobname') + 1] === 'build'
                ? output(REPORT_CSV)
                : output('instance_id\n'),
      })

      expect(facts._tag).toBe('reported')
      if (facts._tag !== 'reported') return
      expect(facts.job).toMatchObject({
        instanceId: INSTANCE,
        runnerName: `nsc-runner-${INSTANCE}`,
        containerName: null,
        repository: null,
        workflow: null,
        jobName: null,
      })
      expect(facts.usage._tag).toBe('sampled')
      expect(recorded.at(-1)?.slice(-4)).toEqual([
        '--repository',
        'example-org/example-repo',
        '--jobname',
        'build',
      ])
    }
  })

  it('inherits enclosing metadata for an object-mapped attempt without sibling leakage', async () => {
    const previous = {
      job_name: 'previous build',
      workflow: 'Previous CI',
      repository: 'previous-org/previous-repo',
      runner: {
        instance_id: 'previous-instance',
        instance_status: 'DESTROYED',
        runner_name: 'nsc-runner-previous-instance',
      },
    }
    const current = {
      job: { workflow_name: 'Current CI' },
      runner: {
        instance_id: INSTANCE,
        instance_status: 'RUNNING',
        runner_name: `nsc-runner-${INSTANCE}`,
      },
    }

    for (const attempts of [
      { previous, current },
      { current, previous },
    ]) {
      const { facts, recorded } = await observe({
        github: githubFacts(),
        withUsage: true,
        respond: (argv) =>
          argv[0] === 'auth'
            ? output('ok')
            : argv[0] === 'github'
              ? output(
                  JSON.stringify({
                    job_name: 'parent build',
                    workflow: 'Parent CI',
                    repository: 'parent-org/parent-repo',
                    attempts,
                  }),
                )
              : argv[argv.indexOf('--jobname') + 1] === 'parent build'
                ? output(REPORT_CSV)
                : output('instance_id\n'),
      })

      expect(facts._tag).toBe('reported')
      if (facts._tag !== 'reported') return
      expect(facts.job).toMatchObject({
        instanceId: INSTANCE,
        runnerName: `nsc-runner-${INSTANCE}`,
        repository: 'parent-org/parent-repo',
        workflow: 'Current CI',
        jobName: 'parent build',
      })
      expect(facts.usage._tag).toBe('sampled')
      expect(recorded.at(-1)?.slice(-4)).toEqual([
        '--repository',
        'parent-org/parent-repo',
        '--jobname',
        'parent build',
      ])
    }
  })

  it('excludes sibling attempt metadata for a root runner and uses the GitHub job name', async () => {
    const describe = JSON.stringify({
      job: { workflow_name: 'Current CI' },
      runner: {
        instance_id: INSTANCE,
        instance_status: 'RUNNING',
        runner_name: `nsc-runner-${INSTANCE}`,
      },
      attempts: [
        {
          job: { job_name: 'previous build', workflow_name: 'Previous CI' },
          repository: 'previous-org/previous-repo',
          runner: {
            instance_id: 'previous-instance',
            instance_status: 'DESTROYED',
          },
        },
      ],
    })
    const { facts, recorded } = await observe({
      github: githubFacts(),
      withUsage: true,
      respond: (argv) =>
        argv[0] === 'auth'
          ? output('ok')
          : argv[0] === 'github'
            ? output(describe)
            : argv[argv.indexOf('--jobname') + 1] === 'build'
              ? output(REPORT_CSV)
              : output('instance_id\n'),
    })

    expect(facts._tag).toBe('reported')
    if (facts._tag !== 'reported') return
    expect(facts.job).toMatchObject({
      instanceId: INSTANCE,
      repository: null,
      workflow: 'Current CI',
      jobName: null,
    })
    expect(facts.usage._tag).toBe('sampled')
    expect(recorded.at(-1)?.slice(-2)).toEqual(['--jobname', 'build'])
  })

  it('excludes object-valued previous-attempt metadata for a root runner', async () => {
    const describe = JSON.stringify({
      job: { workflow_name: 'Current CI' },
      runner: {
        instance_id: INSTANCE,
        instance_status: 'RUNNING',
        runner_name: `nsc-runner-${INSTANCE}`,
      },
      previous_attempt: {
        job: { job_name: 'previous build', workflow_name: 'Previous CI' },
        repository: 'previous-org/previous-repo',
        runner: {
          instance_id: 'previous-instance',
          instance_status: 'DESTROYED',
        },
      },
    })
    const { facts, recorded } = await observe({
      github: githubFacts(),
      withUsage: true,
      respond: (argv) =>
        argv[0] === 'auth'
          ? output('ok')
          : argv[0] === 'github'
            ? output(describe)
            : argv[argv.indexOf('--jobname') + 1] === 'build'
              ? output(REPORT_CSV)
              : output('instance_id\n'),
    })

    expect(facts._tag).toBe('reported')
    if (facts._tag !== 'reported') return
    expect(facts.job).toMatchObject({
      instanceId: INSTANCE,
      repository: null,
      workflow: 'Current CI',
      jobName: null,
    })
    expect(facts.usage._tag).toBe('sampled')
    expect(recorded.at(-1)?.slice(-2)).toEqual(['--jobname', 'build'])
  })

  it('does not run the report at all without --with-usage', async () => {
    const { facts, recorded } = await observe({
      github: githubFacts(),
      respond: (argv) => (argv[0] === 'auth' ? output('ok') : output(DESCRIBE_JSON)),
    })
    expect(facts._tag === 'reported' && facts.usage._tag).toBe('not-requested')
    expect(recorded).toEqual([
      ['nsc', 'auth', 'check-login'],
      ['nsc', 'github', 'job', 'describe', String(JOB_ID), '-o', 'json'],
    ])
  })

  it('samples usage with a bounded, filtered report and records only approved argv', async () => {
    const { facts, recorded } = await observe({
      github: githubFacts(),
      withUsage: true,
      respond: (argv) =>
        argv[0] === 'auth'
          ? output('ok')
          : argv[0] === 'github'
            ? output(DESCRIBE_JSON)
            : output(REPORT_CSV),
    })

    expect(facts._tag === 'reported' && facts.usage._tag).toBe('sampled')
    expect(
      facts._tag === 'reported' && facts.usage._tag === 'sampled'
        ? facts.usage.sample.cpuMaxFraction
        : null,
    ).toBe(0.97 / 8)

    const window = deriveReportWindow({
      startedAt: '2026-01-15T11:00:00.000Z',
      completedAt: '2026-01-15T11:04:00.000Z',
      now: new Date(),
    })
    expect(recorded).toEqual([
      ['nsc', 'auth', 'check-login'],
      ['nsc', 'github', 'job', 'describe', String(JOB_ID), '-o', 'json'],
      [
        'nsc',
        'instance',
        'report',
        '--start',
        window!.start,
        '--end',
        window!.end,
        '--out',
        '-',
        '--repository',
        'example-org/example-repo',
        '--jobname',
        'build',
      ],
    ])
    /** Every recorded invocation, argv[0] aside, is on the approved list. */
    for (const argv of recorded) {
      expect(argv[0]).toBe('nsc')
      expect(isAllowedArgv(argv.slice(1))).toBe(true)
    }
    expect(facts._tag === 'reported' && facts.commands).toEqual(
      recorded.map((argv) => argv.slice(1)),
    )
  })

  it('keeps the job facts when only the usage report is unusable', async () => {
    const { facts } = await observe({
      github: githubFacts(),
      withUsage: true,
      respond: (argv) =>
        argv[0] === 'auth'
          ? output('ok')
          : argv[0] === 'github'
            ? output(DESCRIBE_JSON)
            : output('', { stderr: 'report backend unavailable', exitCode: 2 }),
    })
    expect(facts._tag).toBe('reported')
    expect(facts._tag === 'reported' && facts.job.instanceId).toBe(INSTANCE)
    expect(
      facts._tag === 'reported' && facts.usage._tag === 'unavailable' && facts.usage.reason,
    ).toBe('command-failed')
  })

  it('refuses a report window it cannot bound instead of scanning the workspace', async () => {
    const { facts, recorded } = await observe({
      github: githubFacts({ startedAt: null, completedAt: null }),
      withUsage: true,
      respond: (argv) => (argv[0] === 'auth' ? output('ok') : output(DESCRIBE_JSON)),
    })
    expect(
      facts._tag === 'reported' && facts.usage._tag === 'unavailable' && facts.usage.reason,
    ).toBe('no-window')
    expect(recorded.some((argv) => argv[1] === 'instance')).toBe(false)
  })

  it('reports a job absent from the report window as no-matching-row', async () => {
    const { facts } = await observe({
      github: githubFacts(),
      withUsage: true,
      respond: (argv) =>
        argv[0] === 'auth'
          ? output('ok')
          : argv[0] === 'github'
            ? output(DESCRIBE_JSON)
            : output(REPORT_CSV.replace(String(JOB_ID), '11111111111')),
    })
    expect(
      facts._tag === 'reported' && facts.usage._tag === 'unavailable' && facts.usage.reason,
    ).toBe('no-matching-row')
  })
})
