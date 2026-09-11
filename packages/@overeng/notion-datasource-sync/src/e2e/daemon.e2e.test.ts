import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Effect, Fiber, Schema, Stream, Tracer } from 'effect'
import { describe, expect, it } from 'vitest'

import { bodySafetySnapshot, makeFakePageBodySyncPort } from '../body/adapter.ts'
import { runCliCommand, type CliContext } from '../cli/main.ts'
import { PagePropertyItemPage } from '../core/commands.ts'
import {
  AbsolutePath,
  BodyPointer,
  PageId,
  WorkspaceRelativePath,
  bodyDescriptorForDigest,
  bodyEvidenceFingerprintFromContentDigest,
  evidenceBackedBodyIdentity,
  type Hash as HashType,
  type PageId as PageIdType,
} from '../core/domain.ts'
import { BodySyncError } from '../core/errors.ts'
import { SyncEventId } from '../core/events.ts'
import { LocalWorkspacePort, NotionDataSourceGateway, PageBodySyncPort } from '../core/ports.ts'
import { SignalExternalId, SignalId, SignalProvider } from '../core/signals.ts'
import { readOneShotSyncStatus } from '../core/status.ts'
import {
  makeWatchDaemonWakeNotifier,
  readWatchDaemonState,
  runWatchDaemon,
  runWatchDaemonCycle,
  WatchDaemonCancelled,
  type WatchDaemonOptions,
} from '../daemon/watch.ts'
import { allGatewayCapabilities, makeGatewayError } from '../gateway/gateway.ts'
import {
  isOwnWriteObservation,
  makeFilesystemLocalWorkspacePort,
  presentArtifactObservation,
} from '../local/workspace.ts'
import { spanAttr, spanNames } from '../observability/observability.ts'
import { initOneShotSync, pullOneShotSync } from '../sync/sync.ts'
import { collectWorkspaceScan, makeTempWorkspace } from '../testing/filesystem.ts'
import {
  defaultQueryContract,
  decode,
  fakeBodyPage,
  fixedObservedAt,
  hash,
  makeFakeClock,
  makeFakeGatewayHarness,
  makeHarnessPorts,
  makeStoreFixture,
  pageSnapshot,
  testIds,
} from '../testing/harness.ts'
import { scenarioImplementationGaps, type ScenarioId } from '../testing/scenarios.ts'
import { computeNotionWebhookSignature } from '../webhook/notion.ts'
import { handleNotionWebhookDelivery } from '../webhook/receiver.ts'

const workspaceRoot = decode({ schema: AbsolutePath, value: '/tmp/notion-ds-sync-daemon' })

const schemaProperties = [
  {
    propertyId: testIds.propertyA,
    configHash: hash('config-a'),
    writeClass: 'writable' as const,
  },
]

const signalProvider = decode({ schema: SignalProvider, value: 'test-provider' })
const signalIdA = decode({ schema: SignalId, value: 'signal-a' })
const signalIdB = decode({ schema: SignalId, value: 'signal-b' })
const signalExternalIdA = decode({ schema: SignalExternalId, value: 'external-a' })
const signalExternalIdB = decode({ schema: SignalExternalId, value: 'external-b' })

const implementedDaemonScenarioIds = new Set<ScenarioId>([
  'NDS-L5-watch-daemon-local-cycle',
  'NDS-L3-doctor-guard-state',
  'NDS-L5-realistic-daemon-restart-cancellation',
  'NDS-L5-daemon-query-cursor-resume',
  'NDS-L5-daemon-bounded-outbox-drain',
  'NDS-L5-daemon-repeated-fake-soak',
  'NDS-L5-daemon-mixed-mutation-soak',
  'NDS-L5-webhook-hint-fresh-read-coalesce',
])

const propertyPage = ({
  pageId = testIds.pageId,
  itemHash = hash('property-a-base'),
}: {
  readonly pageId?: PageIdType
  readonly itemHash?: HashType
} = {}) =>
  decode({
    schema: PagePropertyItemPage,
    value: {
      _tag: 'PagePropertyItemPage',
      apiVersion: '2026-03-11',
      requestId: testIds.requestId,
      pageId,
      propertyId: testIds.propertyA,
      items: [
        {
          _tag: 'PagePropertyItem',
          pageId,
          propertyId: testIds.propertyA,
          itemHash,
          valueHash: itemHash,
        },
      ],
      nextCursor: null,
      hasMore: false,
    },
  })

const bodyPage = ({
  pageId = testIds.pageId,
  bodyHash = hash('body-a'),
}: {
  readonly pageId?: PageIdType
  readonly bodyHash?: HashType
} = {}) =>
  fakeBodyPage({
    pageId,
    pointer: decode({
      schema: BodyPointer,
      value: {
        _tag: 'BodyPointer',
        pageId,
        identity: evidenceBackedBodyIdentity({
          rendered: bodyDescriptorForDigest(bodyHash),
          evidenceFingerprint: bodyEvidenceFingerprintFromContentDigest(bodyHash),
          completeness: 'complete',
        }),
        observedAt: fixedObservedAt,
        safety: bodySafetySnapshot(),
      },
    }),
  })

const localBodyChange = ({
  pageId = testIds.pageId,
  path = decode({ schema: WorkspaceRelativePath, value: 'row--page-1.nmd' }),
  contentHash = hash('body-local'),
}: {
  readonly pageId?: PageIdType
  readonly path?: WorkspaceRelativePath
  readonly contentHash?: HashType
} = {}) =>
  presentArtifactObservation({
    pageId,
    path,
    contentHash,
    observedAt: decode({ schema: Schema.DateTimeUtcFromString, value: fixedObservedAt }),
  })

type QueryCheckpointRow = {
  readonly data_source_id: string
  readonly query_contract_hash: string
  readonly next_cursor: string | null
  readonly complete: 0 | 1
  readonly capped_at_limit: 0 | 1
  readonly contract_changed: 0 | 1
  readonly high_watermark: string | null
}

const readQueryCheckpointRows = (path: string): ReadonlyArray<QueryCheckpointRow> => {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return database
      .prepare(
        `SELECT data_source_id,
                query_contract_hash,
                next_cursor,
                complete,
                capped_at_limit,
                contract_changed,
                high_watermark
         FROM _nds_query_scan_checkpoint
         WHERE root_id = ?
         ORDER BY data_source_id, query_contract_hash`,
      )
      .all(testIds.rootId)
      .map((row) => ({
        data_source_id: String(row.data_source_id),
        query_contract_hash: String(row.query_contract_hash),
        next_cursor: row.next_cursor === null ? null : String(row.next_cursor),
        complete: row.complete === 1 ? 1 : 0,
        capped_at_limit: row.capped_at_limit === 1 ? 1 : 0,
        contract_changed: row.contract_changed === 1 ? 1 : 0,
        high_watermark: row.high_watermark === null ? null : String(row.high_watermark),
      }))
  } finally {
    database.close()
  }
}

const context = (input: {
  readonly store: CliContext['store']
  readonly clock: ReturnType<typeof makeFakeClock>
  readonly queryContract?: CliContext['queryContract']
  readonly schemaProperties?: CliContext['schemaProperties']
  readonly workspaceRoot?: CliContext['workspaceRoot']
}): CliContext => ({
  store: input.store,
  rootId: testIds.rootId,
  dataSourceId: testIds.dataSourceId,
  workspaceRoot: input.workspaceRoot ?? workspaceRoot,
  queryContract: input.queryContract ?? defaultQueryContract(),
  schemaProperties: input.schemaProperties ?? schemaProperties,
  now: input.clock.now,
})

