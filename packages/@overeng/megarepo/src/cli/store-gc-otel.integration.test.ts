/**
 * OTEL instrumentation contract test for `mr store gc` (decision 0007).
 *
 * The principled replacement for "disable OTEL in tests": instead of asserting
 * nothing about telemetry, this runs the gc in-process through the foundation
 * `OteliteTestHarness.runInProcessAllSignals` capture — a REAL ephemeral OTLP
 * receiver wired to the gc's spans + metrics + logs — and asserts the contract
 * via the `expectTrace`/`expectMetrics` DSL. The gc runs through the same
 * deterministic harness the cold test uses (fixed decision clock + stub
 * `PrStateResolver`, no real `gh`/network).
 *
 * It is hermetic by construction (its own ephemeral receiver, torn down on scope
 * close) and non-vacuous: it fails loudly if a gc phase span is renamed/dropped,
 * if the `git/cmd` span loses `git.output.bytes`, or if the
 * `megarepo_store_gc_rss_bytes` gauge is absent / stubbed to a non-positive value
 * (the `metrics.expectSome` value predicate + label assertion). Because the
 * asserted run executes under the fixed clock with the foundation sampler active,
 * it ALSO proves the sampler ticks on a real clock under a zero-sleep decision
 * clock (the old clock-coupled sampler would hot-loop and hang).
 */

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Cause, Clock, Duration, Effect, Exit, Layer, Option, Ref, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Cli from 'effect/unstable/cli'
import * as Command from 'effect/unstable/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'
import { expect } from 'vitest'

import { EffectPath, type AbsoluteDirPath, type RelativeDirPath } from '@overeng/effect-path'
import { attr, metricValue, OteliteTestHarness, telemetryAttr } from '@overeng/utils-dev/otelite'
import { OtelConfig } from '@overeng/utils/node/otel'

import {
  makeStubPrStateResolverLayer,
  type GhPr,
  type StubPrRepo,
} from '../store/store-pr-state.ts'
import { makeConsoleCapture } from '../test-utils/consoleCapture.ts'
import { requireTool } from '../test-utils/require-tool.ts'
import { createStoreFixture, getWorktreeCommit } from '../test-utils/store-setup.ts'
import { mrCommand } from './mod.ts'

const gitBin = requireTool('GIT_BIN')

const SERVICE = 'megarepo'
const DAY_MS = 24 * 60 * 60 * 1000
/** A fixed decision clock: well past every default grace window. */
const NOW = Date.parse('2026-06-11T12:00:00.000Z')

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    return (yield* ChildProcessSpawner.use((spawner) =>
      spawner.string(Command.make(gitBin, args, { cwd })),
    )).trim()
  })

/**
 * Deterministic DECISION clock — `currentTime{Millis,Nanos}` are pinned to
 * `nowMs` so every grace/retention decision is reproducible — but `sleep`
 * delegates to a REAL live clock (`Clock.make()`) instead of the cold test's
 * `() => Effect.void`.
 *
 * Why real sleep here: this test runs the gc with the OTEL exporter active, and
 * both the foundation RSS sampler and the all-signals exporter's reader fibers
 * schedule on `Clock.sleep`. A zero-sleep clock turns those infra timers into hot
 * loops that starve the runtime and hang the run. A real `sleep` (decision time
 * still fixed) lets the infra timers tick on wall time while keeping gc decisions
 * deterministic — the root-cause fix, with no production workaround.
 */
/** Live wall-clock for infra timers; decision time is overridden per test. */
const liveClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => Date.now(),
  currentTimeMillis: Effect.sync(() => Date.now()),
  currentTimeNanosUnsafe: () => BigInt(Date.now()) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(Date.now()) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => process.hrtime.bigint(),
  monotonicTimeNanos: Effect.sync(() => process.hrtime.bigint()),
  sleep: (duration) =>
    Effect.callback((resume) => {
      const timer = setTimeout(() => resume(Effect.void), Duration.toMillis(duration))
      timer.unref?.()
    }),
}
const fixedClockLayer = (nowMs: number) =>
  Layer.succeed(Clock.Clock, {
    currentTimeMillisUnsafe: () => nowMs,
    currentTimeMillis: Effect.succeed(nowMs),
    currentTimeNanosUnsafe: () => BigInt(nowMs) * 1_000_000n,
    currentTimeNanos: Effect.succeed(BigInt(nowMs) * 1_000_000n),
    monotonicTimeNanosUnsafe: liveClock.monotonicTimeNanosUnsafe,
    monotonicTimeNanos: liveClock.monotonicTimeNanos,
    sleep: (duration) => liveClock.sleep(duration),
  })