const daemonOptions = (input: {
  readonly store: WatchDaemonOptions['store']
  readonly statePath: string
  readonly clock: ReturnType<typeof makeFakeClock>
  readonly maxExecutorSteps?: number
  readonly maxCycles?: number
  readonly cycleTimeoutMs?: number
  readonly leaseToken?: string
  readonly signal?: AbortSignal
  readonly useDefaultLease?: boolean
  readonly leaseDurationMs?: number
  readonly sleep?: WatchDaemonOptions['sleep']
  readonly wakeNotifier?: WatchDaemonOptions['wakeNotifier']
  readonly queryContract?: WatchDaemonOptions['queryContract']
  readonly schemaProperties?: WatchDaemonOptions['schemaProperties']
  readonly workspaceRoot?: WatchDaemonOptions['workspaceRoot']
}): WatchDaemonOptions => ({
  store: input.store,
  rootId: testIds.rootId,
  dataSourceId: testIds.dataSourceId,
  workspaceRoot: input.workspaceRoot ?? workspaceRoot,
  queryContract: input.queryContract ?? defaultQueryContract(),
  schemaProperties: input.schemaProperties ?? schemaProperties,
  statePath: input.statePath,
  ...(input.useDefaultLease === true
    ? {}
    : { leaseToken: input.leaseToken ?? 'daemon-test-lease' }),
  now: input.clock.now,
  ...(input.maxExecutorSteps === undefined ? {} : { maxExecutorSteps: input.maxExecutorSteps }),
  ...(input.maxCycles === undefined ? {} : { maxCycles: input.maxCycles }),
  ...(input.cycleTimeoutMs === undefined ? {} : { cycleTimeoutMs: input.cycleTimeoutMs }),
  ...(input.leaseDurationMs === undefined ? {} : { leaseDurationMs: input.leaseDurationMs }),
  ...(input.signal === undefined ? {} : { signal: input.signal }),
  ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
  ...(input.wakeNotifier === undefined ? {} : { wakeNotifier: input.wakeNotifier }),
})

const runWithPorts = <TValue, TError>(
  effect: Effect.Effect<
    TValue,
    TError,
    NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
  >,
  input: {
    readonly gateway: ReturnType<typeof makeFakeGatewayHarness>['gateway']
    readonly body: ReturnType<typeof makeHarnessPorts>['body']
    readonly workspace: ReturnType<typeof makeHarnessPorts>['workspace']
  },
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(NotionDataSourceGateway, input.gateway),
      Effect.provideService(PageBodySyncPort, input.body),
      Effect.provideService(LocalWorkspacePort, input.workspace),
    ),
  )

const makeDeferred = <TValue = void>() => {
  let resolve!: (value: TValue) => void
  const promise = new Promise<TValue>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const withFailsafe = async <TValue>(promise: Promise<TValue>, label: string): Promise<TValue> => {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(label)), 2_000)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
  }
}

type RecordedDaemonSpan = {
  readonly name: string
  readonly attributes: Record<string, unknown>
  ended: boolean
}

const makeDaemonRecordingTracer = (): {
  readonly tracer: Tracer.Tracer
  readonly spans: ReadonlyArray<RecordedDaemonSpan>
} => {
  const spans: RecordedDaemonSpan[] = []

  return {
    spans,
    tracer: Tracer.make({
      span(options) {
        const attributes = new Map<string, unknown>(
          Object.entries(options.annotations.mapUnsafe ?? {}),
        )
        const recorded: RecordedDaemonSpan = {
          name: options.name,
          attributes: Object.fromEntries(attributes),
          ended: false,
        }
        spans.push(recorded)

        return {
          _tag: 'Span',
          name: options.name,
          spanId: `daemon-soak-span-${spans.length.toString()}`,
          traceId: 'trace-daemon-soak-e2e',
          parent: options.parent,
          annotations: options.annotations,
          status: { _tag: 'Started', startTime: options.startTime },
          attributes,
          links: options.links,
          sampled: options.sampled,
          kind: options.kind,
          end: () => {
            recorded.ended = true
          },
          attribute: (key, value) => {
            attributes.set(key, value)
            recorded.attributes[key] = value
          },
          event: () => {},
          addLinks: () => {},
        }
      },
    }),
  }
}