const REPO = { host: 'github.com', owner: 'acme', repo: 'widget' } as const
const REPO_KEY = `${REPO.host}/${REPO.owner}/${REPO.repo}`
const REPO_RELATIVE = `${REPO_KEY}/` as RelativeDirPath

const mergedPr = (branch: string, mergedAt: number): GhPr => ({
  number: 1,
  state: 'MERGED',
  headRefName: branch,
  mergedAt: new Date(mergedAt).toISOString(),
  closedAt: new Date(mergedAt).toISOString(),
})

const StoreGcJsonOutput = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      repo: Schema.String,
      ref: Schema.String,
      status: Schema.String,
      reason: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
    }),
  ),
})
const decodeGc = Schema.decodeUnknownSync(Schema.fromJsonString(StoreGcJsonOutput))
type GcResults = (typeof StoreGcJsonOutput.Type)['results']

/**
 * `mr store gc` as an in-process WORKLOAD effect (no exporter of its own — the
 * harness owns the OTLP layer). The gc's RSS sampler gates on `OtelConfig`, so we
 * provide it here with `endpoint: Some` when `telemetry` is on (the gate only
 * checks `isSome`; export itself is the harness's all-signals layer) and `None`
 * otherwise (sampler no-ops — exercises the off-path for the seed run). No
 * `process.env` mutation beyond `MEGAREPO_STORE`, restored on exit. The decoded
 * `results` are written to `resultsRef` because `runInProcessAllSignals` returns
 * only the signal expectations, not the workload value.
 */
const runGc = ({
  cwd,
  storePath,
  prRepos,
  resultsRef,
  telemetry,
  now = NOW,
}: {
  cwd: AbsoluteDirPath
  storePath: AbsoluteDirPath
  prRepos: ReadonlyArray<StubPrRepo>
  resultsRef: Ref.Ref<GcResults>
  telemetry: Option.Option<string>
  now?: number
}) =>
  Effect.gen(function* () {
    const { consoleLayer, getStdoutLines } = yield* makeConsoleCapture
    const previous = process.env['MEGAREPO_STORE']
    process.env['MEGAREPO_STORE'] = storePath

    // `mrCommand` provides its own `Cwd` layer from the `--cwd` global flag, so an
    // outer `Effect.provideService(Cwd, …)` is overridden and every command would
    // silently run against the ambient process cwd. Drive the documented flag.
    const argv = ['--cwd', cwd, 'store', 'gc', '--output', 'json']
    const exit = yield* Cli.Command.runWith(mrCommand, { version: 'test' })(argv).pipe(
      Effect.provideService(OtelConfig, { endpoint: telemetry }),
      Effect.provide(
        Layer.mergeAll(
          consoleLayer,
          makeStubPrStateResolverLayer(prRepos),
          fixedClockLayer(now),
          NodeServices.layer,
        ),
      ),
      Effect.scoped,
      Effect.exit,
    )

    if (previous === undefined) delete process.env['MEGAREPO_STORE']
    else process.env['MEGAREPO_STORE'] = previous

    const stdout = (yield* getStdoutLines).join('\n')
    if (Exit.isSuccess(exit) === false) {
      return yield* Effect.die(
        new Error(`mr store gc failed:\n${Cause.pretty(exit.cause)}\nstdout:\n${stdout}`),
      )
    }
    yield* Ref.set(resultsRef, decodeGc(stdout).results)
  })

const outsideCwd = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
    const cwd = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('outside/'))
    yield* fs.makeDirectory(cwd, { recursive: true })
    return cwd
  })

const EXPECTED_PHASES = [
  'collect-liveness',
  'list-repos',
  'collect-worktrees',
  'resolve-pr',
  'cold-reclaim',
  'legacy-sweep',
] as const