describe('watch daemon surface', () => {
  it('keeps daemon scenario metadata implemented', () => {
    expect(
      scenarioImplementationGaps({
        file: 'src/e2e/daemon.e2e.test.ts',
        implementedScenarioIds: implementedDaemonScenarioIds,
      }),
    ).toEqual([])
  })

  it('runs unbounded by default until cancellation instead of stopping after one cycle', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const ports = makeHarnessPorts()
    const statePath = `${storeFixture.path}.watch.json`
    const controller = new AbortController()
    const sleeps: number[] = []

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })

      const result = await runWithPorts(
        runWatchDaemon(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            signal: controller.signal,
            sleep: (millis) =>
              Effect.sync(() => {
                sleeps.push(millis)
                controller.abort()
              }),
          }),
        ),
        { gateway: gateway.gateway, body: ports.body, workspace: ports.workspace },
      )

      expect(result).toMatchObject({
        cycles: 2,
        completed: 1,
        cancelled: true,
      })
      expect(sleeps).toEqual([5_000])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('settles a claimed signal after a successful full sync cycle', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const ports = makeHarnessPorts()
    const statePath = `${storeFixture.path}.watch.json`

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      storeFixture.store.enqueueSignal({
        rootId: testIds.rootId,
        signalId: signalIdA,
        provider: signalProvider,
        externalId: signalExternalIdA,
        dataSourceId: testIds.dataSourceId,
        pageId: testIds.pageId,
      })

      const result = await runWithPorts(
        runWatchDaemonCycle(daemonOptions({ store: storeFixture.store, statePath, clock })),
        { gateway: gateway.gateway, body: ports.body, workspace: ports.workspace },
      )

      expect(result.signal?.signalId).toBe(signalIdA)
      expect(storeFixture.store.readSignalStatus(testIds.rootId)).toEqual({
        pending: 0,
        claimed: 0,
        processed: 1,
        failed: 0,
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('releases a claimed signal without marking it processed when the cycle fails', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const ports = makeHarnessPorts()
    const statePath = `${storeFixture.path}.watch.json`
    const failingGateway = {
      ...gateway.gateway,
      retrieveDataSource: (
        dataSourceId: Parameters<typeof gateway.gateway.retrieveDataSource>[0],
      ) =>
        Effect.fail(
          makeGatewayError({
            operation: 'retrieveDataSource',
            dataSourceId,
            message: 'signal cycle failure',
          }),
        ),
    }

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      storeFixture.store.enqueueSignal({
        rootId: testIds.rootId,
        signalId: signalIdA,
        provider: signalProvider,
        externalId: signalExternalIdA,
      })

      await expect(
        runWithPorts(
          runWatchDaemonCycle(daemonOptions({ store: storeFixture.store, statePath, clock })),
          { gateway: failingGateway, body: ports.body, workspace: ports.workspace },
        ),
      ).rejects.toThrow('signal cycle failure')

      expect(storeFixture.store.readSignals(testIds.rootId)).toMatchObject([
        {
          signalId: signalIdA,
          state: 'pending',
          attemptCount: 1,
          lastError: 'NotionGatewayError',
        },
      ])
      expect(storeFixture.store.readSignalStatus(testIds.rootId).processed).toBe(0)
    } finally {
      storeFixture.cleanup()
    }
  })

  it('uses pending signals to wake the next daemon cycle without normal polling delay', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const ports = makeHarnessPorts()
    const statePath = `${storeFixture.path}.watch.json`
    const sleeps: number[] = []

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      storeFixture.store.enqueueSignal({
        rootId: testIds.rootId,
        signalId: signalIdA,
        provider: signalProvider,
        externalId: signalExternalIdA,
      })
      storeFixture.store.enqueueSignal({
        rootId: testIds.rootId,
        signalId: signalIdB,
        provider: signalProvider,
        externalId: signalExternalIdB,
      })

      const result = await runWithPorts(
        runWatchDaemon(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            maxCycles: 2,
            sleep: (millis) =>
              Effect.sync(() => {
                sleeps.push(millis)
              }),
          }),
        ),
        { gateway: gateway.gateway, body: ports.body, workspace: ports.workspace },
      )

      expect(result).toMatchObject({ cycles: 2, completed: 2, cancelled: false })
      expect(sleeps).toEqual([0])
      expect(storeFixture.store.readSignalStatus(testIds.rootId)).toEqual({
        pending: 0,
        claimed: 0,
        processed: 2,
        failed: 0,
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('wakes a sleeping daemon when a webhook receiver notifies a newly enqueued signal', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const ports = makeHarnessPorts()
    const statePath = `${storeFixture.path}.watch.json`
    const wakeNotifier = makeWatchDaemonWakeNotifier()
    const sleepStarted = makeDeferred<number>()
    const observedWaits: number[] = []
    const instrumentedWakeNotifier = {
      wake: wakeNotifier.wake,
      awaitWake: (millis: number) =>
        Effect.sync(() => {
          observedWaits.push(millis)
          sleepStarted.resolve(millis)
        }).pipe(Effect.andThen(wakeNotifier.awaitWake(millis))),
    }

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })

      const running = runWithPorts(
        runWatchDaemon(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            maxCycles: 2,
            wakeNotifier: instrumentedWakeNotifier,
          }),
        ),
        { gateway: gateway.gateway, body: ports.body, workspace: ports.workspace },
      )

      await expect(
        withFailsafe(sleepStarted.promise, 'daemon did not enter wake wait'),
      ).resolves.toBe(5_000)
      storeFixture.store.enqueueSignal({
        rootId: testIds.rootId,
        signalId: signalIdA,
        provider: signalProvider,
        externalId: signalExternalIdA,
      })
      instrumentedWakeNotifier.wake()

      const result = await withFailsafe(running, 'daemon did not wake after signal notification')

      expect(result).toMatchObject({ cycles: 2, completed: 2, cancelled: false })
      expect(observedWaits).toEqual([5_000])
      expect(storeFixture.store.readSignalStatus(testIds.rootId)).toEqual({
        pending: 0,
        claimed: 0,
        processed: 1,
        failed: 0,
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('records retry repair state, honors backoff, and continues after a cycle failure', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const ports = makeHarnessPorts()
    const statePath = `${storeFixture.path}.watch.json`
    const sleeps: number[] = []
    let retrieveAttempts = 0
    const flakyGateway = {
      ...gateway.gateway,
      retrieveDataSource: (
        dataSourceId: Parameters<typeof gateway.gateway.retrieveDataSource>[0],
      ) =>
        retrieveAttempts === 0
          ? Effect.sync(() => {
              retrieveAttempts += 1
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  makeGatewayError({
                    operation: 'retrieveDataSource',
                    dataSourceId,
                    message: 'temporary retrieve failure',
                  }),
                ),
              ),
            )
          : gateway.gateway.retrieveDataSource(dataSourceId),
    }

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })

      const result = await runWithPorts(
        runWatchDaemon(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            maxCycles: 2,
            sleep: (millis) =>
              Effect.sync(() => {
                sleeps.push(millis)
              }),
          }),
        ),
        { gateway: flakyGateway, body: ports.body, workspace: ports.workspace },
      )

      expect(result).toMatchObject({
        cycles: 2,
        completed: 1,
        cancelled: false,
        state: { repair: { _tag: 'none' } },
      })
      expect(sleeps).toEqual([5_000])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('uses gateway-provided retry-after when a cycle fails with a rate-limited error', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const ports = makeHarnessPorts()
    const statePath = `${storeFixture.path}.watch.json`
    const sleeps: number[] = []
    const retryAfterMillis = 2_500
    let retrieveAttempts = 0
    const retryingGateway = {
      ...gateway.gateway,
      retrieveDataSource: (
        dataSourceId: Parameters<typeof gateway.gateway.retrieveDataSource>[0],
      ) =>
        retrieveAttempts === 0
          ? Effect.sync(() => {
              retrieveAttempts += 1
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  makeGatewayError({
                    operation: 'retrieveDataSource',
                    dataSourceId,
                    message: 'rate limited during sync',
                    retryAfterMillis,
                  }),
                ),
              ),
            )
          : gateway.gateway.retrieveDataSource(dataSourceId),
    }

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })

      const result = await runWithPorts(
        runWatchDaemon(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            maxCycles: 2,
            sleep: (millis) =>
              Effect.sync(() => {
                sleeps.push(millis)
              }),
          }),
        ),
        { gateway: retryingGateway, body: ports.body, workspace: ports.workspace },
      )

      expect(result).toMatchObject({
        cycles: 2,
        completed: 1,
        cancelled: false,
        state: { repair: { _tag: 'none' } },
      })
      expect(sleeps).toEqual([retryAfterMillis])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('clears retry repair state after a completed but blocked cycle', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const ports = makeHarnessPorts()
    const statePath = `${storeFixture.path}.watch.json`
    const blockedGatewayHarness = makeFakeGatewayHarness({
      capabilities: allGatewayCapabilities.filter(
        (capability) => capability !== 'page_property_paginate',
      ),
      propertyPages: [propertyPage()],
    })

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      await writeFile(
        statePath,
        `${JSON.stringify(
          {
            version: 1,
            rootId: testIds.rootId,
            cycle: 7,
            lastCompleteCycle: 7,
            lastStartedAt: clock.nowIso(),
            lastCompletedAt: clock.nowIso(),
            repair: {
              _tag: 'retry',
              reason: 'previous-cycle-did-not-complete',
              retryAfterMillis: 0,
              failedCycle: 6,
            },
            lastStatus: readOneShotSyncStatus({
              store: storeFixture.store,
              rootId: testIds.rootId,
            }),
          },
          null,
          2,
        )}\n`,
        'utf8',
      )

      const result = await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
          }),
        ),
        { gateway: blockedGatewayHarness.gateway, body: ports.body, workspace: ports.workspace },
      )

      expect(result).toMatchObject({
        cycle: 8,
        status: { state: 'blocked' },
        state: {
          repair: { _tag: 'none' },
          lastStatus: { state: 'blocked' },
        },
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('records retry repair state when an in-progress cycle times out', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const ports = makeHarnessPorts()
    const statePath = `${storeFixture.path}.watch.json`
    const hangingGateway = {
      ...gateway.gateway,
      retrieveDataSource: () => Effect.never,
    }

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })

      const firstCycle = await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
          }),
        ),
        { gateway: gateway.gateway, body: ports.body, workspace: ports.workspace },
      )

      expect(firstCycle).toMatchObject({
        cycle: 1,
        state: {
          lastCompleteCycle: 1,
          repair: { _tag: 'none' },
        },
      })

      await expect(
        withFailsafe(
          runWithPorts(
            runWatchDaemonCycle(
              daemonOptions({
                store: storeFixture.store,
                statePath,
                clock,
                cycleTimeoutMs: 1,
              }),
            ),
            { gateway: hangingGateway, body: ports.body, workspace: ports.workspace },
          ),
          'watch daemon timeout test did not finish',
        ),
      ).rejects.toThrow('Watch daemon cycle 2 timed out after 1ms')

      const state = await Effect.runPromise(
        readWatchDaemonState({ rootId: testIds.rootId, statePath }),
      )
      expect(state).toMatchObject({
        cycle: 2,
        lastCompleteCycle: 1,
        repair: {
          _tag: 'retry',
          reason: 'WatchDaemonCycleTimedOut',
          failedCycle: 2,
        },
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('uses process-unique default lease tokens across overlapping watcher attempts', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const statePath = `${storeFixture.path}.watch.json`
    const baseBody = makeFakePageBodySyncPort({ pages: [bodyPage()] })
    const failingBody = {
      ...baseBody,
      push: (command: Parameters<typeof baseBody.push>[0]) =>
        Effect.fail(
          new BodySyncError({
            operation: 'push',
            pageId: command.pageId,
            message: 'temporary body push failure',
          }),
        ),
    }
    const workspace = makeHarnessPorts({ localObservations: [localBodyChange()] }).workspace

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      await runWithPorts(
        pullOneShotSync({
          ...context({ store: storeFixture.store, clock, schemaProperties: [] }),
          store: storeFixture.store,
        }),
        { gateway: gateway.gateway, body: baseBody, workspace: makeHarnessPorts().workspace },
      )
      await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            maxExecutorSteps: 0,
            schemaProperties: [],
          }),
        ),
        { gateway: gateway.gateway, body: baseBody, workspace },
      )

      await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            maxExecutorSteps: 1,
            useDefaultLease: true,
          }),
        ),
        { gateway: gateway.gateway, body: failingBody, workspace },
      )
      const staleLeaseToken = storeFixture.store.readOutbox(testIds.rootId)[0]?.leaseToken

      await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            maxExecutorSteps: 1,
            useDefaultLease: true,
          }),
        ),
        { gateway: gateway.gateway, body: failingBody, workspace },
      )
      const currentLeaseToken = storeFixture.store.readOutbox(testIds.rootId)[0]?.leaseToken

      expect(staleLeaseToken).toMatch(/^watch:root-1:/)
      expect(currentLeaseToken).toMatch(/^watch:root-1:/)
      expect(currentLeaseToken).not.toBe(staleLeaseToken)
    } finally {
      storeFixture.cleanup()
    }
  })

  it('processes a local body change once across restart and cancellation', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const statePath = `${storeFixture.path}.watch.json`
    let bodyPushes = 0
    const baseBody = makeFakePageBodySyncPort({ pages: [bodyPage()] })
    const body = {
      ...baseBody,
      push: (command: Parameters<typeof baseBody.push>[0]) =>
        Effect.sync(() => {
          bodyPushes += 1
        }).pipe(Effect.andThen(baseBody.push(command))),
    }
    const workspace = makeHarnessPorts({ localObservations: [localBodyChange()] }).workspace

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      await runWithPorts(
        pullOneShotSync({
          ...context({ store: storeFixture.store, clock, schemaProperties: [] }),
          store: storeFixture.store,
        }),
        { gateway: gateway.gateway, body, workspace: makeHarnessPorts().workspace },
      )

      const pending = await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            maxExecutorSteps: 0,
            schemaProperties: [],
          }),
        ),
        { gateway: gateway.gateway, body, workspace },
      )
      expect(pending.status.state).toBe('pending')
      expect(bodyPushes).toBe(0)

      const controller = new AbortController()
      controller.abort()
      const cancelled = await runWithPorts(
        runWatchDaemon(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            signal: controller.signal,
          }),
        ),
        { gateway: gateway.gateway, body, workspace },
      )
      expect(cancelled.cancelled).toBe(true)
      expect(storeFixture.store.readOutbox(testIds.rootId)).toMatchObject([{ state: 'queued' }])

      const restarted = await runWithPorts(
        runWatchDaemonCycle(daemonOptions({ store: storeFixture.store, statePath, clock })),
        { gateway: gateway.gateway, body, workspace },
      )
      expect(restarted.status.state).toBe('clean')
      expect(bodyPushes).toBe(1)

      const repeated = await runWithPorts(
        runWatchDaemonCycle(daemonOptions({ store: storeFixture.store, statePath, clock })),
        { gateway: gateway.gateway, body, workspace },
      )
      expect(repeated.status.state).toBe('clean')
      expect(bodyPushes).toBe(1)

      const state = await Effect.runPromise(
        readWatchDaemonState({ rootId: testIds.rootId, statePath }),
      )
      expect(state.lastCompleteCycle).toBe(3)
      expect(state.repair).toEqual({ _tag: 'none' })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('converges repeated fake soak cycles after restart without duplicate body writes', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const statePath = `${storeFixture.path}.watch.json`
    let bodyPushes = 0
    const baseBody = makeFakePageBodySyncPort({ pages: [bodyPage()] })
    const body = {
      ...baseBody,
      push: (command: Parameters<typeof baseBody.push>[0]) =>
        Effect.sync(() => {
          bodyPushes += 1
        }).pipe(Effect.andThen(baseBody.push(command))),
    }
    const workspace = makeHarnessPorts({ localObservations: [localBodyChange()] }).workspace

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      await runWithPorts(
        pullOneShotSync({
          ...context({ store: storeFixture.store, clock }),
          store: storeFixture.store,
        }),
        { gateway: gateway.gateway, body, workspace: makeHarnessPorts().workspace },
      )

      const first = await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            maxExecutorSteps: 0,
          }),
        ),
        { gateway: gateway.gateway, body, workspace },
      )
      expect(first.status.state).toBe('pending')
      expect(bodyPushes).toBe(0)

      const soak = await runWithPorts(
        runWatchDaemon(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            maxCycles: 3,
            schemaProperties: [],
            sleep: () => Effect.sync(() => clock.advanceMillis(5_000)),
          }),
        ),
        { gateway: gateway.gateway, body, workspace },
      )

      expect(soak).toMatchObject({
        cycles: 3,
        completed: 3,
        cancelled: false,
        state: {
          lastCompleteCycle: 4,
          repair: { _tag: 'none' },
        },
      })
      expect(bodyPushes).toBe(1)
      expect(storeFixture.store.readOutbox(testIds.rootId)).toEqual([
        expect.objectContaining({ state: 'settled' }),
      ])
      expect(storeFixture.store.readStatusProjection(testIds.rootId).outbox).toMatchObject({
        queued: 0,
        running: 0,
        retryable: 0,
        ambiguous: 0,
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('converges a bounded mixed-mutation daemon soak with low-cardinality trace metadata', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const statePath = `${storeFixture.path}.watch.json`
    const addedPageId = decode({ schema: PageId, value: 'page-soak-2' })
    const queryContract = {
      ...defaultQueryContract(),
      pageSize: 1,
      highWatermark: decode({
        schema: Schema.DateTimeUtcFromString,
        value: '2026-05-24T23:59:00.000Z',
      }),
    }
    const baselineGateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const soakGateway = makeFakeGatewayHarness({
      pages: [
        pageSnapshot({ propertiesHash: hash('properties-remote-cycle') }),
        pageSnapshot({
          pageId: addedPageId,
          propertiesHash: hash('properties-added-cycle'),
        }),
      ],
      propertyPages: [
        propertyPage({ itemHash: hash('property-remote-cycle') }),
        propertyPage({ pageId: addedPageId, itemHash: hash('property-added-cycle') }),
      ],
    })
    const baseBody = makeFakePageBodySyncPort({
      pages: [
        bodyPage(),
        bodyPage({
          pageId: addedPageId,
          bodyHash: hash('body-added-cycle'),
        }),
      ],
    })
    let bodyPushes = 0
    const body = {
      ...baseBody,
      push: (command: Parameters<typeof baseBody.push>[0]) =>
        Effect.sync(() => {
          bodyPushes += 1
        }).pipe(Effect.andThen(baseBody.push(command))),
    }
    const workspace = makeHarnessPorts({
      localObservations: [localBodyChange({ contentHash: hash('body-local-soak') })],
    }).workspace
    const trace = makeDaemonRecordingTracer()

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      await runWithPorts(
        pullOneShotSync({
          ...context({ store: storeFixture.store, clock, schemaProperties: [] }),
          store: storeFixture.store,
        }),
        {
          gateway: baselineGateway.gateway,
          body,
          workspace: makeHarnessPorts().workspace,
        },
      )

      const interrupted = await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            queryContract,
            maxExecutorSteps: 0,
            schemaProperties: [],
          }),
        ),
        { gateway: soakGateway.gateway, body, workspace },
      )

      expect(interrupted.status.state).toBe('pending')
      expect(bodyPushes).toBe(0)
      expect(interrupted.sync.pull.observation.query).toMatchObject({
        rows: 2,
        complete: true,
      })

      const soak = await Effect.runPromise(
        runWatchDaemon(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            queryContract,
            maxCycles: 3,
            schemaProperties: [],
            sleep: () => Effect.sync(() => clock.advanceMillis(5_000)),
          }),
        ).pipe(
          Effect.provideService(NotionDataSourceGateway, soakGateway.gateway),
          Effect.provideService(PageBodySyncPort, body),
          Effect.provideService(LocalWorkspacePort, workspace),
          Effect.withTracer(trace.tracer),
        ),
      )

      expect(soak).toMatchObject({
        cycles: 3,
        completed: 3,
        cancelled: false,
        lastStatus: { state: 'clean' },
        state: {
          cycle: 4,
          lastCompleteCycle: 4,
          repair: { _tag: 'none' },
        },
      })
      expect(bodyPushes).toBe(1)
      expect(storeFixture.store.readOutbox(testIds.rootId)).toEqual([
        expect.objectContaining({ state: 'settled' }),
      ])
      expect(storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId).rows).toMatchObject([
        { pageId: testIds.pageId },
        { pageId: addedPageId },
      ])
      expect(readQueryCheckpointRows(storeFixture.path)).toEqual(
        expect.arrayContaining([
          {
            data_source_id: testIds.dataSourceId,
            query_contract_hash: interrupted.sync.pull.observation.query.queryContractHash,
            next_cursor: null,
            complete: 1,
            capped_at_limit: 0,
            contract_changed: 0,
            high_watermark: fixedObservedAt,
          },
        ]),
      )

      const daemonPassSpans = trace.spans.filter((span) => span.name === spanNames.daemonPass)
      expect(daemonPassSpans).toHaveLength(3)
      expect(daemonPassSpans.map((span) => span.attributes[spanAttr.spanLabel])).toEqual([
        'cycle:2',
        'cycle:3',
        'cycle:4',
      ])
      expect(
        new Set(
          trace.spans
            .map((span) => span.attributes[spanAttr.pageId])
            .filter((pageId): pageId is string => typeof pageId === 'string'),
        ).size,
      ).toBeLessThanOrEqual(2)
      for (const span of trace.spans.filter((candidate) => candidate.name.startsWith('notion.'))) {
        expect(span.ended, `${span.name} should be ended`).toBe(true)
        expect(span.attributes[spanAttr.spanLabel], `${span.name} span.label`).toEqual(
          expect.any(String),
        )
        expect(String(span.attributes[spanAttr.spanLabel]).length).toBeLessThanOrEqual(39)
      }
    } finally {
      storeFixture.cleanup()
    }
  })

  it('drains fake cursor pages without skipping same-timestamp rows', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const queryContract = { ...defaultQueryContract(), pageSize: 1 }
    const thirdPageId = decode({ schema: PageId, value: 'page-3' })
    const gateway = makeFakeGatewayHarness({
      pages: [
        pageSnapshot({ pageId: testIds.pageId }),
        pageSnapshot({
          pageId: testIds.otherPageId,
          propertiesHash: hash('properties-b'),
        }),
        pageSnapshot({
          pageId: thirdPageId,
          propertiesHash: hash('properties-c'),
        }),
      ],
      propertyPages: [
        propertyPage(),
        propertyPage({ pageId: testIds.otherPageId, itemHash: hash('property-b-base') }),
        propertyPage({ pageId: thirdPageId, itemHash: hash('property-c-base') }),
      ],
    })
    const ports = makeHarnessPorts({
      bodyPages: [
        bodyPage(),
        bodyPage({ pageId: testIds.otherPageId, bodyHash: hash('body-b') }),
        bodyPage({ pageId: thirdPageId, bodyHash: hash('body-c') }),
      ],
    })
    const statePath = `${storeFixture.path}.watch.json`

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })

      const result = await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            queryContract,
          }),
        ),
        { gateway: gateway.gateway, body: ports.body, workspace: ports.workspace },
      )

      expect(result.sync.pull.observation.query).toMatchObject({
        pages: 3,
        rows: 3,
        complete: true,
      })
      const projectedRows = storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId).rows
      expect(projectedRows.map((row) => row.pageId)).toEqual([
        testIds.pageId,
        testIds.otherPageId,
        thirdPageId,
      ])
      expect(new Set(projectedRows.map((row) => row.propertiesHash)).size).toBe(3)
    } finally {
      storeFixture.cleanup()
    }
  })

  it('persists capped incomplete query checkpoint evidence when the fake cap has no resume cursor', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({
      queryResultCap: 1,
      pages: [
        pageSnapshot({ pageId: testIds.pageId }),
        pageSnapshot({
          pageId: testIds.otherPageId,
          propertiesHash: hash('properties-b'),
        }),
      ],
      propertyPages: [propertyPage()],
    })
    const ports = makeHarnessPorts()
    const statePath = `${storeFixture.path}.watch.json`

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })

      const result = await runWithPorts(
        runWatchDaemonCycle(daemonOptions({ store: storeFixture.store, statePath, clock })),
        { gateway: gateway.gateway, body: ports.body, workspace: ports.workspace },
      )

      expect(result.sync.pull.observation.query).toMatchObject({
        pages: 1,
        rows: 1,
        complete: false,
        cappedAtLimit: true,
      })
      expect(result.status).toMatchObject({
        state: 'blocked',
        counts: {
          checkpoints: {
            incompleteQueries: 1,
            cappedQueries: 1,
          },
        },
      })
      expect(result.state).toMatchObject({
        lastCompleteCycle: 1,
        repair: { _tag: 'none' },
      })
      expect(readQueryCheckpointRows(storeFixture.path)).toEqual([
        {
          data_source_id: testIds.dataSourceId,
          query_contract_hash: result.sync.pull.observation.query.queryContractHash,
          next_cursor: null,
          complete: 0,
          capped_at_limit: 1,
          contract_changed: 0,
          high_watermark: null,
        },
      ])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('resumes an interrupted high-watermark query from the persisted cursor', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const queryContract = {
      ...defaultQueryContract(),
      pageSize: 1,
      highWatermark: decode({
        schema: Schema.DateTimeUtcFromString,
        value: '2026-05-24T23:59:00.000Z',
      }),
    }
    const thirdPageId = decode({ schema: PageId, value: 'page-3' })
    const pages = [
      pageSnapshot({ pageId: testIds.pageId }),
      pageSnapshot({
        pageId: testIds.otherPageId,
        propertiesHash: hash('properties-b'),
      }),
      pageSnapshot({
        pageId: thirdPageId,
        propertiesHash: hash('properties-c'),
      }),
    ]
    const propertyPages = [
      propertyPage(),
      propertyPage({ pageId: testIds.otherPageId, itemHash: hash('property-b-base') }),
      propertyPage({ pageId: thirdPageId, itemHash: hash('property-c-base') }),
    ]
    const ports = makeHarnessPorts({
      bodyPages: [
        bodyPage(),
        bodyPage({ pageId: testIds.otherPageId, bodyHash: hash('body-b') }),
        bodyPage({ pageId: thirdPageId, bodyHash: hash('body-c') }),
      ],
    })
    const statePath = `${storeFixture.path}.watch.json`

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })

      const first = await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            queryContract,
          }),
        ),
        {
          gateway: makeFakeGatewayHarness({
            pages,
            propertyPages,
            queryPageLimit: 1,
          }).gateway,
          body: ports.body,
          workspace: ports.workspace,
        },
      )

      expect(first.sync.pull.observation.query).toMatchObject({
        startCursor: null,
        pages: 1,
        rows: 1,
        complete: false,
      })
      expect(readQueryCheckpointRows(storeFixture.path)).toEqual([
        {
          data_source_id: testIds.dataSourceId,
          query_contract_hash: first.sync.pull.observation.query.queryContractHash,
          next_cursor: 'offset:1',
          complete: 0,
          capped_at_limit: 0,
          contract_changed: 0,
          high_watermark: '2026-05-24T23:59:00.000Z',
        },
      ])

      const resumedStartCursors: Array<string | null> = []
      const resumedGatewayHarness = makeFakeGatewayHarness({ pages, propertyPages })
      const resumedGateway = {
        ...resumedGatewayHarness.gateway,
        queryRows: (input: Parameters<typeof resumedGatewayHarness.gateway.queryRows>[0]) => {
          resumedStartCursors.push(input.startCursor)
          return resumedGatewayHarness.gateway.queryRows(input)
        },
      }
      const second = await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            queryContract,
          }),
        ),
        {
          gateway: resumedGateway,
          body: ports.body,
          workspace: ports.workspace,
        },
      )

      expect(resumedStartCursors).toEqual(['offset:1'])
      expect(second.sync.pull.observation.query).toMatchObject({
        startCursor: 'offset:1',
        pages: 2,
        rows: 2,
        complete: true,
      })
      expect(storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId).rows).toMatchObject([
        { pageId: testIds.pageId },
        { pageId: testIds.otherPageId },
        { pageId: thirdPageId },
      ])
      expect(readQueryCheckpointRows(storeFixture.path)).toEqual([
        {
          data_source_id: testIds.dataSourceId,
          query_contract_hash: first.sync.pull.observation.query.queryContractHash,
          next_cursor: null,
          complete: 1,
          capped_at_limit: 0,
          contract_changed: 0,
          high_watermark: fixedObservedAt,
        },
      ])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('uses the completed checkpoint watermark for steady-state watch polling', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const statePath = `${storeFixture.path}.watch.json`
    const ports = makeHarnessPorts()
    const observedWatermarks: Array<string | null> = []

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })

      await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            schemaProperties: [],
          }),
        ),
        {
          gateway: makeFakeGatewayHarness({ propertyPages: [propertyPage()] }).gateway,
          body: ports.body,
          workspace: ports.workspace,
        },
      )
      expect(readQueryCheckpointRows(storeFixture.path)).toEqual([
        expect.objectContaining({
          complete: 1,
          capped_at_limit: 0,
          high_watermark: fixedObservedAt,
        }),
      ])

      const gatewayHarness = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
      const gateway = {
        ...gatewayHarness.gateway,
        queryRows: (input: Parameters<typeof gatewayHarness.gateway.queryRows>[0]) => {
          observedWatermarks.push(
            input.queryContract.highWatermark === null
              ? null
              : Schema.encodeSync(Schema.DateTimeUtcFromString)(input.queryContract.highWatermark),
          )
          return gatewayHarness.gateway.queryRows(input)
        },
      }
      await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            schemaProperties: [],
          }),
        ),
        { gateway, body: ports.body, workspace: ports.workspace },
      )

      expect(observedWatermarks).toEqual([fixedObservedAt])
      expect(storeFixture.store.readStatusProjection(testIds.rootId).tombstones).toMatchObject({
        unclassified: 0,
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('does not classify absence from incremental watch polling as a tombstone candidate', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const statePath = `${storeFixture.path}.watch.json`
    const ports = makeHarnessPorts()
    const body = makeFakePageBodySyncPort({
      pages: [
        bodyPage(),
        bodyPage({ pageId: testIds.otherPageId, bodyHash: hash('body-other-page') }),
      ],
    })
    const pageA = pageSnapshot({ pageId: testIds.pageId })
    const pageB = pageSnapshot({
      pageId: testIds.otherPageId,
      propertiesHash: hash('properties-other-page'),
    })
    const gatewayHarness = makeFakeGatewayHarness({
      pages: [pageA, pageB],
      propertyPages: [
        propertyPage({ pageId: testIds.pageId }),
        propertyPage({ pageId: testIds.otherPageId, itemHash: hash('property-other-page') }),
      ],
    })
    const incrementalGateway = {
      ...gatewayHarness.gateway,
      queryRows: (input: Parameters<typeof gatewayHarness.gateway.queryRows>[0]) =>
        gatewayHarness.gateway.queryRows(input).pipe(
          Stream.map((page) =>
            input.queryContract.highWatermark === null
              ? page
              : Object.assign({}, page, {
                  rows: page.rows.filter((row) => row.pageId !== testIds.otherPageId),
                }),
          ),
        ),
    }

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })

      await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            schemaProperties: [],
          }),
        ),
        { gateway: gatewayHarness.gateway, body, workspace: ports.workspace },
      )
      expect(storeFixture.store.readStatusProjection(testIds.rootId).projections.rows).toBe(2)

      await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            schemaProperties: [],
          }),
        ),
        { gateway: incrementalGateway, body, workspace: ports.workspace },
      )

      const status = storeFixture.store.readStatusProjection(testIds.rootId)
      expect(status.projections.rows).toBe(2)
      expect(status.tombstones).toMatchObject({
        unclassified: 0,
      })
      expect(storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId).tombstones).toEqual(
        [],
      )
    } finally {
      storeFixture.cleanup()
    }
  })

  it('bounds outbox execution per cycle and leaves queued work for backpressure recovery', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({
      pages: [
        pageSnapshot({ pageId: testIds.pageId }),
        pageSnapshot({
          pageId: testIds.otherPageId,
          propertiesHash: hash('properties-b'),
        }),
      ],
      propertyPages: [
        propertyPage(),
        propertyPage({ pageId: testIds.otherPageId, itemHash: hash('property-b-base') }),
      ],
    })
    const baseBody = makeFakePageBodySyncPort({
      pages: [bodyPage(), bodyPage({ pageId: testIds.otherPageId, bodyHash: hash('body-b') })],
    })
    let bodyPushes = 0
    const body = {
      ...baseBody,
      push: (command: Parameters<typeof baseBody.push>[0]) =>
        Effect.sync(() => {
          bodyPushes += 1
        }).pipe(Effect.andThen(baseBody.push(command))),
    }
    const statePath = `${storeFixture.path}.watch.json`

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      await runWithPorts(
        pullOneShotSync({
          ...context({ store: storeFixture.store, clock, schemaProperties: [] }),
          store: storeFixture.store,
        }),
        { gateway: gateway.gateway, body, workspace: makeHarnessPorts().workspace },
      )

      const workspace = makeHarnessPorts({
        localObservations: [
          localBodyChange(),
          localBodyChange({
            pageId: testIds.otherPageId,
            path: decode({ schema: WorkspaceRelativePath, value: 'row--page-2.nmd' }),
            contentHash: hash('body-local-2'),
          }),
        ],
      }).workspace
      const result = await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            maxExecutorSteps: 1,
            schemaProperties: [],
          }),
        ),
        { gateway: gateway.gateway, body, workspace },
      )

      expect(bodyPushes).toBe(1)
      expect(result.sync.push.executor).toMatchObject({
        steps: 1,
        maxStepsReached: true,
      })
      expect(result.status).toMatchObject({
        state: 'pending',
        counts: { outbox: { queued: 1, settled: 1 } },
      })
      expect(storeFixture.store.readOutbox(testIds.rootId).map((row) => row.state)).toEqual([
        'settled',
        'queued',
      ])

      const drained = await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            maxExecutorSteps: 1,
            schemaProperties: [],
          }),
        ),
        { gateway: gateway.gateway, body, workspace },
      )

      expect(bodyPushes).toBe(2)
      expect(drained.sync.push.executor).toMatchObject({
        steps: 1,
        maxStepsReached: false,
      })
      expect(drained.status).toMatchObject({
        state: 'clean',
        counts: { outbox: { queued: 0, settled: 2 } },
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('lets a second daemon settle an expired running command as a verified no-op', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const baseBody = makeFakePageBodySyncPort({ pages: [bodyPage()] })
    const statePath = `${storeFixture.path}.watch.json`

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      await runWithPorts(
        pullOneShotSync({
          ...context({ store: storeFixture.store, clock }),
          store: storeFixture.store,
        }),
        { gateway: gateway.gateway, body: baseBody, workspace: makeHarnessPorts().workspace },
      )
      await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            maxExecutorSteps: 0,
          }),
        ),
        {
          gateway: gateway.gateway,
          body: baseBody,
          workspace: makeHarnessPorts({ localObservations: [localBodyChange()] }).workspace,
        },
      )

      const oldClaim = storeFixture.store.claimNextOutboxCommand({
        rootId: testIds.rootId,
        leaseToken: 'daemon-a',
        leaseDurationMs: 60_000,
      })
      expect(oldClaim).toMatchObject({ leaseToken: 'daemon-a', attemptState: 'running' })
      clock.advanceMillis(60_001)

      const alreadyWrittenBody = makeFakePageBodySyncPort({
        pages: [bodyPage({ bodyHash: hash('body-local') })],
      })
      const result = await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            leaseToken: 'daemon-b',
            leaseDurationMs: -1,
            maxExecutorSteps: 1,
          }),
        ),
        {
          gateway: gateway.gateway,
          body: alreadyWrittenBody,
          workspace: makeHarnessPorts({ localObservations: [localBodyChange()] }).workspace,
        },
      )

      expect(result.sync.push.executor.results).toEqual([
        expect.objectContaining({
          _tag: 'settled',
          settlementKind: 'verified-no-op',
        }),
      ])
      expect(storeFixture.store.readOutbox(testIds.rootId)).toEqual([
        expect.objectContaining({
          state: 'settled',
          leaseToken: undefined,
          settlementEventId: expect.any(String),
        }),
      ])
      expect(
        storeFixture.store.isOutboxLeaseActive({
          rootId: testIds.rootId,
          commandId: oldClaim!.commandId,
          leaseToken: oldClaim!.leaseToken,
        }),
      ).toBe(false)
    } finally {
      storeFixture.cleanup()
    }
  })

  it('settles the current outbox attempt before honoring cancellation at the cycle boundary', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const baseBody = makeFakePageBodySyncPort({ pages: [bodyPage()] })
    const statePath = `${storeFixture.path}.watch.json`
    const controller = new AbortController()
    let bodyPushes = 0

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      await runWithPorts(
        pullOneShotSync({
          ...context({ store: storeFixture.store, clock }),
          store: storeFixture.store,
        }),
        { gateway: gateway.gateway, body: baseBody, workspace: makeHarnessPorts().workspace },
      )
      const body = {
        ...baseBody,
        push: (command: Parameters<typeof baseBody.push>[0]) =>
          Effect.sync(() => {
            bodyPushes += 1
            controller.abort()
          }).pipe(Effect.andThen(baseBody.push(command))),
      }

      const result = await runWithPorts(
        runWatchDaemon(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            signal: controller.signal,
          }),
        ),
        {
          gateway: gateway.gateway,
          body,
          workspace: makeHarnessPorts({ localObservations: [localBodyChange()] }).workspace,
        },
      )
      const persisted = await Effect.runPromise(
        readWatchDaemonState({ rootId: testIds.rootId, statePath }),
      )

      expect(result).toMatchObject({
        cycles: 1,
        completed: 0,
        cancelled: true,
      })
      expect(persisted).toMatchObject({
        cycle: 1,
        lastCompleteCycle: 0,
        lastStartedAt: fixedObservedAt,
      })
      expect(persisted.lastCompletedAt).toBeUndefined()
      expect(bodyPushes).toBe(1)
      expect(storeFixture.store.readOutbox(testIds.rootId)).toEqual([
        expect.objectContaining({ state: 'settled' }),
      ])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('interrupts an in-flight body push when the daemon is cancelled mid-cycle', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const baseBody = makeFakePageBodySyncPort({ pages: [bodyPage()] })
    const statePath = `${storeFixture.path}.watch.json`
    const controller = new AbortController()
    const inFlight = makeDeferred()
    const interrupted = makeDeferred()

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      await runWithPorts(
        pullOneShotSync({
          ...context({ store: storeFixture.store, clock }),
          store: storeFixture.store,
        }),
        { gateway: gateway.gateway, body: baseBody, workspace: makeHarnessPorts().workspace },
      )
      const body = {
        ...baseBody,
        push: (_command: Parameters<typeof baseBody.push>[0]) =>
          Effect.sync(() => inFlight.resolve()).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(() => interrupted.resolve())),
          ),
      }
      const program = runWatchDaemon(
        daemonOptions({
          store: storeFixture.store,
          statePath,
          clock,
          signal: controller.signal,
        }),
      ).pipe(
        Effect.provideService(NotionDataSourceGateway, gateway.gateway),
        Effect.provideService(PageBodySyncPort, body),
        Effect.provideService(
          LocalWorkspacePort,
          makeHarnessPorts({ localObservations: [localBodyChange()] }).workspace,
        ),
      )

      const fiber = Effect.runFork(program)
      await withFailsafe(inFlight.promise, 'body push did not start')
      controller.abort()
      await withFailsafe(interrupted.promise, 'body push was not interrupted')
      const result = await withFailsafe(Effect.runPromise(Fiber.join(fiber)), 'daemon did not stop')
      const persisted = await Effect.runPromise(
        readWatchDaemonState({ rootId: testIds.rootId, statePath }),
      )

      expect(result).toMatchObject({
        cycles: 1,
        completed: 0,
        cancelled: true,
      })
      expect(persisted).toMatchObject({
        cycle: 1,
        lastCompleteCycle: 0,
        repair: {
          _tag: 'retry',
          reason: 'WatchDaemonCancelled',
          failedCycle: 1,
        },
      })
      expect(storeFixture.store.readOutbox(testIds.rootId)).toEqual([
        expect.objectContaining({
          state: 'running',
          attemptCount: 1,
          settlementEventId: undefined,
        }),
      ])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('suppresses own materialization writes through the daemon on a real temp filesystem', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const fixture = await makeTempWorkspace()
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const baseBody = makeFakePageBodySyncPort({ pages: [bodyPage()] })
    const workspace = makeFilesystemLocalWorkspacePort({ root: fixture.root })
    const statePath = `${storeFixture.path}.watch.json`
    let bodyPushes = 0
    const countingBody = {
      ...baseBody,
      push: (command: Parameters<typeof baseBody.push>[0]) =>
        Effect.sync(() => {
          bodyPushes += 1
        }).pipe(Effect.andThen(baseBody.push(command))),
    }

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot: fixture.root,
        now: clock.now,
      })
      const first = await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            workspaceRoot: fixture.root,
          }),
        ),
        { gateway: gateway.gateway, body: baseBody, workspace },
      )
      const [ownWriteObservation] = await collectWorkspaceScan({ workspace, root: fixture.root })
      const materializeResult = first.sync.pull.observation.materialized[0]
      expect(materializeResult).toBeDefined()
      expect(ownWriteObservation).toMatchObject({
        pageId: testIds.pageId,
        contentHash: hash('body-a'),
        state: 'present',
        ownWriteSuppressionToken: materializeResult!.ownWriteSuppressionToken,
      })
      expect(
        isOwnWriteObservation({
          observation: ownWriteObservation!,
          token: materializeResult!.ownWriteSuppressionToken,
        }),
      ).toBe(true)

      const second = await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            workspaceRoot: fixture.root,
          }),
        ),
        { gateway: gateway.gateway, body: countingBody, workspace },
      )

      expect(second.status.state).toBe('clean')
      expect(bodyPushes).toBe(0)
    } finally {
      storeFixture.cleanup()
      await fixture.cleanup()
    }
  })

  it('captures an edited .nmd before daemon remote pull can materialize over it', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const fixture = await makeTempWorkspace()
    const statePath = `${storeFixture.path}.watch.json`
    const initialGateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const initialBody = makeFakePageBodySyncPort({ pages: [bodyPage()] })

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot: fixture.root,
        now: clock.now,
      })
      const initial = await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            workspaceRoot: fixture.root,
          }),
        ),
        {
          gateway: initialGateway.gateway,
          body: initialBody,
          workspace: makeFilesystemLocalWorkspacePort({ root: fixture.root }),
        },
      )
      const materialized = initial.sync.pull.observation.materialized[0]
      expect(materialized).toBeDefined()

      const localBodyContent = '# Local body edit before remote pull\n'
      const bodyPath = join(fixture.root, materialized!.path)
      await writeFile(bodyPath, localBodyContent, 'utf8')

      const calls: string[] = []
      const planInputs: Array<Parameters<typeof initialBody.planLocalChange>[0]> = []
      const baseWorkspace = makeFilesystemLocalWorkspacePort({ root: fixture.root })
      const workspace = {
        ...baseWorkspace,
        scan: (root: Parameters<typeof baseWorkspace.scan>[0]) => {
          calls.push('scan')
          return baseWorkspace.scan(root)
        },
        materialize: (plan: Parameters<typeof baseWorkspace.materialize>[0]) =>
          Effect.sync(() => {
            calls.push('materialize')
          }).pipe(Effect.andThen(baseWorkspace.materialize(plan))),
      }
      const remoteGateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
      const gateway = {
        ...remoteGateway.gateway,
        queryRows: (input: Parameters<typeof remoteGateway.gateway.queryRows>[0]) => {
          calls.push('query')
          return remoteGateway.gateway.queryRows(input)
        },
      }
      const remoteBody = makeFakePageBodySyncPort({
        pages: [bodyPage({ bodyHash: hash('body-remote-drift') })],
      })
      const body = {
        ...remoteBody,
        planLocalChange: (input: Parameters<typeof remoteBody.planLocalChange>[0]) =>
          Effect.sync(() => {
            calls.push('plan-local-body')
            planInputs.push(input)
          }).pipe(Effect.andThen(remoteBody.planLocalChange(input))),
      }

      const result = await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            workspaceRoot: fixture.root,
            schemaProperties: [],
          }),
        ),
        { gateway, body, workspace },
      )

      expect(calls).toEqual(['scan', 'plan-local-body', 'query'])
      expect(planInputs).toEqual([
        expect.objectContaining({
          pageId: testIds.pageId,
          localBodyPath: materialized!.path,
        }),
      ])
      expect(
        result.sync.push.plan.enqueuedCommands +
          result.sync.push.plan.conflicts +
          result.sync.push.plan.blocked,
      ).toBeGreaterThan(0)
      expect(await readFile(bodyPath, 'utf8')).toBe(localBodyContent)
    } finally {
      storeFixture.cleanup()
      await fixture.cleanup()
    }
  })

  it('doctor reports clean after a fake daemon scenario and blocked when guards are present', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const ports = makeHarnessPorts()

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      await runWithPorts(
        pullOneShotSync({
          ...context({ store: storeFixture.store, clock }),
          store: storeFixture.store,
        }),
        { gateway: gateway.gateway, body: ports.body, workspace: ports.workspace },
      )
      const clean = await runWithPorts(
        runCliCommand({ _tag: 'doctor' }, context({ store: storeFixture.store, clock })),
        { gateway: gateway.gateway, body: ports.body, workspace: ports.workspace },
      )
      expect(clean.result).toMatchObject({
        _tag: 'DoctorResult',
        clean: true,
        status: { state: 'clean' },
      })

      const blocked = await runWithPorts(
        runCliCommand(
          {
            _tag: 'conflicts-resolve',
            conflictId: decode({ schema: SyncEventId, value: 'missing-conflict' }),
            choice: { _tag: 'keep-local', value: { _tag: 'title', plainText: 'Local' } },
          },
          context({ store: storeFixture.store, clock }),
        ),
        { gateway: gateway.gateway, body: ports.body, workspace: ports.workspace },
      )
      expect(blocked.status.state).toBe('blocked')

      const doctor = await runWithPorts(
        runCliCommand({ _tag: 'doctor' }, context({ store: storeFixture.store, clock })),
        { gateway: gateway.gateway, body: ports.body, workspace: ports.workspace },
      )
      expect(doctor.result).toMatchObject({
        _tag: 'DoctorResult',
        clean: false,
        status: { state: 'blocked' },
        surface: { guards: [{ guard: expect.any(String) }] },
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  // SM7.3: wake+fresh-read invariant (NDS-L5-webhook-hint-fresh-read-coalesce)
  // A webhook signal hints only page-1; the daemon cycle must still pull ALL pages
  // from the gateway (including page-2) rather than scoping to the hint's pageId.
  // This is the structural guard against webhook-as-correctness-source (decision 0008).
  it('runs full syncOneShot when woken by a webhook hint, not scoped to the hinted page', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    // Two-page fixture: page-1 and page-2. Webhook only hints page-1.
    const gateway = makeFakeGatewayHarness({
      pages: [
        pageSnapshot({ pageId: testIds.pageId }),
        pageSnapshot({
          pageId: testIds.otherPageId,
          propertiesHash: hash('properties-b'),
        }),
      ],
      propertyPages: [
        propertyPage(),
        propertyPage({ pageId: testIds.otherPageId, itemHash: hash('property-b-base') }),
      ],
    })
    const ports = makeHarnessPorts({
      bodyPages: [fakeBodyPage(), fakeBodyPage({ pageId: testIds.otherPageId })],
    })
    const statePath = `${storeFixture.path}.watch.json`
    const webhookVerificationToken = 'test-webhook-token'
    const webhookSignalProvider = decode({ schema: SignalProvider, value: 'notion-webhook' })

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })

      // Enqueue a webhook signal that only references page-1
      const rawBody = JSON.stringify({
        id: 'webhook-evt-1',
        type: 'page.created',
        entity: { id: testIds.pageId, type: 'page' },
        data: { parent: { data_source_id: testIds.dataSourceId } },
      })
      handleNotionWebhookDelivery({
        rawBody,
        headers: {
          'x-notion-signature': computeNotionWebhookSignature({
            rawBody,
            verificationToken: webhookVerificationToken,
          }),
        },
        rootId: testIds.rootId,
        store: storeFixture.store,
        verificationToken: webhookVerificationToken,
      })
      expect(storeFixture.store.readSignalStatus(testIds.rootId)).toMatchObject({
        pending: 1,
      })
      const [enqueuedSignal] = storeFixture.store.readSignals(testIds.rootId)
      expect(enqueuedSignal?.provider).toBe(webhookSignalProvider)
      expect(enqueuedSignal?.pageId).toBe(testIds.pageId) // hint: page-1 only

      const result = await runWithPorts(
        runWatchDaemonCycle(daemonOptions({ store: storeFixture.store, statePath, clock })),
        { gateway: gateway.gateway, body: ports.body, workspace: ports.workspace },
      )

      // Signal is settled (processed), not pending
      expect(storeFixture.store.readSignalStatus(testIds.rootId)).toEqual({
        pending: 0,
        claimed: 0,
        processed: 1,
        failed: 0,
      })
      // The cycle ran a FULL query (both pages), not just the hinted page-1.
      // This is the structural guard: hint informs OTEL attribution, not pull scope.
      // `pages` = API pagination calls (1 call returned both rows); `rows` = Notion rows observed.
      expect(result.sync.pull.observation.query).toMatchObject({
        rows: 2,
        complete: true,
      })
      // Confirm page-2 (not in the webhook hint) is in the projected rows
      const projectedPageIds = storeFixture.store
        .readPlannerProjectionSnapshot(testIds.rootId)
        .rows.map((row) => row.pageId)
      expect(projectedPageIds).toContain(testIds.otherPageId)
    } finally {
      storeFixture.cleanup()
    }
  })

  // SM7.3: coalescing proof — N wake() calls during one in-flight cycle collapse to one extra cycle
  it('collapses multiple wake() calls into a single pending wake that fires on the next awaitWake', async () => {
    const notifier = makeWatchDaemonWakeNotifier()

    // N wake calls with no waiting fiber → each just sets pendingWake = true (idempotent)
    notifier.wake()
    notifier.wake()
    notifier.wake()

    // First awaitWake(>0) with pendingWake=true returns immediately (Effect.void, synchronous).
    // This consumes the single collapsed flag regardless of how many wake() calls were made.
    expect(Effect.runSync(notifier.awaitWake(5_000))).toBeUndefined()

    // Fork a second awaitWake — pendingWake is now false so it must register as a waiter and BLOCK.
    // This is the load-bearing assertion: it proves the 3 wakes collapsed to exactly one consumed flag.
    const fiber = Effect.runFork(notifier.awaitWake(5_000))
    // A blocked awaitWake never settles: racing its completion against a short
    // timeout fails with TimeoutError while the waiter stays registered.
    const early = await Effect.runPromiseExit(Fiber.await(fiber).pipe(Effect.timeout(20)))
    expect(early._tag === 'Failure').toBe(true) // still blocked — pendingWake was fully consumed above

    // A fresh single wake() unblocks the waiting fiber
    notifier.wake()
    expect(await Effect.runPromise(Fiber.join(fiber))).toBeUndefined()
  })

  // SM7.3: AbortSignal mid-cycle with a claimed webhook signal → signal released back to pending
  it('releases a claimed webhook signal when the cycle is aborted mid-flight', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const ports = makeHarnessPorts()
    const statePath = `${storeFixture.path}.watch.json`
    const controller = new AbortController()
    const webhookVerificationToken = 'abort-test-token'
    const inFlight = makeDeferred()

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })

      // Enqueue a webhook signal so the cycle claims it
      const rawBody = JSON.stringify({
        id: 'webhook-evt-abort',
        type: 'page.updated',
        entity: { id: testIds.pageId, type: 'page' },
        data: { parent: { data_source_id: testIds.dataSourceId } },
      })
      handleNotionWebhookDelivery({
        rawBody,
        headers: {
          'x-notion-signature': computeNotionWebhookSignature({
            rawBody,
            verificationToken: webhookVerificationToken,
          }),
        },
        rootId: testIds.rootId,
        store: storeFixture.store,
        verificationToken: webhookVerificationToken,
      })

      // Gateway that blocks mid-cycle so we can fire abort during the sync
      const blockingGateway = {
        ...makeFakeGatewayHarness().gateway,
        retrieveDataSource: () =>
          Effect.sync(() => inFlight.resolve()).pipe(Effect.andThen(Effect.never)),
      }

      const cycleEffect = runWatchDaemonCycle(
        daemonOptions({ store: storeFixture.store, statePath, clock, signal: controller.signal }),
      ).pipe(
        Effect.provideService(NotionDataSourceGateway, blockingGateway),
        Effect.provideService(PageBodySyncPort, ports.body),
        Effect.provideService(LocalWorkspacePort, ports.workspace),
      )

      const fiber = Effect.runFork(cycleEffect)
      await withFailsafe(inFlight.promise, 'gateway call did not start')
      controller.abort()

      const error = await Effect.runPromise(Fiber.join(fiber).pipe(Effect.flip))
      expect(error).toBeInstanceOf(WatchDaemonCancelled)

      // Signal was claimed during the cycle — must be released back to pending
      expect(storeFixture.store.readSignalStatus(testIds.rootId)).toEqual({
        pending: 1,
        claimed: 0,
        processed: 0,
        failed: 0,
      })
    } finally {
      storeFixture.cleanup()
    }
  })
})