describe('mr store gc — OTEL instrumentation contract', () => {
  it.live(
    'exports observable store fixture setup spans and bounded git command spans',
    () =>
      Effect.gen(function* () {
        const harness = yield* OteliteTestHarness
        const capture = yield* harness.capture({
          serviceName: SERVICE,
          rootSpanName: 'megarepo.fixture-otel.root',
          exportInterval: 50,
        })

        const trace = yield* capture.runInProcessTrace(
          createStoreFixture([{ ...REPO, branches: ['feature/fixture'], withRemote: true }]),
        )

        trace.expectSome({
          name: 'megarepo/test/store-fixture/create',
          attrs: { 'megarepo.test.store_fixture.repo_count': '1' },
        })
        trace.expectSome({
          name: 'megarepo/test/store-fixture/repo',
          attrs: {
            'megarepo.test.store_fixture.repo': REPO_KEY,
            'megarepo.test.store_fixture.with_remote': 'true',
          },
        })
        trace.expectSome({ name: 'megarepo/test/store-fixture/init-source' })
        trace.expectSome({ name: 'megarepo/test/store-fixture/fetch-store-bare' })
        // Operation-aware git deadline is wired through the real subprocess path: a LOCAL
        // op (`init`) carries the tight 30s bound, a NETWORK op (`fetch`) the generous 10min
        // one. This exercises the classification end-to-end (against a local remote, no
        // actual network), not just the pure `gitCommandTimeoutMillis` helper.
        trace.expectSome({
          name: 'git/cmd',
          attrs: { 'git.subcommand': 'init', 'git.timeout_ms': attr.int(30_000) },
        })
        trace.expectSome({
          name: 'git/cmd',
          attrs: { 'git.subcommand': 'fetch', 'git.timeout_ms': attr.int(600_000) },
        })
      }).pipe(Effect.provide(Layer.mergeAll(OteliteTestHarness.layer, NodeServices.layer))),
    30_000,
  )

  it.live(
    'exports the gc phase spans, a git/cmd span with git.output.bytes, and the RSS gauge',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/merged'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/merged`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        // Materialize the branch ref so the cold/merged path classifies it.
        yield* git(bareRepoPath, 'branch', 'feature/merged', commit)

        const cwd = yield* outsideCwd()

        // Stand up the in-process all-signals capture (traces + metrics + logs).
        const harness = yield* OteliteTestHarness
        const capture = yield* harness.capture({ serviceName: SERVICE, exportInterval: 50 })
        const endpoint = capture.capture.endpoints.http

        const seedResults = yield* Ref.make<GcResults>([])
        const assertedResults = yield* Ref.make<GcResults>([])

        // Seed cold (absence grace) so the asserted run takes the cold-reclaim
        // path. Runs OUTSIDE the capture with telemetry OFF: keeps the captured
        // signals single-valued (so `expectOne` works) and exercises the sampler
        // no-op path. The fixed DECISION clock keeps this reproducible.
        yield* runGc({
          cwd,
          storePath,
          prRepos: [{ relativePath: REPO_RELATIVE, prs: [] }],
          resultsRef: seedResults,
          telemetry: Option.none(),
          now: NOW - 20 * DAY_MS,
        })

        // The asserted run executes INSIDE the all-signals capture with telemetry
        // ON, so its spans + the RSS gauge land in the ephemeral receiver. The
        // sampler gate reads the `OtelConfig` endpoint we provide in `runGc`.
        // `spanLabelPolicy: 'off'` because the still-raw `git/cmd` / store spans
        // (Track-A, out of scope) deliberately lack `span.label`.
        const { trace, metrics } = yield* capture.runInProcessAllSignals(
          runGc({
            cwd,
            storePath,
            prRepos: [
              { relativePath: REPO_RELATIVE, prs: [mergedPr('feature/merged', NOW - 30 * DAY_MS)] },
            ],
            resultsRef: assertedResults,
            telemetry: Option.some(endpoint),
          }),
          { trace: { spanLabelPolicy: 'off' } },
        )

        // --- Behavioral non-vacuity: the gc actually did cold-reclaim work. ---
        const results = yield* Ref.get(assertedResults)
        expect(results.some((r) => r.ref === 'feature/merged' && r.status === 'archived')).toBe(
          true,
        )
        // The worktree was archived away (cold-reclaim executed, not a no-op).
        expect(yield* fs.exists(worktreePath)).toBe(false)

        // --- All six phases of the default cold path emitted ≥1 span. ---
        for (const phase of EXPECTED_PHASES) {
          trace.expectSome({ name: `megarepo/store/gc/${phase}` })
        }

        // --- A git/cmd span carries the scalar git.output.bytes attr. ---
        trace.expectSome({ name: 'git/cmd', attrs: { 'git.output.bytes': attr.present() } })

        // --- The RSS gauge landed with value>0 and a megarepo.store.gc.repo_concurrency label. ---
        // `expectSome` (not `expectOne`): the sampler may emit several data points
        // across collection intervals — the contract is ≥1 positive-valued,
        // labeled point, which the selector enforces non-vacuously.
        metrics.expectSome({
          name: 'megarepo_store_gc_rss_bytes',
          service: SERVICE,
          type: 'gauge',
          value: metricValue.predicate('rss > 0', (rss) => rss > 0),
          attrs: { 'megarepo.store.gc.repo_concurrency': telemetryAttr.present() },
        })
      }).pipe(Effect.provide(Layer.mergeAll(OteliteTestHarness.layer, NodeServices.layer))),
    60_000,
  )
})
