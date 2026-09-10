import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Effect, Layer, Option, Redacted, Schema, Stream } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { type HttpClient } from 'effect/unstable/http/HttpClient'
import { describe, expect, it } from 'vitest'

import {
  type NotionConfig,
  NotionConfigLive,
  NotionDataSources,
  NotionDatabases,
  NotionPages,
} from '@overeng/notion-effect-client'
import { NotionMdGateway, NotionMdGatewayLive } from '@overeng/notion-md'

import { makeNotionMdPageBodySyncPort } from '../body/notion-md.ts'
import { parseCliCommand, parseCliContext, runCliCommandWithRuntime } from '../cli/main.ts'
import { makeNotionApiContract, makeNotionDataSourceGatewayLayer } from '../gateway/gateway.ts'
import {
  makeNotionDataSourceGatewayFromClient,
  makeNotionEffectClientGatewayClient,
  makeThrottledProvideClientEnv,
  NotionDataSourceGatewayLive,
  type NotionGatewayClient,
} from '../gateway/notion.ts'
import { makeFilesystemLocalWorkspacePort } from '../local/workspace.ts'
import {
  AbsolutePath,
  canonicalHash,
  CommandId,
  DataSourceId,
  Hash,
  LocalWorkspacePort,
  NotionDataSourceGateway,
  type NotionDataSourceGatewayShape,
  PageBodySyncPort,
  PageId,
  PatchDataSourceMetadataCommand,
  PropertyId,
  PropertyName,
  SchemaPatchOperation,
  SyncRootId,
  WorkspaceRelativePath,
} from '../mod.ts'
import { projectReplicaFromSyncStore } from '../replica/replica.ts'
import { openNotionSyncStore } from '../store/store.ts'
import type { SchemaPropertyObservation } from '../sync/observation.ts'
import { establishFromNotion } from '../sync/sync.ts'
import { makeFakeGatewayHarness, testIds } from '../testing/harness.ts'
import {
  emptyLiveFixtureLedger,
  defaultLivePreflightCapabilities,
  ledgerEntry,
  LiveFixtureCleanupError,
  liveNotionConfigFromEnv,
  liveNotionEnvFromProcessEnv,
  makeLiveFixtureLedgerWriter,
  makeLiveNotionFixtureLifecycleClient,
  provisionLiveNotionDataSourceFixture,
  resumeLiveFixtureCleanupFromLedger,
  runLiveFixtureLifecycle,
  runLiveFixtureSoak,
  runLiveNotionDemoShowcase,
  runLiveNotionPreflight,
  strictLivePreflightCapabilities,
  type LiveFixtureLedger,
  type LiveFixtureLifecycleClient,
} from '../testing/live-notion.ts'
import { scenarioImplementationGaps, type ScenarioId } from '../testing/scenarios.ts'

const processLiveConfig = liveNotionConfigFromEnv(liveNotionEnvFromProcessEnv())
const implementedLiveScenarioIds = new Set<ScenarioId>([
  'NDS-L6-live-workspace-provisioner-lane',
  'NDS-LIVE-skeleton-gated-cleanup-ledger',
  'NDS-LIVE-bounded-fixture-soak',
  'NDS-LIVE-cleanup-ledger-resume',
  'NDS-LIVE-public-sqlite-cdc-write',
  'NDS-L6-live-workspace-scratch-row-bidi',
  'NDS-LIVE-notion-view-inventory-read',
])

const decode = <TSchema extends Schema.Codec<any, any, never>>(
  schema: TSchema,
  value: unknown,
): typeof schema.Type => Schema.decodeUnknownSync(schema)(value)

const sha256Hash = (value: string) =>
  decode(Hash, `sha256:${createHash('sha256').update(value).digest('hex')}`)

const text = (content: string) => ({ type: 'text', text: { content } })
const title = (content: string) => ({ title: [text(content)] })

const liveLayer = (token: string) =>
  Layer.mergeAll(
    NotionConfigLive({
      authToken: Redacted.make(token),
      retryEnabled: true,
      maxRetries: 2,
      retryBaseDelay: 500,
    }),
    FetchHttpClient.layer,
  )

const runLive = <A, E>(
  env: { readonly token: string | undefined },
  effect: Effect.Effect<A, E, NotionConfig | HttpClient>,
) => {
  if (env.token === undefined) {
    throw new Error('live Notion test requires a token after configuration validation')
  }

  return Effect.runPromise(effect.pipe(Effect.provide(liveLayer(env.token))))
}

const runLiveGateway = <A, E>(
  env: { readonly token: string | undefined },
  effect: Effect.Effect<A, E, NotionDataSourceGateway | NotionConfig | HttpClient>,
) => {
  if (env.token === undefined) {
    throw new Error('live Notion gateway test requires a token after configuration validation')
  }

  const baseLayer = liveLayer(env.token)
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(baseLayer, NotionDataSourceGatewayLive.pipe(Layer.provide(baseLayer))),
      ),
    ),
  )
}

const runLiveBody = <A, E>(
  env: { readonly token: string | undefined },
  effect: Effect.Effect<A, E, PageBodySyncPort | NotionMdGateway>,
) => {
  if (env.token === undefined) {
    throw new Error('live NotionMD body test requires a token after configuration validation')
  }

  return Effect.runPromise(
    effect.pipe(
      Effect.provideServiceEffect(
        PageBodySyncPort,
        NotionMdGateway.pipe(Effect.map((gateway) => makeNotionMdPageBodySyncPort({ gateway }))),
      ),
      Effect.provide(NotionMdGatewayLive.pipe(Layer.provide(liveLayer(env.token)))),
    ),
  )
}

const runLiveAdoption = <A, E>(
  env: { readonly token: string | undefined },
  effect: Effect.Effect<A, E, NotionDataSourceGateway | PageBodySyncPort | NotionMdGateway>,
) => {
  if (env.token === undefined) {
    throw new Error('live Notion adoption test requires a token after configuration validation')
  }

  const baseLayer = liveLayer(env.token)
  const gatewayLayer = NotionDataSourceGatewayLive.pipe(Layer.provide(baseLayer))
  const notionMdLayer = NotionMdGatewayLive.pipe(Layer.provide(baseLayer))
  const bodyLayer = Layer.effect(
    PageBodySyncPort,
    NotionMdGateway.pipe(Effect.map((gateway) => makeNotionMdPageBodySyncPort({ gateway }))),
  ).pipe(Layer.provide(notionMdLayer))

  return Effect.runPromise(
    effect.pipe(Effect.provide(Layer.mergeAll(baseLayer, gatewayLayer, notionMdLayer, bodyLayer))),
  )
}

const propertyIdByName = (properties: Record<string, unknown>, name: string): string => {
  const property = properties[name]
  if (typeof property === 'object' && property !== null && 'id' in property) {
    const id = property.id
    if (typeof id === 'string') return id
  }

  throw new Error(`live fixture property not found: ${name}`)
}

const propertyOptions = (
  properties: Record<string, unknown>,
  name: string,
  type: 'select' | 'multi_select',
) => {
  const property = properties[name]
  if (typeof property !== 'object' || property === null || !(type in property)) {
    throw new Error(`live fixture ${type} property not found: ${name}`)
  }
  const value = (property as Record<string, unknown>)[type]
  if (
    typeof value !== 'object' ||
    value === null ||
    !('options' in value) ||
    Array.isArray((value as Record<string, unknown>).options) === false
  ) {
    throw new Error(`live fixture ${type} property has no options: ${name}`)
  }
  const options = (value as { readonly options: ReadonlyArray<unknown> }).options

  const toCanonicalOption = (option: unknown) => {
    if (typeof option !== 'object' || option === null || !('name' in option)) {
      throw new Error(`live fixture ${type} option has invalid shape: ${name}`)
    }
    const optionRecord = option as Record<string, unknown>
    const id = typeof optionRecord.id === 'string' ? optionRecord.id : undefined
    const color = typeof optionRecord.color === 'string' ? optionRecord.color : undefined
    return {
      _tag: 'CanonicalOptionValue' as const,
      ...(id === undefined ? {} : { id: decode(PropertyId, id) }),
      name: decode(PropertyName, String(optionRecord.name)),
      ...(color === undefined ? {} : { color }),
    }
  }
  return options.map(toCanonicalOption)
}

const livePropertyPlainText = (property: unknown): string => {
  if (typeof property !== 'object' || property === null) return ''
  const textItems =
    'title' in property
      ? (property as { readonly title?: unknown }).title
      : 'rich_text' in property
        ? (property as { readonly rich_text?: unknown }).rich_text
        : undefined
  if (Array.isArray(textItems) === false) return ''
  return textItems
    .map((item) =>
      typeof item === 'object' &&
      item !== null &&
      'plain_text' in item &&
      typeof item.plain_text === 'string'
        ? item.plain_text
        : '',
    )
    .join('')
}

const quoteSqlIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`

const listNmdFiles = async (root: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name)
      if (entry.isDirectory() === true) return listNmdFiles(path)
      return entry.isFile() === true && entry.name.endsWith('.nmd') === true ? [path] : []
    }),
  )
  return nested.flat()
}

const cleanBreakSqlitePath = ({
  workspaceRoot,
  databaseId,
}: {
  readonly workspaceRoot: string
  readonly databaseId: string
}): string => join(workspaceRoot, 'data', 'v1', `${databaseId}.sqlite`)

/**
 * Control-plane store path for a tracked workspace. The `_nds_*` control-plane
 * tables (outbox, shadow, sync events) live here, split from the public
 * projection in the `data/v1/<source>.sqlite` data file (decision 0020).
 */
const cleanBreakStatePath = ({ workspaceRoot }: { readonly workspaceRoot: string }): string =>
  join(workspaceRoot, '.notion', 'v1', 'state.sqlite')

const liveDatabaseIdForDataSource = (dataSource: unknown): string => {
  if (
    typeof dataSource === 'object' &&
    dataSource !== null &&
    'parent' in dataSource &&
    typeof dataSource.parent === 'object' &&
    dataSource.parent !== null &&
    'type' in dataSource.parent &&
    dataSource.parent.type === 'database_id' &&
    'database_id' in dataSource.parent &&
    typeof dataSource.parent.database_id === 'string'
  ) {
    return dataSource.parent.database_id
  }
  throw new Error('live data source did not expose parent database_id')
}

const liveTitlePropertyName = (properties: Record<string, unknown>): string => {
  const entry = Object.entries(properties).find(([, property]) => {
    if (typeof property !== 'object' || property === null) return false
    return (
      ('type' in property && property.type === 'title') ||
      Object.prototype.hasOwnProperty.call(property, 'title')
    )
  })
  if (entry === undefined) {
    throw new Error('live fixture data source does not expose a title property')
  }
  const [fallbackName, property] = entry
  return typeof property === 'object' &&
    property !== null &&
    'name' in property &&
    typeof property.name === 'string'
    ? property.name
    : fallbackName
}

const makeLedgerRecorder = (
  env: ReturnType<typeof liveNotionEnvFromProcessEnv>,
  config: Extract<ReturnType<typeof liveNotionConfigFromEnv>, { readonly _tag: 'configured' }>,
  initialLedger: LiveFixtureLedger,
) => {
  let ledger = initialLedger
  const writeLedger = makeLiveFixtureLedgerWriter({ env, config })

  const record = async (entry: Parameters<typeof ledgerEntry>[0]): Promise<LiveFixtureLedger> => {
    ledger = { ...ledger, entries: [...ledger.entries, ledgerEntry(entry)] }
    await writeLedger({ path: config.ledgerPath, ledger })
    return ledger
  }

  return {
    current: () => ledger,
    record,
  }
}

const archiveDatabaseBestEffort = (
  env: ReturnType<typeof liveNotionEnvFromProcessEnv>,
  databaseId: string,
) =>
  runLive(
    env,
    NotionDatabases.archive({ databaseId }).pipe(
      Effect.catchIf(
        (cause) => String(cause).toLowerCase().includes('archived') === true,
        () => Effect.void,
      ),
    ),
  )

const liveSchemaProperty = ({
  properties,
  name,
  type,
}: {
  readonly properties: Record<string, unknown>
  readonly name: string
  readonly type: string
}): SchemaPropertyObservation => {
  const property = properties[name]
  if (typeof property !== 'object' || property === null || !('id' in property)) {
    throw new Error(`live fixture property ${name} has no id`)
  }
  const propertyId = (property as { readonly id: unknown }).id
  if (typeof propertyId !== 'string') {
    throw new Error(`live fixture property ${name} id is not a string`)
  }
  return {
    propertyId: decode(PropertyId, propertyId),
    name,
    type,
    configHash: canonicalHash(property),
    writeClass: 'writable',
  }
}

const runLiveCliCommand = async ({
  argv,
  env,
}: {
  readonly argv: ReadonlyArray<string>
  readonly env: ReturnType<typeof liveNotionEnvFromProcessEnv>
}) => {
  const cliCommand = parseCliCommand(argv)
  const command = parseCliContext({ argv, resolvedCommand: cliCommand })
  if (env.token === undefined) {
    throw new Error('live CLI test requires a token after configuration validation')
  }
  try {
    return await Effect.runPromise(
      runCliCommandWithRuntime({
        command: cliCommand,
        context: command,
        options: {
          env:
            env.tokenSource === 'NOTION_TOKEN'
              ? { NOTION_TOKEN: env.token }
              : { NOTION_API_TOKEN: env.token },
        },
      }),
    )
  } finally {
    command.store.close()
  }
}

const readReplicaHealth = ({
  replicaPath,
  statePath,
}: {
  readonly replicaPath: string
  readonly statePath: string
}) => {
  const db = new DatabaseSync(replicaPath, { readOnly: true })
  try {
    const status = db.prepare(`SELECT * FROM sync_status`).get() as
      | {
          readonly conflicts_open: number
          readonly pending_local_changes: number
          readonly workspace_status: string
        }
      | undefined
    const pendingChanges = db
      .prepare(
        `SELECT count(*) AS count FROM changes WHERE status IN ('pending', 'queued', 'planned')`,
      )
      .get() as { readonly count: number }
    const openConflicts = db
      .prepare(`SELECT count(*) AS count FROM conflicts WHERE state = 'open'`)
      .get() as { readonly count: number }

    if (status === undefined) {
      throw new Error('replica did not expose sync_status')
    }

    // The control-plane outbox lives in the split `.notion/v1/state.sqlite`
    // store, not the public projection data file (decision 0020).
    const stateDb = new DatabaseSync(statePath, { readOnly: true })
    let pendingOutboxCount: number
    try {
      pendingOutboxCount = (
        stateDb
          .prepare(`SELECT count(*) AS count FROM _nds_outbox WHERE state != 'settled'`)
          .get() as { readonly count: number }
      ).count
    } finally {
      stateDb.close()
    }

    return {
      conflictsOpen: status.conflicts_open,
      pendingLocalChanges: status.pending_local_changes,
      workspaceStatus: status.workspace_status,
      pendingChanges: pendingChanges.count,
      openConflicts: openConflicts.count,
      pendingOutbox: pendingOutboxCount,
    }
  } finally {
    db.close()
  }
}

describe('notion datasource sync live Notion E2E skeleton', () => {
  it('has a declared live scenario implementation', () => {
    expect(
      scenarioImplementationGaps({
        file: 'src/e2e/live-notion.e2e.test.ts',
        implementedScenarioIds: implementedLiveScenarioIds,
      }),
    ).toEqual([])
  })

  it('reports an explicit not-configured state when live Notion is not opted in', () => {
    const config = liveNotionConfigFromEnv(
      liveNotionEnvFromProcessEnv({
        NOTION_API_TOKEN: undefined,
        NOTION_TOKEN: undefined,
        NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID: undefined,
        NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID: undefined,
        NOTION_DATASOURCE_SYNC_LEDGER_PATH: undefined,
        NOTION_DATASOURCE_SYNC_LIVE: undefined,
      }),
    )

    expect(config._tag).toBe('not-configured')
    if (config._tag !== 'not-configured') return
    expect(config.skipReason).toContain('live Notion E2E disabled')
    expect(config.missing).toEqual(['NOTION_DATASOURCE_SYNC_LIVE=1'])
  })

  it('fails closed for partial opt-in live Notion configuration', () => {
    const config = liveNotionConfigFromEnv(
      liveNotionEnvFromProcessEnv({
        NOTION_DATASOURCE_SYNC_LIVE: '1',
        NOTION_API_TOKEN: 'ntn_realistic_token_shape',
        NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID: undefined,
        NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID: '00000000000000000000000000000000',
      }),
    )

    expect(config).toMatchObject({
      _tag: 'invalid-config',
      missing: ['NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID'],
      invalid: [],
    })
  })

  it('supports parent-only live Notion configuration for disposable data-source fixtures', () => {
    const config = liveNotionConfigFromEnv(
      liveNotionEnvFromProcessEnv({
        NOTION_DATASOURCE_SYNC_LIVE: '1',
        NOTION_API_TOKEN: 'ntn_realistic_token_shape',
        NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID: '00000000000000000000000000000001',
        NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID: undefined,
      }),
    )

    expect(config).toMatchObject({
      _tag: 'configured',
      parentPageId: '00000000000000000000000000000001',
      dataSourceId: undefined,
    })
  })

  it('supports explicit visible ledger and demo page configuration', () => {
    const config = liveNotionConfigFromEnv(
      liveNotionEnvFromProcessEnv({
        NOTION_DATASOURCE_SYNC_LIVE: '1',
        NOTION_API_TOKEN: 'ntn_realistic_token_shape',
        NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID: '00000000000000000000000000000001',
        NOTION_DATASOURCE_SYNC_E2E_LEDGER_PAGE_ID: '00000000000000000000000000000002',
        NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID: '36cf141b18dc803b98ebd21f2a243453',
      }),
    )

    expect(config).toMatchObject({
      _tag: 'configured',
      e2eLedgerPageId: '00000000000000000000000000000002',
      demoPageId: '36cf141b18dc803b98ebd21f2a243453',
    })
  })

  it('does not opt in when dummy full live Notion env is present without the live flag', () => {
    const config = liveNotionConfigFromEnv(
      liveNotionEnvFromProcessEnv({
        NOTION_API_TOKEN: 'dummy-token',
        NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID: 'parent-page-id',
        NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID: 'data-source-id',
        NOTION_DATASOURCE_SYNC_LEDGER_PATH: 'tmp/notion-datasource-sync-live/dummy.json',
        NOTION_DATASOURCE_SYNC_LIVE: undefined,
      }),
    )

    expect(config).toMatchObject({
      _tag: 'not-configured',
      missing: ['NOTION_DATASOURCE_SYNC_LIVE=1'],
    })
  })

  it('fails closed for opted-in dummy live Notion configuration', () => {
    const config = liveNotionConfigFromEnv(
      liveNotionEnvFromProcessEnv({
        NOTION_DATASOURCE_SYNC_LIVE: '1',
        NOTION_API_TOKEN: 'dummy-token',
        NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID: 'parent-page-id',
        NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID: 'data-source-id',
      }),
    )

    expect(config).toMatchObject({
      _tag: 'invalid-config',
      missing: [],
      invalid: [
        'NOTION_API_TOKEN',
        'NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID',
        'NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID',
      ],
    })
    if (config._tag !== 'invalid-config') return
    expect(config.message).toContain('invalid configuration')
  })

  it('fails closed for invalid explicit ledger and demo page ids', () => {
    const config = liveNotionConfigFromEnv(
      liveNotionEnvFromProcessEnv({
        NOTION_DATASOURCE_SYNC_LIVE: '1',
        NOTION_API_TOKEN: 'ntn_realistic_token_shape',
        NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID: '00000000000000000000000000000001',
        NOTION_DATASOURCE_SYNC_E2E_LEDGER_PAGE_ID: 'not-a-page-id',
        NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID: 'also-not-a-page-id',
      }),
    )

    expect(config).toMatchObject({
      _tag: 'invalid-config',
      invalid: ['NOTION_DATASOURCE_SYNC_E2E_LEDGER_PAGE_ID', 'NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID'],
    })
  })

  it('defaults live preflight to read-only capabilities', () => {
    const config = liveNotionConfigFromEnv(
      liveNotionEnvFromProcessEnv({
        NOTION_DATASOURCE_SYNC_LIVE: '1',
        NOTION_API_TOKEN: 'ntn_realistic_token_shape',
        NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID: '00000000000000000000000000000001',
        NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID: '00000000000000000000000000000002',
      }),
    )

    expect(config).toMatchObject({
      _tag: 'configured',
      requiredCapabilities: [...defaultLivePreflightCapabilities],
    })
  })

  it('runs default live preflight read probes without requiring page-property pagination', async () => {
    const configured = {
      _tag: 'configured' as const,
      runId: 'notion-ds-sync-default-read-preflight-test',
      parentPageId: testIds.pageId,
      dataSourceId: testIds.dataSourceId,
      notionVersion: '2026-03-11' as const,
      requiredCapabilities: defaultLivePreflightCapabilities,
      ledgerPath: 'tmp/notion-datasource-sync-live/default-read-preflight-test.json',
    }
    const calls = {
      queryRows: 0,
      retrievePage: 0,
      retrievePageProperty: 0,
    }
    const ledgers: Array<LiveFixtureLedger> = []
    const harness = makeFakeGatewayHarness({ capabilities: defaultLivePreflightCapabilities })
    const gateway: NotionDataSourceGatewayShape = {
      ...harness.gateway,
      queryRows: (input) => {
        calls.queryRows += 1
        return harness.gateway.queryRows(input)
      },
      retrievePage: (input) => {
        calls.retrievePage += 1
        return harness.gateway.retrievePage(input)
      },
      retrievePageProperty: (input) => {
        calls.retrievePageProperty += 1
        return harness.gateway.retrievePageProperty(input)
      },
    }

    const result = await runLiveNotionPreflight({
      env: {
        enabled: true,
        token: 'ntn_realistic_token_shape',
        tokenSource: 'NOTION_API_TOKEN',
        parentPageId: configured.parentPageId,
        dataSourceId: configured.dataSourceId,
        requiredCapabilities: undefined,
        ledgerPath: configured.ledgerPath,
      },
      config: configured,
      options: {
        gatewayLayer: makeNotionDataSourceGatewayLayer(gateway),
        writeLedger: async ({ ledger }) => {
          ledgers.push(ledger)
        },
      },
    })

    expect(result.missingCapabilities).toEqual([])
    expect(calls).toEqual({ queryRows: 1, retrievePage: 1, retrievePageProperty: 0 })
    expect(ledgers.flatMap((ledger) => ledger.entries)).toEqual(
      expect.arrayContaining([expect.objectContaining({ cleanupState: 'verified-cleaned' })]),
    )
  })

  it('does not run live read probes or write verified-cleaned ledger entries when requested capabilities are missing', async () => {
    const configured = {
      _tag: 'configured' as const,
      runId: 'notion-ds-sync-missing-capability-test',
      parentPageId: '00000000000000000000000000000001',
      dataSourceId: '00000000000000000000000000000002',
      notionVersion: '2026-03-11' as const,
      requiredCapabilities: ['data_source_query', 'page_retrieve'] as const,
      ledgerPath: 'tmp/notion-datasource-sync-live/missing-capability-test.json',
    }
    const calls = {
      queryRows: 0,
      retrievePage: 0,
    }
    const ledgers: Array<LiveFixtureLedger> = []
    const apiContract = makeNotionApiContract({
      supportedCapabilities: ['data_source_query'],
    })
    const gateway: NotionDataSourceGatewayShape = {
      apiContract,
      preflightCapabilities: (input) =>
        Effect.succeed({
          _tag: 'CapabilityPreflightResult',
          dataSourceId: input.dataSourceId,
          apiContract,
          supportedCapabilities: input.requiredCapabilities.filter((capability) =>
            apiContract.supportedCapabilities.includes(capability),
          ),
          missingCapabilities: input.requiredCapabilities.filter(
            (capability) => apiContract.supportedCapabilities.includes(capability) === false,
          ),
        }),
      retrieveDataSource: () => Effect.die('retrieveDataSource should not be called'),
      queryRows: () => {
        calls.queryRows += 1
        return Stream.die('queryRows should not be called')
      },
      retrievePage: () => {
        calls.retrievePage += 1
        return Effect.die('retrievePage should not be called')
      },
      retrievePageProperty: () => Stream.die('retrievePageProperty should not be called'),
      patchPageProperties: () => Effect.die('patchPageProperties should not be called'),
      createPage: () => Effect.die('createPage should not be called'),
      patchDataSourceSchema: () => Effect.die('patchDataSourceSchema should not be called'),
      patchDataSourceMetadata: () => Effect.die('patchDataSourceMetadata should not be called'),
      patchDatabaseMetadata: () => Effect.die('patchDatabaseMetadata should not be called'),
      trashPage: () => Effect.die('trashPage should not be called'),
      restorePage: () => Effect.die('restorePage should not be called'),
    }

    await expect(
      runLiveNotionPreflight({
        env: {
          enabled: true,
          token: 'ntn_realistic_token_shape',
          tokenSource: 'NOTION_API_TOKEN',
          parentPageId: configured.parentPageId,
          dataSourceId: configured.dataSourceId,
          requiredCapabilities: configured.requiredCapabilities.join(','),
          ledgerPath: configured.ledgerPath,
        },
        config: configured,
        options: {
          gatewayLayer: makeNotionDataSourceGatewayLayer(gateway),
          writeLedger: async ({ ledger }) => {
            ledgers.push(ledger)
          },
        },
      }),
    ).rejects.toThrow('Missing Notion capability: page_retrieve')

    expect(calls).toEqual({ queryRows: 0, retrievePage: 0 })
    expect(ledgers.flatMap((ledger) => ledger.entries)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ cleanupState: 'verified-cleaned' })]),
    )
  })

  it('fails closed before read probes when page-property pagination is required but unsupported', async () => {
    const configured = {
      _tag: 'configured' as const,
      runId: 'notion-ds-sync-page-property-capability-test',
      parentPageId: '00000000000000000000000000000001',
      dataSourceId: '00000000000000000000000000000002',
      notionVersion: '2026-03-11' as const,
      requiredCapabilities: strictLivePreflightCapabilities,
      ledgerPath: 'tmp/notion-datasource-sync-live/page-property-capability-test.json',
    }
    const calls = {
      queryRows: 0,
      retrievePage: 0,
      retrievePageProperty: 0,
    }
    const apiContract = makeNotionApiContract({
      supportedCapabilities: [
        'data_source_retrieve',
        'data_source_query',
        'data_source_metadata_update',
        'page_retrieve',
      ],
    })
    const gateway: NotionDataSourceGatewayShape = {
      apiContract,
      preflightCapabilities: (input) =>
        Effect.succeed({
          _tag: 'CapabilityPreflightResult',
          dataSourceId: input.dataSourceId,
          apiContract,
          supportedCapabilities: input.requiredCapabilities.filter((capability) =>
            apiContract.supportedCapabilities.includes(capability),
          ),
          missingCapabilities: input.requiredCapabilities.filter(
            (capability) => apiContract.supportedCapabilities.includes(capability) === false,
          ),
        }),
      retrieveDataSource: () => Effect.die('retrieveDataSource should not be called'),
      queryRows: () => {
        calls.queryRows += 1
        return Stream.die('queryRows should not be called')
      },
      retrievePage: () => {
        calls.retrievePage += 1
        return Effect.die('retrievePage should not be called')
      },
      retrievePageProperty: () => {
        calls.retrievePageProperty += 1
        return Stream.die('retrievePageProperty should not be called')
      },
      patchPageProperties: () => Effect.die('patchPageProperties should not be called'),
      createPage: () => Effect.die('createPage should not be called'),
      patchDataSourceSchema: () => Effect.die('patchDataSourceSchema should not be called'),
      patchDataSourceMetadata: () => Effect.die('patchDataSourceMetadata should not be called'),
      patchDatabaseMetadata: () => Effect.die('patchDatabaseMetadata should not be called'),
      trashPage: () => Effect.die('trashPage should not be called'),
      restorePage: () => Effect.die('restorePage should not be called'),
    }

    await expect(
      runLiveNotionPreflight({
        env: {
          enabled: true,
          token: 'ntn_realistic_token_shape',
          tokenSource: 'NOTION_API_TOKEN',
          parentPageId: configured.parentPageId,
          dataSourceId: configured.dataSourceId,
          requiredCapabilities: configured.requiredCapabilities.join(','),
          ledgerPath: configured.ledgerPath,
        },
        config: configured,
        options: { gatewayLayer: makeNotionDataSourceGatewayLayer(gateway) },
      }),
    ).rejects.toThrow('Missing Notion capability: page_property_paginate')

    expect(calls).toEqual({ queryRows: 0, retrievePage: 0, retrievePageProperty: 0 })
  })

  it('runs strict real-adapter preflight once all required capabilities are supported', async () => {
    const configured = {
      _tag: 'configured' as const,
      runId: 'notion-ds-sync-real-adapter-strict-page-property-test',
      parentPageId: '00000000000000000000000000000001',
      dataSourceId: '00000000000000000000000000000002',
      notionVersion: '2026-03-11' as const,
      requiredCapabilities: strictLivePreflightCapabilities,
      ledgerPath: 'tmp/notion-datasource-sync-live/real-adapter-strict-page-property-test.json',
    }
    const calls = {
      retrieveDataSource: 0,
      queryDataSource: 0,
      retrievePage: 0,
      retrievePageProperty: 0,
      updatePage: 0,
      updateDataSource: 0,
    }
    const ledgers: Array<LiveFixtureLedger> = []
    const client: NotionGatewayClient = {
      retrieveDataSource: ({ dataSourceId }) =>
        Effect.sync(() => {
          calls.retrieveDataSource += 1
          return {
            id: dataSourceId,
            properties: {
              Name: { id: 'title', name: 'Name', type: 'title' },
            },
          }
        }),
      queryDataSource: () => {
        calls.queryDataSource += 1
        return Effect.succeed({ results: [], nextCursor: Option.none(), hasMore: false })
      },
      retrievePage: ({ pageId }) => {
        calls.retrievePage += 1
        return Effect.succeed({
          id: pageId,
          parent: { type: 'data_source_id', data_source_id: configured.dataSourceId },
          properties: {},
          last_edited_time: '2026-05-25T00:00:00.000Z',
          in_trash: false,
        })
      },
      retrievePageProperty: () => {
        calls.retrievePageProperty += 1
        return Effect.succeed({ results: [], nextCursor: Option.none(), hasMore: false })
      },
      retrieveDatabase: () =>
        Effect.succeed({
          id: 'database-1',
          title: [],
          description: [],
          icon: null,
        }),
      updatePage: ({ pageId }) => {
        calls.updatePage += 1
        return Effect.succeed({
          id: pageId,
          parent: { type: 'data_source_id', data_source_id: configured.dataSourceId },
          properties: {},
          last_edited_time: '2026-05-25T00:00:00.000Z',
          in_trash: false,
        })
      },
      createPage: ({ properties }) =>
        Effect.succeed({
          id: 'created-page-1',
          parent: { type: 'data_source_id', data_source_id: configured.dataSourceId },
          properties,
          last_edited_time: '2026-05-25T00:00:00.000Z',
          in_trash: false,
        }),
      updateDataSource: ({ dataSourceId }) => {
        calls.updateDataSource += 1
        return Effect.succeed({
          id: dataSourceId,
          properties: {
            Name: { id: 'title', name: 'Name', type: 'title' },
          },
        })
      },
      updateDatabase: () =>
        Effect.succeed({
          id: 'database-1',
          title: [],
          description: [],
          icon: null,
        }),
    }

    const result = await runLiveNotionPreflight({
      env: {
        enabled: true,
        token: 'ntn_realistic_token_shape',
        tokenSource: 'NOTION_API_TOKEN',
        parentPageId: configured.parentPageId,
        dataSourceId: configured.dataSourceId,
        e2eLedgerPageId: undefined,
        demoPageId: undefined,
        requiredCapabilities: configured.requiredCapabilities.join(','),
        ledgerPath: configured.ledgerPath,
      },
      config: configured,
      options: {
        gatewayLayer: makeNotionDataSourceGatewayLayer(
          makeNotionDataSourceGatewayFromClient({ client }),
        ),
        writeLedger: async ({ ledger }) => {
          ledgers.push(ledger)
        },
      },
    })

    expect(calls).toEqual({
      retrieveDataSource: 1,
      queryDataSource: 1,
      retrievePage: 1,
      retrievePageProperty: 0,
      updatePage: 0,
      updateDataSource: 0,
    })
    expect(result.missingCapabilities).toEqual([])
    expect(ledgers).toEqual([result.ledger])
  })

  it('runs a real preflight when live Notion is explicitly configured', async () => {
    if (processLiveConfig._tag === 'not-configured') {
      expect(processLiveConfig.skipReason).toContain('live Notion E2E disabled')
      return
    }
    if (processLiveConfig._tag === 'invalid-config') {
      expect(processLiveConfig.message).toContain('invalid configuration')
      return
    }

    const provisioned = await provisionLiveNotionDataSourceFixture({
      env: liveNotionEnvFromProcessEnv(),
      config: processLiveConfig,
    })

    if (provisioned.config.requiredCapabilities.includes('page_property_paginate') === true) {
      await expect(
        runLiveNotionPreflight({
          env: liveNotionEnvFromProcessEnv(),
          config: provisioned.config,
          options: { initialLedger: provisioned.ledger },
        }),
      ).rejects.toThrow('Missing Notion capability: page_property_paginate')
      await provisioned.cleanup(provisioned.ledger)
      return
    }

    let ledger = provisioned.ledger
    try {
      const result = await runLiveNotionPreflight({
        env: liveNotionEnvFromProcessEnv(),
        config: provisioned.config,
        options: { initialLedger: ledger },
      })
      ledger = result.ledger
      expect(result.supportedCapabilities).toEqual(
        expect.arrayContaining([...provisioned.config.requiredCapabilities]),
      )
      expect(result.missingCapabilities).toEqual([])
      expect(result.ledgerPath).toBe(provisioned.config.ledgerPath)
    } finally {
      await provisioned.cleanup(ledger)
    }
  }, 120_000)

  it('reports why the credentialed live fixture lifecycle is skipped when unavailable', () => {
    if (processLiveConfig._tag === 'configured') {
      expect(processLiveConfig.parentPageId).toBeTruthy()
      return
    }

    const reason =
      processLiveConfig._tag === 'not-configured'
        ? processLiveConfig.skipReason
        : processLiveConfig.message
    expect(reason).toMatch(/live Notion E2E|invalid configuration/)
  })

  describe.skipIf(processLiveConfig._tag !== 'configured')(
    'credentialed live Notion fixture lifecycle',
    () => {
      it('creates, verifies, mutates, restores, and cleans up a disposable fixture', async () => {
        if (processLiveConfig._tag !== 'configured') return

        const env = liveNotionEnvFromProcessEnv()
        const fixtureConfig = { ...processLiveConfig, dataSourceId: undefined }
        const provisioned = await provisionLiveNotionDataSourceFixture({
          env,
          config: fixtureConfig,
        })
        let ledger = provisioned.ledger

        try {
          const preflight = await runLiveNotionPreflight({
            env,
            config: provisioned.config,
            options: { initialLedger: ledger },
          })
          ledger = preflight.ledger
          ledger = await runLiveFixtureLifecycle({
            config: provisioned.config,
            client: makeLiveNotionFixtureLifecycleClient({ env, config: provisioned.config }),
            options: {
              initialLedger: ledger,
              writeLedger: makeLiveFixtureLedgerWriter({ env, config: provisioned.config }),
            },
          })

          expect(ledger.entries).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ objectType: 'database', cleanupState: 'created' }),
              expect.objectContaining({ objectType: 'data_source', cleanupState: 'created' }),
              expect.objectContaining({
                objectType: 'page',
                cleanupState: 'verified-cleaned',
              }),
            ]),
          )
          expect(JSON.stringify(ledger)).not.toContain('NOTION_TOKEN')
          expect(JSON.stringify(ledger)).not.toContain('NOTION_API_TOKEN')
        } finally {
          await provisioned.cleanup(ledger)
        }
      }, 120_000)

      it('applies the safe data-source schema patch subset against live Notion', async () => {
        if (processLiveConfig._tag !== 'configured') return

        const env = liveNotionEnvFromProcessEnv()
        const provisioned = await provisionLiveNotionDataSourceFixture({
          env,
          config: processLiveConfig,
        })
        const recorder = makeLedgerRecorder(env, provisioned.config, provisioned.ledger)

        try {
          await runLiveGateway(
            env,
            Effect.gen(function* () {
              const gateway = yield* NotionDataSourceGateway
              const dataSourceId = decode(DataSourceId, provisioned.config.dataSourceId)
              const initial = yield* gateway.retrieveDataSource(dataSourceId)

              yield* gateway.patchDataSourceSchema({
                _tag: 'PatchDataSourceSchemaCommand',
                commandId: decode(CommandId, `${provisioned.config.runId}:schema:add`),
                dataSourceId,
                baseSchemaHash: initial.schemaHash,
                schemaPatch: {},
                operations: [
                  decode(SchemaPatchOperation, {
                    _tag: 'AddProperty',
                    name: 'Notes',
                    definition: { _tag: 'rich_text' },
                  }),
                  decode(SchemaPatchOperation, {
                    _tag: 'AddProperty',
                    name: 'Stage',
                    definition: {
                      _tag: 'select',
                      options: [{ _tag: 'CanonicalOptionValue', name: 'seed' }],
                    },
                  }),
                  decode(SchemaPatchOperation, {
                    _tag: 'AddProperty',
                    name: 'Labels',
                    definition: {
                      _tag: 'multi_select',
                      options: [{ _tag: 'CanonicalOptionValue', name: 'base' }],
                    },
                  }),
                ],
              })

              const added = yield* NotionDataSources.retrieve({
                dataSourceId: provisioned.config.dataSourceId,
              })
              const notesPropertyId = decode(
                PropertyId,
                propertyIdByName(added.properties, 'Notes'),
              )
              const stagePropertyId = decode(
                PropertyId,
                propertyIdByName(added.properties, 'Stage'),
              )
              const labelsPropertyId = decode(
                PropertyId,
                propertyIdByName(added.properties, 'Labels'),
              )
              const addedSnapshot = yield* gateway.retrieveDataSource(dataSourceId)

              yield* gateway.patchDataSourceSchema({
                _tag: 'PatchDataSourceSchemaCommand',
                commandId: decode(CommandId, `${provisioned.config.runId}:schema:update`),
                dataSourceId,
                baseSchemaHash: addedSnapshot.schemaHash,
                schemaPatch: {},
                operations: [
                  decode(SchemaPatchOperation, {
                    _tag: 'RenameProperty',
                    propertyId: notesPropertyId,
                    newName: 'Notes Renamed',
                  }),
                  decode(SchemaPatchOperation, {
                    _tag: 'AddSelectOptions',
                    propertyId: stagePropertyId,
                    propertyType: 'select',
                    existingOptions: propertyOptions(added.properties, 'Stage', 'select'),
                    newOptions: [{ _tag: 'CanonicalOptionValue', name: 'added' }],
                  }),
                  decode(SchemaPatchOperation, {
                    _tag: 'AddSelectOptions',
                    propertyId: labelsPropertyId,
                    propertyType: 'multi_select',
                    existingOptions: propertyOptions(added.properties, 'Labels', 'multi_select'),
                    newOptions: [{ _tag: 'CanonicalOptionValue', name: 'extra' }],
                  }),
                ],
              })

              const updated = yield* NotionDataSources.retrieve({
                dataSourceId: provisioned.config.dataSourceId,
              })
              expect(updated.properties['Notes']).toBeUndefined()
              expect(updated.properties['Notes Renamed']).toBeDefined()
              expect(
                propertyOptions(updated.properties, 'Stage', 'select').map((option) => option.name),
              ).toEqual(expect.arrayContaining(['seed', 'added']))
              expect(
                propertyOptions(updated.properties, 'Labels', 'multi_select').map(
                  (option) => option.name,
                ),
              ).toEqual(expect.arrayContaining(['base', 'extra']))

              const finalSnapshot = yield* gateway.retrieveDataSource(dataSourceId)
              yield* Effect.flip(
                gateway.patchDataSourceSchema({
                  _tag: 'PatchDataSourceSchemaCommand',
                  commandId: decode(CommandId, `${provisioned.config.runId}:schema:empty`),
                  dataSourceId,
                  baseSchemaHash: finalSnapshot.schemaHash,
                  schemaPatch: {},
                  operations: [],
                }),
              ).pipe(
                Effect.map((error) =>
                  expect(error.message).toContain(
                    'Schema patch requires at least one supported operation',
                  ),
                ),
              )
            }),
          )

          await recorder.record({
            phase: 'mutate',
            objectId: provisioned.config.dataSourceId,
            objectType: 'data_source',
            purpose: 'live-schema-patch-safe-subset',
            cleanupState: 'mutated',
          })
          await recorder.record({
            phase: 'verify',
            objectId: provisioned.config.dataSourceId,
            objectType: 'data_source',
            purpose: 'live-schema-patch-safe-subset',
            cleanupState: 'verified',
          })
        } finally {
          await provisioned.cleanup(recorder.current())
        }
      }, 180_000)

      it('patches data-source description metadata against live Notion', async () => {
        if (processLiveConfig._tag !== 'configured') return

        const env = liveNotionEnvFromProcessEnv()
        const provisioned = await provisionLiveNotionDataSourceFixture({
          env,
          config: processLiveConfig,
        })
        const recorder = makeLedgerRecorder(env, provisioned.config, provisioned.ledger)
        const description = `datasource-sync metadata description ${provisioned.config.runId}`

        try {
          await runLiveGateway(
            env,
            Effect.gen(function* () {
              const gateway = yield* NotionDataSourceGateway
              const dataSourceId = decode(DataSourceId, provisioned.config.dataSourceId)
              const initial = yield* gateway.retrieveDataSource(dataSourceId)
              if (initial.metadataHash === undefined) {
                throw new Error('live data-source metadata hash was unavailable')
              }

              yield* gateway.patchDataSourceMetadata(
                decode(PatchDataSourceMetadataCommand, {
                  _tag: 'PatchDataSourceMetadataCommand',
                  commandId: `${provisioned.config.runId}:metadata:description`,
                  dataSourceId,
                  baseMetadataHash: initial.metadataHash,
                  metadataPatch: { descriptionPlainText: description },
                }),
              )

              const updated = yield* NotionDataSources.retrieve({
                dataSourceId: provisioned.config.dataSourceId,
              })
              expect(updated.description.map((part) => part.plain_text).join('')).toBe(description)
              const finalSnapshot = yield* gateway.retrieveDataSource(dataSourceId)
              expect(finalSnapshot.schemaHash).toBe(initial.schemaHash)
              expect(finalSnapshot.metadataHash).not.toBe(initial.metadataHash)
            }),
          )

          await recorder.record({
            phase: 'mutate',
            objectId: provisioned.config.dataSourceId,
            objectType: 'data_source',
            purpose: 'live-metadata-description-patch',
            cleanupState: 'mutated',
          })
          await recorder.record({
            phase: 'verify',
            objectId: provisioned.config.dataSourceId,
            objectType: 'data_source',
            purpose: 'live-metadata-description-patch',
            cleanupState: 'verified',
          })
        } finally {
          await provisioned.cleanup(recorder.current())
        }
      }, 120_000)

      it('establishes an existing live data source into an empty local workspace', async () => {
        if (processLiveConfig._tag !== 'configured') return

        const env = liveNotionEnvFromProcessEnv()
        const provisioned = await provisionLiveNotionDataSourceFixture({
          env,
          config: processLiveConfig,
        })
        const recorder = makeLedgerRecorder(env, provisioned.config, provisioned.ledger)
        const rowTitle = `auto schema row ${provisioned.config.runId}`
        const seededPage = await runLive(
          env,
          NotionPages.create({
            parent: {
              type: 'data_source_id',
              data_source_id: provisioned.config.dataSourceId,
            },
            properties: {
              Name: title(rowTitle),
              Done: { checkbox: true },
              Notes: { rich_text: [text('observed without schema json')] },
              Count: { number: 7 },
              Stage: { select: { name: 'doing' } },
              Due: { date: { start: '2026-05-28' } },
            },
          }),
        )
        await recorder.record({
          phase: 'create',
          objectId: seededPage.id,
          objectType: 'page',
          purpose: 'live-auto-schema-rows-value-fixture',
          cleanupState: 'created',
        })
        const workspaceRoot = decode(
          AbsolutePath,
          await mkdtemp(join(tmpdir(), 'notion-ds-sync-live-adopt-')),
        )
        const rootId = decode(SyncRootId, `live-adopt:${provisioned.config.runId}`)
        const dataSourceId = decode(DataSourceId, provisioned.config.dataSourceId)
        const liveDataSource = await runLive(
          env,
          NotionDataSources.retrieve({ dataSourceId: provisioned.config.dataSourceId }),
        )
        const sqlitePath = cleanBreakSqlitePath({
          workspaceRoot,
          databaseId: liveDatabaseIdForDataSource(liveDataSource),
        })
        // The versioned `data/v1` directory is created by `track`; this test
        // drives `establishFromNotion` against a unified store directly, so it
        // must create the parent directory before opening the SQLite file.
        await mkdir(dirname(sqlitePath), { recursive: true })
        const store = openNotionSyncStore({ path: sqlitePath })
        const queryContract = {
          _tag: 'QueryContract' as const,
          apiVersion: '2026-03-11' as const,
          filter: null,
          sorts: [],
          pageSize: 25,
          highWatermark: null,
          membershipScope: 'all-data-source-rows' as const,
        }
        const provideWorkspace = <A, E, R>(effect: Effect.Effect<A, E, R | LocalWorkspacePort>) =>
          effect.pipe(
            Effect.provideService(
              LocalWorkspacePort,
              makeFilesystemLocalWorkspacePort({ root: workspaceRoot }),
            ),
          )

        try {
          const dryRun = await runLiveAdoption(
            env,
            provideWorkspace(
              establishFromNotion({
                store,
                rootId,
                dataSourceId,
                workspaceRoot,
                queryContract,
                // Omit schemaProperties entirely so the live pull's observed
                // data-source schema is recorded (the test seeds a row "observed
                // without schema json"); passing `[]` would force an empty schema
                // and drop every property column from the projection.
                materializeBodies: false,
                dryRun: true,
              }),
            ),
          )
          expect(dryRun.pushed).toBe(false)
          expect(dryRun.pull.appendedEvents).toBe(0)
          expect(store.replay(rootId)).toHaveLength(0)

          const applied = await runLiveAdoption(
            env,
            provideWorkspace(
              establishFromNotion({
                store,
                rootId,
                dataSourceId,
                workspaceRoot,
                queryContract,
                // Omit schemaProperties entirely so the live pull's observed
                // data-source schema is recorded (the test seeds a row "observed
                // without schema json"); passing `[]` would force an empty schema
                // and drop every property column from the projection.
                materializeBodies: false,
              }),
            ),
          )
          const rerun = await runLiveAdoption(
            env,
            provideWorkspace(
              establishFromNotion({
                store,
                rootId,
                dataSourceId,
                workspaceRoot,
                queryContract,
                // Omit schemaProperties entirely so the live pull's observed
                // data-source schema is recorded (the test seeds a row "observed
                // without schema json"); passing `[]` would force an empty schema
                // and drop every property column from the projection.
                materializeBodies: false,
              }),
            ),
          )

          expect(applied.pushed).toBe(false)
          expect(applied.pull.appendedEvents).toBeGreaterThan(0)
          expect(rerun.pushed).toBe(false)
          expect(rerun.pull.appendedEvents).toBe(0)
          projectReplicaFromSyncStore({
            syncStorePath: sqlitePath,
            replicaPath: sqlitePath,
            rootId,
          })
          const db = new DatabaseSync(sqlitePath, { readOnly: true })
          try {
            const columns = db
              .prepare(`PRAGMA table_xinfo(pages)`)
              .all()
              .map((row) => String((row as { readonly name: unknown }).name))
            expect(columns).not.toContain('schema_json')
            expect(columns.findIndex((column) => column.startsWith('_'))).toBeGreaterThan(0)
            expect(
              db
                .prepare(
                  `SELECT property_name, property_type
                   FROM schema_properties
                   ORDER BY ordinal`,
                )
                .all(),
            ).toEqual(expect.arrayContaining([expect.objectContaining({ property_name: 'Name' })]))
            expect(
              db
                .prepare(
                  `SELECT "Name", "Done", "Notes", "Count", "Stage", "Due"
                   FROM pages
                   WHERE _page_id = ?`,
                )
                .get(seededPage.id),
            ).toMatchObject({
              Name: rowTitle,
              Done: 1,
              Notes: 'observed without schema json',
              Count: 7,
              Stage: 'doing',
              Due: '2026-05-28',
            })
          } finally {
            db.close()
          }
          await recorder.record({
            phase: 'verify',
            objectType: 'data_source',
            objectId: provisioned.config.dataSourceId,
            cleanupState: 'verified',
            purpose: 'live-sync-from-notion-adoption',
          })
        } finally {
          store.close()
          await rm(workspaceRoot, { recursive: true, force: true })
          await provisioned.cleanup(recorder.current())
        }
      }, 180_000)

      it('applies public SQLite CDC cell and row lifecycle changes against live Notion', async () => {
        if (processLiveConfig._tag !== 'configured') return

        const env = liveNotionEnvFromProcessEnv()
        const provisioned = await provisionLiveNotionDataSourceFixture({
          env,
          config: processLiveConfig,
        })
        const recorder = makeLedgerRecorder(env, provisioned.config, provisioned.ledger)
        const workspaceRoot = decode(
          AbsolutePath,
          await mkdtemp(join(tmpdir(), 'notion-ds-sync-live-sqlite-cdc-')),
        )
        let pageId: string | undefined
        let createdPageId: string | undefined

        try {
          const initialDataSource = await runLive(
            env,
            NotionDataSources.retrieve({ dataSourceId: provisioned.config.dataSourceId }),
          )
          const titlePropertyName = liveTitlePropertyName(initialDataSource.properties)
          const cdcPropertyName = 'CDC Note'
          const patchedDataSource = await runLive(
            env,
            NotionDataSources.update({
              dataSourceId: provisioned.config.dataSourceId,
              properties: {
                [cdcPropertyName]: { rich_text: {} },
              },
            }),
          )
          await recorder.record({
            phase: 'mutate',
            objectId: provisioned.config.dataSourceId,
            objectType: 'data_source',
            purpose: 'live-public-sqlite-cdc-schema-fixture',
            cleanupState: 'mutated',
          })
          const cdcSchemaProperty = liveSchemaProperty({
            properties: patchedDataSource.properties,
            name: cdcPropertyName,
            type: 'rich_text',
          })
          const titleSchemaProperty = liveSchemaProperty({
            properties: patchedDataSource.properties,
            name: titlePropertyName,
            type: 'title',
          })
          const initialTitle = `sqlite cdc initial ${provisioned.config.runId}`
          const updatedTitle = `sqlite cdc updated ${provisioned.config.runId}`
          const initialBody = `# Live CLI body\n\nMaterialized through default live CLI ${provisioned.config.runId}\n`
          const page = await runLive(
            env,
            NotionPages.create({
              parent: {
                type: 'data_source_id',
                data_source_id: provisioned.config.dataSourceId,
              },
              properties: {
                [titlePropertyName]: title(initialTitle),
                [cdcPropertyName]: { rich_text: [text(initialTitle)] },
              },
              markdown: initialBody,
            }),
          )
          pageId = page.id
          const livePageId = page.id
          await recorder.record({
            phase: 'create',
            objectId: livePageId,
            objectType: 'page',
            purpose: 'live-public-sqlite-cdc-row',
            cleanupState: 'created',
          })

          await runLiveCliCommand({
            env,
            argv: [
              'track',
              provisioned.config.dataSourceId,
              workspaceRoot,
              '--mode',
              'shared',
              '--no-materialize-bodies',
            ],
          })

          const replicaPath = cleanBreakSqlitePath({
            workspaceRoot,
            databaseId: provisioned.config.dataSourceId,
          })
          const syncArgv = ['sync', workspaceRoot]
          await runLiveCliCommand({ env, argv: syncArgv })
          // Materialized `.nmd` bodies land in the versioned per-source page
          // directory (`pages/v1/<source>`), not the flat workspace root (SM5b).
          const materializedBodyPath = join(
            workspaceRoot,
            'pages',
            'v1',
            provisioned.config.dataSourceId,
            `page-${livePageId}--${livePageId}.nmd`,
          )
          const materializedBody = await readFile(materializedBodyPath, 'utf8')
          expect(materializedBody).toContain(`Materialized through default live CLI`)
          expect(materializedBody).toContain(provisioned.config.runId)
          expect(materializedBody).not.toContain(
            'notion-datasource-sync body materialization placeholder',
          )
          const writeCellChange = () => {
            const db = new DatabaseSync(replicaPath)
            try {
              const propertyColumn = db
                .prepare(
                  `SELECT column_name
                   FROM schema_properties
                   WHERE property_id = ?`,
                )
                .get(cdcSchemaProperty.propertyId) as { readonly column_name: string } | undefined
              if (propertyColumn === undefined) {
                throw new Error('live public SQLite rows test did not project the CDC column')
              }
              db.prepare(
                `UPDATE pages
                 SET ${quoteSqlIdentifier(propertyColumn.column_name)} = ?
                 WHERE _page_id = ?`,
              ).run(updatedTitle, livePageId)
              expect(
                db
                  .prepare(
                    `SELECT status, value_json
                     FROM changes
                     WHERE page_id = ? AND property_id = ?`,
                  )
                  .get(livePageId, cdcSchemaProperty.propertyId),
              ).toMatchObject({
                status: 'pending',
                value_json: JSON.stringify({ _tag: 'rich_text', plainText: updatedTitle }),
              })
            } finally {
              db.close()
            }
          }
          writeCellChange()

          await runLiveCliCommand({ env, argv: syncArgv })
          const afterCell = await runLive(env, NotionPages.retrieve({ pageId: livePageId }))
          expect(livePropertyPlainText(afterCell.properties[cdcPropertyName])).toBe(updatedTitle)
          {
            const db = new DatabaseSync(replicaPath, { readOnly: true })
            try {
              const cellStatuses = db
                .prepare(
                  `SELECT status, unsupported_reason
                   FROM changes
                   WHERE page_id = ?
                   ORDER BY created_at`,
                )
                .all(livePageId)
              expect(cellStatuses, `cell CDC statuses: ${JSON.stringify(cellStatuses)}`).toEqual([
                expect.objectContaining({ status: 'applied' }),
              ])
            } finally {
              db.close()
            }
          }

          const remoteUpdatedTitle = `sqlite cdc remote ${provisioned.config.runId}`
          await runLive(
            env,
            NotionPages.update({
              pageId: livePageId,
              properties: {
                [cdcPropertyName]: { rich_text: [text(remoteUpdatedTitle)] },
              },
            }),
          )
          await runLiveCliCommand({ env, argv: syncArgv })
          {
            const db = new DatabaseSync(replicaPath, { readOnly: true })
            try {
              const propertyColumn = db
                .prepare(
                  `SELECT column_name
                   FROM schema_properties
                   WHERE property_id = ?`,
                )
                .get(cdcSchemaProperty.propertyId) as { readonly column_name: string } | undefined
              if (propertyColumn === undefined) {
                throw new Error('live public SQLite rows test did not project the CDC column')
              }
              expect(
                db
                  .prepare(
                    `SELECT ${quoteSqlIdentifier(propertyColumn.column_name)} AS value
                     FROM pages
                     WHERE _page_id = ?`,
                  )
                  .get(livePageId),
              ).toMatchObject({ value: remoteUpdatedTitle })
            } finally {
              db.close()
            }
          }
          await runLiveCliCommand({ env, argv: syncArgv })

          {
            const db = new DatabaseSync(replicaPath)
            try {
              db.prepare(`UPDATE pages SET _in_trash = 1 WHERE _page_id = ?`).run(livePageId)
              expect(
                db
                  .prepare(
                    `SELECT kind, status
                     FROM changes
                     WHERE page_id = ? AND kind = 'row_archive'`,
                  )
                  .get(livePageId),
              ).toMatchObject({ kind: 'row_archive', status: 'pending' })
            } finally {
              db.close()
            }
          }
          await runLiveCliCommand({ env, argv: syncArgv })
          const archived = await runLive(env, NotionPages.retrieve({ pageId: livePageId }))
          expect(archived.in_trash).toBe(true)
          await recorder.record({
            phase: 'mutate',
            objectId: livePageId,
            objectType: 'page',
            purpose: 'live-public-sqlite-cdc-archive',
            cleanupState: 'trashed',
          })

          // Archive applied end-to-end (local CDC toggle -> push -> remote
          // confirmed above). Restore-after-archive-sync is NOT exercised here:
          // an archived page leaves Notion's data-source query window, so the
          // next reprojection rebuilds the row without the archive and the local
          // replica reads `_in_trash = 0`. A `UPDATE pages SET _in_trash = 0` is
          // then a no-op and emits no `row_restore` intent. This is a tracked
          // fidelity gap (decision 0023: archived-row restore round
          // trip); the live gate asserts the observed behavior rather than a
          // contrived restore.
          {
            const db = new DatabaseSync(replicaPath)
            try {
              const beforeRestore = db
                .prepare(`SELECT _in_trash FROM pages WHERE _page_id = ?`)
                .get(livePageId) as { readonly _in_trash: number } | undefined
              expect(beforeRestore).toMatchObject({ _in_trash: 0 })
              db.prepare(`UPDATE pages SET _in_trash = 0 WHERE _page_id = ?`).run(livePageId)
              // No-op toggle: the archived row already reads as not-trashed, so no
              // restore intent is queued (F8: archived rows leave the projection
              // window and cannot be locally restored).
              expect(
                db
                  .prepare(
                    `SELECT kind, status
                     FROM changes
                     WHERE page_id = ? AND kind = 'row_restore'`,
                  )
                  .get(livePageId),
              ).toBeUndefined()
            } finally {
              db.close()
            }
          }
          {
            const db = new DatabaseSync(replicaPath, { readOnly: true })
            try {
              expect(
                db
                  .prepare(
                    `SELECT kind, status
                     FROM changes
                     WHERE page_id = ?
                     ORDER BY created_at`,
                  )
                  .all(livePageId),
              ).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({ kind: 'row_archive', status: 'applied' }),
                ]),
              )
            } finally {
              db.close()
            }
          }

          const createdTitle = `sqlite cdc created ${provisioned.config.runId}`
          {
            const db = new DatabaseSync(replicaPath)
            try {
              const createdColumns = db
                .prepare(
                  `SELECT property_id, column_name
                   FROM schema_properties
                   WHERE property_id IN (?, ?)`,
                )
                .all(
                  titleSchemaProperty.propertyId,
                  cdcSchemaProperty.propertyId,
                ) as unknown as ReadonlyArray<{
                readonly property_id: string
                readonly column_name: string
              }>
              const titleColumn = createdColumns.find(
                (column) => column.property_id === titleSchemaProperty.propertyId,
              )?.column_name
              const cdcColumn = createdColumns.find(
                (column) => column.property_id === cdcSchemaProperty.propertyId,
              )?.column_name
              if (titleColumn === undefined || cdcColumn === undefined) {
                throw new Error('live public SQLite rows create did not project required columns')
              }
              db.prepare(
                `INSERT INTO pages (
                   ${quoteSqlIdentifier(titleColumn)},
                   ${quoteSqlIdentifier(cdcColumn)},
                   _local_page_id,
                   _client_request_key
                 ) VALUES (?, ?, ?, ?)`,
              ).run(
                createdTitle,
                `created note ${provisioned.config.runId}`,
                `local-${provisioned.config.runId}`,
                `client-${provisioned.config.runId}`,
              )
              expect(
                db
                  .prepare(
                    `SELECT _sync_status
                     FROM pages
                     WHERE _local_page_id = ?`,
                  )
                  .get(`local-${provisioned.config.runId}`),
              ).toMatchObject({ _sync_status: 'pending' })
            } finally {
              db.close()
            }
          }
          await runLiveCliCommand({ env, argv: syncArgv })
          {
            const db = new DatabaseSync(replicaPath, { readOnly: true })
            try {
              const createRow = db
                .prepare(
                  `SELECT _sync_status, _page_id
                   FROM pages
                   WHERE _client_request_key = ?`,
                )
                .get(`client-${provisioned.config.runId}`) as
                | {
                    readonly _sync_status: string
                    readonly _page_id: string | null
                  }
                | undefined
              expect(createRow).toMatchObject({ _sync_status: 'applied' })
              if (createRow?._page_id === null || createRow?._page_id === undefined) {
                throw new Error('live public SQLite row create did not persist remote_page_id')
              }
              createdPageId = createRow._page_id
            } finally {
              db.close()
            }
          }
          await recorder.record({
            phase: 'create',
            objectId: createdPageId,
            objectType: 'page',
            purpose: 'live-public-sqlite-cdc-row-create',
            cleanupState: 'created',
          })
          const created = await runLive(env, NotionPages.retrieve({ pageId: createdPageId }))
          expect(livePropertyPlainText(created.properties[titlePropertyName])).toBe(createdTitle)
          await runLiveCliCommand({ env, argv: syncArgv })
          const createdRows = await runLive(
            env,
            NotionDatabases.query({
              dataSourceId: provisioned.config.dataSourceId,
              filter: {
                property: titlePropertyName,
                title: { equals: createdTitle },
              },
            }),
          )
          expect(createdRows.results).toHaveLength(1)

          {
            const db = new DatabaseSync(replicaPath, { readOnly: true })
            try {
              const pendingCdc = db
                .prepare(
                  `SELECT change_id, data_source_id, page_id
                   FROM changes
                   WHERE status IN ('pending', 'queued', 'planned')`,
                )
                .all() as unknown as ReadonlyArray<{
                readonly change_id: string
                readonly data_source_id: string
                readonly page_id: string | null
              }>
              expect(
                pendingCdc.every(
                  (row) =>
                    row.data_source_id === provisioned.config.dataSourceId &&
                    (row.page_id === null ||
                      row.page_id === livePageId ||
                      row.page_id === createdPageId),
                ),
              ).toBe(true)
              expect(pendingCdc).toHaveLength(0)
            } finally {
              db.close()
            }
          }
          {
            const db = new DatabaseSync(replicaPath, { readOnly: true })
            try {
              expect(
                db.prepare(`SELECT pending_local_changes FROM sync_status`).get(),
              ).toMatchObject({ pending_local_changes: 0 })
            } finally {
              db.close()
            }
          }

          await recorder.record({
            phase: 'verify',
            objectId: livePageId,
            objectType: 'page',
            purpose: 'live-public-sqlite-cdc-write',
            cleanupState: 'verified',
          })
        } finally {
          if (createdPageId !== undefined) {
            await runLive(
              env,
              NotionPages.update({ pageId: createdPageId, in_trash: true }).pipe(Effect.ignore),
            )
            await recorder.record({
              phase: 'trash',
              objectId: createdPageId,
              objectType: 'page',
              purpose: 'live-public-sqlite-cdc-row-create',
              cleanupState: 'verified-cleaned',
            })
          }
          if (pageId !== undefined) {
            await runLive(env, NotionPages.update({ pageId, in_trash: true }).pipe(Effect.ignore))
            await recorder.record({
              phase: 'trash',
              objectId: pageId,
              objectType: 'page',
              purpose: 'live-public-sqlite-cdc-row',
              cleanupState: 'verified-cleaned',
            })
          }
          await rm(workspaceRoot, { recursive: true, force: true })
          await provisioned.cleanup(recorder.current())
        }
      }, 240_000)

      it('proves one scratch row can sync property-only SQLite edits before a single .nmd body edit', async () => {
        if (processLiveConfig._tag !== 'configured') return

        const env = liveNotionEnvFromProcessEnv()
        const provisioned = await provisionLiveNotionDataSourceFixture({
          env,
          config: { ...processLiveConfig, dataSourceId: undefined },
        })
        const recorder = makeLedgerRecorder(env, provisioned.config, provisioned.ledger)
        const workspaceRoot = decode(
          AbsolutePath,
          await mkdtemp(join(tmpdir(), 'notion-ds-sync-live-bidi-body-')),
        )
        let pageId: string | undefined
        let controlPageId: string | undefined

        try {
          const initialDataSource = await runLive(
            env,
            NotionDataSources.retrieve({ dataSourceId: provisioned.config.dataSourceId }),
          )
          const titlePropertyName = liveTitlePropertyName(initialDataSource.properties)
          const replicaFileId = provisioned.config.dataSourceId
          const bidiPropertyName = 'Bidi Note'
          const patchedDataSource = await runLive(
            env,
            NotionDataSources.update({
              dataSourceId: provisioned.config.dataSourceId,
              properties: {
                [bidiPropertyName]: { rich_text: {} },
              },
            }),
          )
          await recorder.record({
            phase: 'mutate',
            objectId: provisioned.config.dataSourceId,
            objectType: 'data_source',
            purpose: 'live-combined-bidi-schema-fixture',
            cleanupState: 'mutated',
          })
          const notesSchemaProperty = liveSchemaProperty({
            properties: patchedDataSource.properties,
            name: bidiPropertyName,
            type: 'rich_text',
          })
          const initialTitle = `combined bidi row ${provisioned.config.runId}`
          const initialBody = `# Combined Bidi Body\n\nInitial body ${provisioned.config.runId}\n`
          const page = await runLive(
            env,
            NotionPages.create({
              parent: {
                type: 'data_source_id',
                data_source_id: provisioned.config.dataSourceId,
              },
              properties: {
                [titlePropertyName]: title(initialTitle),
                [bidiPropertyName]: { rich_text: [text('initial property note')] },
              },
              markdown: initialBody,
            }),
          )
          pageId = page.id
          await recorder.record({
            phase: 'create',
            objectId: pageId,
            objectType: 'page',
            purpose: 'live-combined-bidi-body-row',
            cleanupState: 'created',
          })
          const controlInitialTitle = `combined bidi control ${provisioned.config.runId}`
          const controlInitialBody = `# Combined Bidi Control\n\nControl body ${provisioned.config.runId}\n`
          const controlPage = await runLive(
            env,
            NotionPages.create({
              parent: {
                type: 'data_source_id',
                data_source_id: provisioned.config.dataSourceId,
              },
              properties: {
                [titlePropertyName]: title(controlInitialTitle),
                [bidiPropertyName]: { rich_text: [text('control property note')] },
              },
              markdown: controlInitialBody,
            }),
          )
          controlPageId = controlPage.id
          await recorder.record({
            phase: 'create',
            objectId: controlPageId,
            objectType: 'page',
            purpose: 'live-combined-bidi-control-row',
            cleanupState: 'created',
          })

          await runLiveCliCommand({
            env,
            argv: [
              'track',
              provisioned.config.dataSourceId,
              workspaceRoot,
              '--mode',
              'shared',
              '--no-materialize-bodies',
            ],
          })

          const replicaPath = cleanBreakSqlitePath({
            workspaceRoot,
            databaseId: replicaFileId,
          })
          expect(await listNmdFiles(workspaceRoot)).toHaveLength(0)
          expect(
            readReplicaHealth({
              replicaPath,
              statePath: cleanBreakStatePath({ workspaceRoot }),
            }),
          ).toMatchObject({
            conflictsOpen: 0,
            pendingLocalChanges: 0,
            pendingChanges: 0,
            openConflicts: 0,
            pendingOutbox: 0,
          })

          const controlBeforePropertyWatch = await runLive(
            env,
            NotionPages.retrieve({ pageId: controlPageId }),
          )
          const propertyOnlyNote = `property-only public sqlite ${provisioned.config.runId}`
          {
            const db = new DatabaseSync(replicaPath)
            try {
              const notesColumn = db
                .prepare(
                  `SELECT column_name
                   FROM schema_properties
                   WHERE property_id = ?`,
                )
                .get(notesSchemaProperty.propertyId) as { readonly column_name: string } | undefined
              if (notesColumn === undefined) {
                throw new Error('combined live bidi test did not project the note column')
              }
              db.prepare(
                `UPDATE pages
                 SET ${quoteSqlIdentifier(notesColumn.column_name)} = ?
                 WHERE _page_id = ?`,
              ).run(propertyOnlyNote, pageId)
              expect(
                db
                  .prepare(
                    `SELECT kind, status, value_json
                     FROM changes
                     WHERE page_id = ? AND property_id = ?`,
                  )
                  .get(pageId, notesSchemaProperty.propertyId),
              ).toMatchObject({
                kind: 'cell_patch',
                status: 'pending',
                value_json: JSON.stringify({ _tag: 'rich_text', plainText: propertyOnlyNote }),
              })
            } finally {
              db.close()
            }
          }

          const propertyWatch = await runLiveCliCommand({
            env,
            argv: [
              'sync',
              '--watch',
              workspaceRoot,
              '--max-cycles',
              '2',
              '--state',
              join(workspaceRoot, 'live-property-watch.json'),
              '--no-materialize-bodies',
            ],
          })
          expect(propertyWatch.status.state).toBe('clean')
          expect(propertyWatch.result).toMatchObject({
            _tag: 'WatchDaemonRunResult',
            cycles: 2,
            completed: 2,
          })
          const afterPropertyOnly = await runLive(env, NotionPages.retrieve({ pageId }))
          expect(livePropertyPlainText(afterPropertyOnly.properties[bidiPropertyName])).toBe(
            propertyOnlyNote,
          )
          const controlAfterPropertyWatch = await runLive(
            env,
            NotionPages.retrieve({ pageId: controlPageId }),
          )
          expect(controlAfterPropertyWatch.last_edited_time).toBe(
            controlBeforePropertyWatch.last_edited_time,
          )
          expect(
            livePropertyPlainText(controlAfterPropertyWatch.properties[bidiPropertyName]),
          ).toBe('control property note')
          expect(await listNmdFiles(workspaceRoot)).toHaveLength(0)
          expect(
            readReplicaHealth({
              replicaPath,
              statePath: cleanBreakStatePath({ workspaceRoot }),
            }),
          ).toMatchObject({
            conflictsOpen: 0,
            pendingLocalChanges: 0,
            pendingChanges: 0,
            openConflicts: 0,
            pendingOutbox: 0,
          })

          await recorder.record({
            phase: 'mutate',
            objectId: pageId,
            objectType: 'page',
            purpose: 'live-combined-bidi-property-only-sqlite',
            cleanupState: 'mutated',
          })

          await runLiveCliCommand({ env, argv: ['sync', workspaceRoot] })
          const nmdFiles = await listNmdFiles(workspaceRoot)
          expect(nmdFiles).toHaveLength(2)
          const nmdCandidates = await Promise.all(
            nmdFiles.map(async (path) => ({ path, content: await readFile(path, 'utf8') })),
          )
          const targetNmd = nmdCandidates.find((candidate) =>
            candidate.content.includes(`Initial body ${provisioned.config.runId}`),
          )
          const controlNmd = nmdCandidates.find((candidate) =>
            candidate.content.includes(`Control body ${provisioned.config.runId}`),
          )
          expect(controlNmd?.content).toContain(`Control body ${provisioned.config.runId}`)
          if (targetNmd === undefined) {
            throw new Error('combined live bidi test did not materialize the target .nmd file')
          }
          const nmdPath = targetNmd.path
          const currentNmd = targetNmd.content
          expect(currentNmd).toContain(`Initial body ${provisioned.config.runId}`)
          const localBodyEdit = `Updated body ${provisioned.config.runId}`
          await writeFile(
            nmdPath,
            currentNmd.replace(`Initial body ${provisioned.config.runId}`, localBodyEdit),
            'utf8',
          )

          await runLiveCliCommand({ env, argv: ['sync', workspaceRoot] })
          const remoteMarkdown = await runLive(env, NotionPages.getMarkdown({ pageId }))
          expect(remoteMarkdown.markdown).toContain(localBodyEdit)
          const beforeNoOpPage = await runLive(env, NotionPages.retrieve({ pageId }))
          expect(
            readReplicaHealth({
              replicaPath,
              statePath: cleanBreakStatePath({ workspaceRoot }),
            }),
          ).toMatchObject({
            conflictsOpen: 0,
            pendingLocalChanges: 0,
            pendingChanges: 0,
            openConflicts: 0,
            pendingOutbox: 0,
          })

          const noOpSync = await runLiveCliCommand({ env, argv: ['sync', workspaceRoot] })
          const afterNoOpPage = await runLive(env, NotionPages.retrieve({ pageId }))
          expect(afterNoOpPage.last_edited_time).toBe(beforeNoOpPage.last_edited_time)
          const controlAfterBodySync = await runLive(
            env,
            NotionPages.retrieve({ pageId: controlPageId }),
          )
          expect(controlAfterBodySync.last_edited_time).toBe(
            controlBeforePropertyWatch.last_edited_time,
          )
          expect(livePropertyPlainText(controlAfterBodySync.properties[bidiPropertyName])).toBe(
            'control property note',
          )
          const controlMarkdown = await runLive(
            env,
            NotionPages.getMarkdown({ pageId: controlPageId }),
          )
          expect(controlMarkdown.markdown).toContain(`Control body ${provisioned.config.runId}`)
          expect(noOpSync.status.state).toBe('clean')
          expect(noOpSync.status.counts.pending).toBe(0)
          expect(noOpSync.status.counts.conflict).toBe(0)
          expect(
            readReplicaHealth({
              replicaPath,
              statePath: cleanBreakStatePath({ workspaceRoot }),
            }),
          ).toMatchObject({
            conflictsOpen: 0,
            pendingLocalChanges: 0,
            pendingChanges: 0,
            openConflicts: 0,
            pendingOutbox: 0,
          })

          await recorder.record({
            phase: 'verify',
            objectId: pageId,
            objectType: 'page',
            purpose: 'live-combined-bidi-body-sync-clean',
            cleanupState: 'verified',
          })
        } finally {
          if (controlPageId !== undefined) {
            await runLive(env, NotionPages.archive({ pageId: controlPageId }).pipe(Effect.ignore))
            await recorder.record({
              phase: 'trash',
              objectId: controlPageId,
              objectType: 'page',
              purpose: 'live-combined-bidi-control-row',
              cleanupState: 'verified-cleaned',
            })
          }
          if (pageId !== undefined) {
            await runLive(env, NotionPages.archive({ pageId }).pipe(Effect.ignore))
            await recorder.record({
              phase: 'trash',
              objectId: pageId,
              objectType: 'page',
              purpose: 'live-combined-bidi-body-row',
              cleanupState: 'verified-cleaned',
            })
          }
          await rm(workspaceRoot, { recursive: true, force: true })
          await provisioned.cleanup(recorder.current())
        }
      }, 240_000)

      it('pushes a NotionMD body through the datasource-sync body adapter against live Notion', async () => {
        if (processLiveConfig._tag !== 'configured') return

        const env = liveNotionEnvFromProcessEnv()
        const recorder = makeLedgerRecorder(
          env,
          processLiveConfig,
          emptyLiveFixtureLedger(processLiveConfig),
        )
        let pageId: string | undefined

        try {
          const page = await runLive(
            env,
            NotionPages.create({
              parent: { type: 'page_id', page_id: processLiveConfig.parentPageId },
              properties: { title: title(`notion ds sync body ${processLiveConfig.runId}`) },
              markdown: '# Datasource Sync Body\n\nInitial body',
            }),
          )
          pageId = page.id
          await recorder.record({
            phase: 'create',
            objectId: pageId,
            objectType: 'page',
            purpose: 'live-notion-md-body-push',
            cleanupState: 'created',
          })

          const nextBody = `# Datasource Sync Body\n\nUpdated body ${processLiveConfig.runId}\n`
          await runLiveBody(
            env,
            Effect.gen(function* () {
              const body = yield* PageBodySyncPort
              const id = decode(PageId, page.id)
              const observed = yield* body.observe({ _tag: 'ObserveBodyInput', pageId: id })
              yield* body.push({
                _tag: 'BodyPushCommand',
                commandId: decode(CommandId, `${processLiveConfig.runId}:body:push`),
                pageId: id,
                baseBodyPointer: observed,
                nextBodyHash: sha256Hash(nextBody),
                localBodyPath: decode(WorkspaceRelativePath, `${page.id}.nmd`),
                localBodyContent: nextBody,
              })
            }),
          )

          const remote = await runLive(env, NotionPages.getMarkdown({ pageId }))
          expect(remote.markdown).toContain(`Updated body ${processLiveConfig.runId}`)
          await recorder.record({
            phase: 'mutate',
            objectId: pageId,
            objectType: 'page',
            purpose: 'live-notion-md-body-push',
            cleanupState: 'mutated',
          })
          await recorder.record({
            phase: 'verify',
            objectId: pageId,
            objectType: 'page',
            purpose: 'live-notion-md-body-push',
            cleanupState: 'verified',
          })
        } finally {
          if (pageId !== undefined) {
            await runLive(env, NotionPages.archive({ pageId }))
            await recorder.record({
              phase: 'trash',
              objectId: pageId,
              objectType: 'page',
              purpose: 'live-notion-md-body-push',
              cleanupState: 'verified-cleaned',
            })
          }
        }
      }, 120_000)

      it('paginates high-cardinality live page relation properties', async () => {
        if (processLiveConfig._tag !== 'configured') return

        const env = liveNotionEnvFromProcessEnv()
        const recorder = makeLedgerRecorder(
          env,
          processLiveConfig,
          emptyLiveFixtureLedger(processLiveConfig),
        )
        const workspaceRoot = decode(
          AbsolutePath,
          await mkdtemp(join(tmpdir(), 'notion-ds-sync-live-relation-cdc-')),
        )
        let targetDatabaseId: string | undefined
        let sourceDatabaseId: string | undefined

        try {
          const fixture = await runLive(
            env,
            Effect.gen(function* () {
              const targetDatabase = yield* NotionDatabases.create({
                parent: { type: 'page_id', page_id: processLiveConfig.parentPageId },
                title: [text(`notion ds sync relation target ${processLiveConfig.runId}`)],
                is_inline: true,
                properties: { Name: { title: {} } },
              })
              const targetDataSourceId = targetDatabase.data_sources?.[0]?.id ?? targetDatabase.id
              yield* Effect.sync(() => {
                targetDatabaseId = targetDatabase.id
              })
              const relatedPages = yield* Effect.forEach(
                Array.from({ length: 30 }, (_, index) => index),
                (index) =>
                  NotionPages.create({
                    parent: { type: 'data_source_id', data_source_id: targetDataSourceId },
                    properties: { Name: title(`Related ${index.toString().padStart(3, '0')}`) },
                  }),
                { concurrency: 4 },
              )
              const sourceDatabase = yield* NotionDatabases.create({
                parent: { type: 'page_id', page_id: processLiveConfig.parentPageId },
                title: [text(`notion ds sync relation source ${processLiveConfig.runId}`)],
                is_inline: true,
                properties: { Name: { title: {} } },
              })
              const sourceDataSourceId = sourceDatabase.data_sources?.[0]?.id ?? sourceDatabase.id
              yield* Effect.sync(() => {
                sourceDatabaseId = sourceDatabase.id
              })
              const sourceDataSource = yield* NotionDataSources.update({
                dataSourceId: sourceDataSourceId,
                properties: {
                  Related: {
                    relation: { data_source_id: targetDataSourceId, single_property: {} },
                  },
                },
              })
              const sourcePage = yield* NotionPages.create({
                parent: { type: 'data_source_id', data_source_id: sourceDataSourceId },
                properties: {
                  Name: title('High cardinality relation source'),
                  Related: {
                    relation: relatedPages.slice(0, 29).map((page) => ({ id: page.id })),
                  },
                },
              })
              const observedRelationTarget = relatedPages.at(29) ?? relatedPages.at(0)
              if (observedRelationTarget === undefined) {
                // Fixture invariant: we just created the target pages above, so an
                // empty list is an impossible setup defect, not an expected failure
                // (matches the surrounding `throw new Error` precondition style).
                return yield* Effect.die(new Error('relation fixture created no target pages'))
              }
              const observerPage = yield* NotionPages.create({
                parent: { type: 'data_source_id', data_source_id: sourceDataSourceId },
                properties: {
                  Name: title('High cardinality relation observer'),
                  Related: { relation: [{ id: observedRelationTarget.id }] },
                },
              })

              return {
                targetDatabase,
                targetDataSourceId,
                relatedPages,
                sourceDatabase,
                sourceDataSourceId,
                sourceDataSource,
                sourcePage,
                observerPage,
              }
            }),
          )
          await recorder.record({
            phase: 'create',
            objectId: fixture.sourceDatabase.id,
            objectType: 'database',
            purpose: 'live-page-property-pagination-source',
            cleanupState: 'created',
          })
          await recorder.record({
            phase: 'create',
            objectId: fixture.targetDatabase.id,
            objectType: 'database',
            purpose: 'live-page-property-pagination-target',
            cleanupState: 'created',
          })

          const relatedPropertyId = decode(
            PropertyId,
            propertyIdByName(fixture.sourceDataSource.properties, 'Related'),
          )
          if (env.token === undefined) {
            throw new Error('live page-property pagination test requires a token')
          }
          const token = env.token
          const pages = await Effect.runPromise(
            Effect.gen(function* () {
              /* Explicit ~3 rps throttle so this live path mirrors production pacing. */
              const withThrottle = yield* makeThrottledProvideClientEnv()
              const baseClient = makeNotionEffectClientGatewayClient(
                withThrottle(<A, E>(effect: Effect.Effect<A, E, NotionConfig | HttpClient>) =>
                  effect.pipe(Effect.provide(liveLayer(token))),
                ),
              )
              const gateway = makeNotionDataSourceGatewayFromClient({
                client: {
                  ...baseClient,
                  retrievePageProperty: (input) =>
                    baseClient.retrievePageProperty({ ...input, pageSize: 15 }),
                },
              })
              return yield* gateway
                .retrievePageProperty({
                  _tag: 'RetrievePagePropertyInput',
                  pageId: decode(PageId, fixture.sourcePage.id),
                  propertyId: relatedPropertyId,
                  startCursor: null,
                })
                .pipe(
                  Stream.runCollect,
                  Effect.map((chunk) => Array.from(chunk)),
                )
            }).pipe(Effect.scoped),
          )

          expect(pages.length).toBeGreaterThan(1)
          expect(pages.reduce((count, page) => count + page.items.length, 0)).toBe(29)
          expect(pages.at(0)?.hasMore).toBe(true)
          expect(pages.at(-1)?.hasMore).toBe(false)

          const titleSchemaProperty = liveSchemaProperty({
            properties: fixture.sourceDataSource.properties,
            name: 'Name',
            type: 'title',
          })
          const relationSchemaProperty = liveSchemaProperty({
            properties: fixture.sourceDataSource.properties,
            name: 'Related',
            type: 'relation',
          })
          const schemaPropertiesJson = JSON.stringify([titleSchemaProperty, relationSchemaProperty])
          await runLiveCliCommand({
            env,
            argv: [
              'track',
              fixture.sourceDataSourceId,
              workspaceRoot,
              '--mode',
              'shared',
              '--schema-properties-json',
              schemaPropertiesJson,
              '--no-materialize-bodies',
            ],
          })
          const replicaPath = cleanBreakSqlitePath({
            workspaceRoot,
            databaseId: fixture.sourceDataSourceId,
          })
          {
            const db = new DatabaseSync(replicaPath, { readOnly: true })
            try {
              expect(
                db
                  .prepare(
                    `SELECT property_name, property_type, is_scalar_read_supported, is_rows_write_supported
                     FROM schema_properties
                     WHERE property_id = ?`,
                  )
                  .get(relationSchemaProperty.propertyId),
              ).toMatchObject({
                property_name: 'Related',
                property_type: 'relation',
                is_scalar_read_supported: 0,
                is_rows_write_supported: 0,
              })
              expect(
                db.prepare(`SELECT pages, pending_local_changes FROM sync_status`).get(),
              ).toMatchObject({
                pages: 2,
                pending_local_changes: 0,
              })
            } finally {
              db.close()
            }
          }
          await recorder.record({
            phase: 'verify',
            objectId: fixture.sourcePage.id,
            objectType: 'page',
            purpose: 'live-page-property-pagination-relation-read',
            cleanupState: 'verified',
          })
        } finally {
          await rm(workspaceRoot, { recursive: true, force: true })
          if (sourceDatabaseId !== undefined) {
            await archiveDatabaseBestEffort(env, sourceDatabaseId)
            await recorder.record({
              phase: 'trash',
              objectId: sourceDatabaseId,
              objectType: 'database',
              purpose: 'live-page-property-pagination-source',
              cleanupState: 'verified-cleaned',
            })
          }
          if (targetDatabaseId !== undefined) {
            await archiveDatabaseBestEffort(env, targetDatabaseId)
            await recorder.record({
              phase: 'trash',
              objectId: targetDatabaseId,
              objectType: 'database',
              purpose: 'live-page-property-pagination-target',
              cleanupState: 'verified-cleaned',
            })
          }
        }
      }, 240_000)

      it('maps canonical query filters and high-watermarks to live mutated rows', async () => {
        if (processLiveConfig._tag !== 'configured') return

        const env = liveNotionEnvFromProcessEnv()
        const provisioned = await provisionLiveNotionDataSourceFixture({
          env,
          config: processLiveConfig,
        })
        const recorder = makeLedgerRecorder(env, provisioned.config, provisioned.ledger)

        try {
          const marker = `live-filter-${provisioned.config.runId}`
          const mutated = await runLive(
            env,
            Effect.gen(function* () {
              yield* NotionDataSources.update({
                dataSourceId: provisioned.config.dataSourceId,
                properties: {
                  Marker: { rich_text: {} },
                },
              })
              const beforeMutation = decode(
                Schema.DateTimeUtcFromString,
                new Date(Date.now() - 60_000).toISOString(),
              )
              const alpha = yield* NotionPages.create({
                parent: { type: 'data_source_id', data_source_id: provisioned.config.dataSourceId },
                properties: {
                  Name: title(`Alpha ${marker}`),
                  Marker: { rich_text: [text(`${marker}-include`)] },
                },
              })
              yield* NotionPages.create({
                parent: { type: 'data_source_id', data_source_id: provisioned.config.dataSourceId },
                properties: {
                  Name: title(`Beta ${marker}`),
                  Marker: { rich_text: [text(`${marker}-exclude`)] },
                },
              })
              const updatedAlpha = yield* NotionPages.update({
                pageId: alpha.id,
                properties: {
                  Marker: { rich_text: [text(`${marker}-include-mutated`)] },
                },
              })
              return { beforeMutation, updatedAlpha }
            }),
          )

          const rows = await runLiveGateway(
            env,
            Effect.gen(function* () {
              const gateway = yield* NotionDataSourceGateway
              return yield* gateway
                .queryRows({
                  _tag: 'QueryRowsInput',
                  dataSourceId: decode(DataSourceId, provisioned.config.dataSourceId),
                  queryContract: {
                    _tag: 'QueryContract',
                    apiVersion: '2026-03-11',
                    filter: {
                      _tag: 'property_value',
                      propertyId: decode(PropertyId, 'Marker'),
                      operator: 'contains',
                      value: { _tag: 'rich_text', plainText: `${marker}-include` },
                    },
                    sorts: [],
                    pageSize: 10,
                    highWatermark: mutated.beforeMutation,
                    membershipScope: 'explicit-filter',
                  },
                  startCursor: null,
                })
                .pipe(
                  Stream.runCollect,
                  Effect.map((chunk) => Array.from(chunk)),
                )
            }),
          )

          const pageIds = rows.flatMap((page) => page.rows.map((row) => row.pageId))
          expect(pageIds).toContain(decode(PageId, mutated.updatedAlpha.id))
          await recorder.record({
            phase: 'verify',
            objectId: mutated.updatedAlpha.id,
            objectType: 'page',
            purpose: 'live-query-filter-high-watermark-mutated-row',
            cleanupState: 'verified',
          })
        } finally {
          await provisioned.cleanup(recorder.current())
        }
      }, 180_000)

      it('runs a bounded live fixture soak with repeated row mutations and cleanup ledger evidence', async () => {
        if (processLiveConfig._tag !== 'configured') return

        const env = liveNotionEnvFromProcessEnv()
        const fixtureConfig = { ...processLiveConfig, dataSourceId: undefined }
        const provisioned = await provisionLiveNotionDataSourceFixture({
          env,
          config: fixtureConfig,
        })
        let ledger = provisioned.ledger

        try {
          ledger = await runLiveFixtureSoak({
            config: provisioned.config,
            client: makeLiveNotionFixtureLifecycleClient({ env, config: provisioned.config }),
            options: {
              scenarioName: 'NDS-LIVE-bounded-fixture-soak',
              cycles: 2,
              initialLedger: ledger,
              writeLedger: makeLiveFixtureLedgerWriter({ env, config: provisioned.config }),
            },
          })

          expect(ledger.entries).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                objectType: 'data_source',
                purpose: 'NDS-LIVE-bounded-fixture-soak:start:2-cycles',
                cleanupState: 'verified',
              }),
              expect.objectContaining({
                objectType: 'data_source',
                purpose: 'NDS-LIVE-bounded-fixture-soak:complete',
                cleanupState: 'verified-cleaned',
              }),
            ]),
          )
          expect(
            ledger.entries.filter(
              (entry) => entry.objectType === 'page' && entry.cleanupState === 'verified-cleaned',
            ).length,
          ).toBeGreaterThanOrEqual(2)
          expect(JSON.stringify(ledger)).not.toContain('NOTION_TOKEN')
          expect(JSON.stringify(ledger)).not.toContain('NOTION_API_TOKEN')
          expect(JSON.stringify(ledger)).not.toContain('op://')
        } finally {
          await provisioned.cleanup(ledger)
        }
      }, 180_000)
    },
  )

  it('records create, mutate, verify, trash, and restore fixture lifecycle phases with an injected client', async () => {
    const configured = {
      _tag: 'configured' as const,
      runId: 'notion-ds-sync-fixture-lifecycle-test',
      parentPageId: '00000000000000000000000000000001',
      dataSourceId: '00000000000000000000000000000002',
      notionVersion: '2026-03-11' as const,
      requiredCapabilities: defaultLivePreflightCapabilities,
      ledgerPath: 'tmp/notion-datasource-sync-live/fixture-lifecycle-test.json',
    }
    const calls: string[] = []
    const ledgers: LiveFixtureLedger[] = []
    const client: LiveFixtureLifecycleClient = {
      create: async () => {
        calls.push('create')
        return {
          objectId: 'fixture-page-1',
          objectType: 'page',
          purpose: 'fixture-lifecycle',
        }
      },
      mutate: async (fixture) => {
        calls.push('mutate')
        return fixture
      },
      verify: async () => {
        calls.push('verify')
      },
      trash: async () => {
        calls.push('trash')
      },
      restore: async () => {
        calls.push('restore')
      },
    }

    const ledger = await runLiveFixtureLifecycle({
      config: configured,
      client,
      options: {
        writeLedger: async ({ ledger: writtenLedger }) => {
          ledgers.push(writtenLedger)
        },
      },
    })

    expect(calls).toEqual(['create', 'mutate', 'verify', 'trash', 'restore', 'trash'])
    expect(ledger.entries.map((entry) => entry.phase)).toEqual([
      'create',
      'mutate',
      'verify',
      'trash',
      'restore',
      'trash',
    ])
    expect(ledger.entries.at(-1)).toMatchObject({ cleanupState: 'verified-cleaned' })
    expect(ledgers.at(-1)).toEqual(ledger)
  })

  it('records bounded soak lifecycle phases with an injected client', async () => {
    const configured = {
      _tag: 'configured' as const,
      runId: 'notion-ds-sync-fixture-soak-test',
      parentPageId: '00000000000000000000000000000001',
      dataSourceId: '00000000000000000000000000000002',
      notionVersion: '2026-03-11' as const,
      requiredCapabilities: defaultLivePreflightCapabilities,
      ledgerPath: 'tmp/notion-datasource-sync-live/fixture-soak-test.json',
    }
    const createdPages: string[] = []
    const ledgers: LiveFixtureLedger[] = []
    const client: LiveFixtureLifecycleClient = {
      create: async () => {
        const objectId = `fixture-page-${(createdPages.length + 1).toString()}`
        createdPages.push(objectId)
        return {
          objectId,
          objectType: 'page',
          purpose: 'fixture-soak',
        }
      },
      mutate: async (fixture) => fixture,
      verify: async () => {},
      trash: async () => {},
      restore: async () => {},
    }

    const ledger = await runLiveFixtureSoak({
      config: configured,
      client,
      options: {
        scenarioName: 'NDS-LIVE-bounded-fixture-soak',
        cycles: 2,
        writeLedger: async ({ ledger: writtenLedger }) => {
          ledgers.push(writtenLedger)
        },
      },
    })

    expect(createdPages).toEqual(['fixture-page-1', 'fixture-page-2'])
    expect(ledger.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectType: 'data_source',
          purpose: 'NDS-LIVE-bounded-fixture-soak:start:2-cycles',
          cleanupState: 'verified',
        }),
        expect.objectContaining({
          objectType: 'data_source',
          purpose: 'NDS-LIVE-bounded-fixture-soak:cycle:1',
          cleanupState: 'verified',
        }),
        expect.objectContaining({
          objectType: 'data_source',
          purpose: 'NDS-LIVE-bounded-fixture-soak:cycle:2',
          cleanupState: 'verified',
        }),
        expect.objectContaining({
          objectType: 'data_source',
          purpose: 'NDS-LIVE-bounded-fixture-soak:complete',
          cleanupState: 'verified-cleaned',
        }),
      ]),
    )
    expect(
      ledger.entries.filter(
        (entry) => entry.objectType === 'page' && entry.cleanupState === 'verified-cleaned',
      ),
    ).toHaveLength(2)
    expect(ledgers.at(-1)).toEqual(ledger)
  })

  it('replays the cleanup ledger and resumes only unverified fixture cleanup locally', async () => {
    const configured = {
      _tag: 'configured' as const,
      runId: 'notion-ds-sync-fixture-resume-test',
      parentPageId: '00000000000000000000000000000001',
      dataSourceId: '00000000000000000000000000000002',
      notionVersion: '2026-03-11' as const,
      requiredCapabilities: defaultLivePreflightCapabilities,
      ledgerPath: 'tmp/notion-datasource-sync-live/fixture-resume-test.json',
    }
    const initialLedger: LiveFixtureLedger = {
      ...emptyLiveFixtureLedger(configured),
      entries: [
        ledgerEntry({
          phase: 'create',
          objectId: 'fixture-page-cleaned',
          objectType: 'page',
          purpose: 'already-cleaned',
          cleanupState: 'created',
        }),
        ledgerEntry({
          phase: 'trash',
          objectId: 'fixture-page-cleaned',
          objectType: 'page',
          purpose: 'already-cleaned',
          cleanupState: 'verified-cleaned',
        }),
        ledgerEntry({
          phase: 'mutate',
          objectId: 'fixture-page-pending',
          objectType: 'page',
          purpose: 'pending-page-cleanup',
          cleanupState: 'mutated',
        }),
        ledgerEntry({
          phase: 'trash',
          objectId: 'fixture-database-retry',
          objectType: 'database',
          purpose: 'retry-database-cleanup',
          cleanupState: 'cleanup-failed',
        }),
      ],
    }
    const trashed: string[] = []
    const writes: LiveFixtureLedger[] = []

    const resumedLedger = await resumeLiveFixtureCleanupFromLedger({
      config: configured,
      ledger: initialLedger,
      trash: async (target) => {
        trashed.push(`${target.objectType}:${target.objectId}:${target.cleanupState}`)
      },
      writeLedger: async ({ ledger }) => {
        writes.push(ledger)
      },
    })

    expect(trashed).toEqual([
      'page:fixture-page-pending:mutated',
      'database:fixture-database-retry:cleanup-failed',
    ])
    expect(resumedLedger.entries.slice(-2)).toEqual([
      ledgerEntry({
        phase: 'trash',
        objectId: 'fixture-page-pending',
        objectType: 'page',
        purpose: 'pending-page-cleanup',
        cleanupState: 'verified-cleaned',
      }),
      ledgerEntry({
        phase: 'trash',
        objectId: 'fixture-database-retry',
        objectType: 'database',
        purpose: 'retry-database-cleanup',
        cleanupState: 'verified-cleaned',
      }),
    ])
    expect(writes.at(-1)).toEqual(resumedLedger)
  })

  it('keeps the local JSON ledger artifact when using the default writer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-live-ledger-'))
    const path = join(dir, 'ledger.json')
    const configured = {
      _tag: 'configured' as const,
      runId: 'notion-ds-sync-local-ledger-writer-test',
      parentPageId: '00000000000000000000000000000001',
      dataSourceId: '00000000000000000000000000000002',
      notionVersion: '2026-03-11' as const,
      requiredCapabilities: defaultLivePreflightCapabilities,
      ledgerPath: path,
      e2eLedgerPageId: undefined,
      demoPageId: undefined,
    }
    const ledger = {
      ...emptyLiveFixtureLedger(configured),
      entries: [
        ledgerEntry({
          phase: 'preflight',
          objectId: configured.dataSourceId,
          objectType: 'data_source',
          purpose: 'local-ledger-artifact-test',
          cleanupState: 'verified-cleaned',
        }),
      ],
    }

    try {
      await makeLiveFixtureLedgerWriter({
        env: {
          enabled: true,
          token: 'ntn_realistic_token_shape',
          tokenSource: 'NOTION_API_TOKEN',
          parentPageId: configured.parentPageId,
          dataSourceId: configured.dataSourceId,
          e2eLedgerPageId: undefined,
          demoPageId: undefined,
          requiredCapabilities: undefined,
          ledgerPath: path,
        },
        config: configured,
      })({ path, ledger })

      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(ledger)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('publishes a sanitized visible ledger page when configured', async () => {
    const configured = {
      _tag: 'configured' as const,
      runId: 'notion-ds-sync-visible-ledger-writer-test',
      parentPageId: '00000000000000000000000000000001',
      dataSourceId: '00000000000000000000000000000002',
      notionVersion: '2026-03-11' as const,
      requiredCapabilities: defaultLivePreflightCapabilities,
      ledgerPath: 'tmp/notion-datasource-sync-live/visible-ledger-writer-test.json',
      e2eLedgerPageId: '00000000000000000000000000000003',
      demoPageId: '36cf141b18dc803b98ebd21f2a243453',
    }
    const ledger = {
      ...emptyLiveFixtureLedger(configured),
      entries: [
        ledgerEntry({
          phase: 'trash',
          objectId: '00000000000000000000000000000004',
          objectType: 'page',
          purpose: 'visible-ledger-writer-test',
          cleanupState: 'verified-cleaned',
        }),
      ],
    }
    const localWrites: LiveFixtureLedger[] = []
    const published: Array<{ readonly pageId: string; readonly markdown: string }> = []

    await makeLiveFixtureLedgerWriter({
      env: {
        enabled: true,
        token: 'ntn_super_secret_token_value',
        tokenSource: 'NOTION_API_TOKEN',
        parentPageId: configured.parentPageId,
        dataSourceId: configured.dataSourceId,
        e2eLedgerPageId: configured.e2eLedgerPageId,
        demoPageId: configured.demoPageId,
        requiredCapabilities: undefined,
        ledgerPath: configured.ledgerPath,
      },
      config: configured,
      writeLocalLedger: async ({ ledger: writtenLedger }) => {
        localWrites.push(writtenLedger)
      },
      publishLedger: async (entry) => {
        published.push(entry)
      },
    })({ path: configured.ledgerPath, ledger })

    expect(localWrites).toEqual([ledger])
    expect(published).toHaveLength(1)
    expect(published.at(0)).toMatchObject({ pageId: configured.e2eLedgerPageId })
    expect(published.at(0)?.markdown).toContain('<!-- notion-datasource-sync:e2e-ledger:start -->')
    expect(published.at(0)?.markdown).toContain('<!-- notion-datasource-sync:e2e-ledger:end -->')
    expect(published.at(0)?.markdown).toContain('# notion datasource sync e2e run ledger')
    expect(published.at(0)?.markdown).toContain('page-1')
    expect(published.at(0)?.markdown).not.toContain('36cf141b18dc803b98ebd21f2a243453')
    expect(published.at(0)?.markdown).not.toContain(configured.ledgerPath)
    expect(published.at(0)?.markdown).not.toContain('ntn_super_secret_token_value')
    expect(published.at(0)?.markdown).not.toContain('NOTION_API_TOKEN')
  })

  it('cleans up the injected live fixture and records the ledger when verification fails', async () => {
    const configured = {
      _tag: 'configured' as const,
      runId: 'notion-ds-sync-fixture-failure-cleanup-test',
      parentPageId: '00000000000000000000000000000001',
      dataSourceId: '00000000000000000000000000000002',
      notionVersion: '2026-03-11' as const,
      requiredCapabilities: defaultLivePreflightCapabilities,
      ledgerPath: 'tmp/notion-datasource-sync-live/fixture-failure-cleanup-test.json',
    }
    const calls: string[] = []
    const ledgers: LiveFixtureLedger[] = []
    const client: LiveFixtureLifecycleClient = {
      create: async () => {
        calls.push('create')
        return {
          objectId: 'fixture-page-1',
          objectType: 'page',
          purpose: 'fixture-failure-cleanup',
        }
      },
      mutate: async (fixture) => {
        calls.push('mutate')
        return fixture
      },
      verify: async () => {
        calls.push('verify')
        throw new Error('forced fixture verification failure')
      },
      trash: async () => {
        calls.push('trash')
      },
      restore: async () => {
        calls.push('restore')
      },
    }

    await expect(
      runLiveFixtureLifecycle({
        config: configured,
        client,
        options: {
          writeLedger: async ({ ledger: writtenLedger }) => {
            ledgers.push(writtenLedger)
          },
        },
      }),
    ).rejects.toThrow('forced fixture verification failure')

    expect(calls).toEqual(['create', 'mutate', 'verify', 'trash'])
    expect(ledgers.at(-1)?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'trash', cleanupState: 'verified-cleaned' }),
      ]),
    )
  })

  it.each([
    { cleanupPhase: 'trash' as const, expectedCalls: ['create', 'mutate', 'verify', 'trash'] },
    {
      cleanupPhase: 'restore' as const,
      expectedCalls: ['create', 'mutate', 'verify', 'trash', 'restore'],
    },
    {
      cleanupPhase: 'final-trash' as const,
      expectedCalls: ['create', 'mutate', 'verify', 'trash', 'restore', 'trash'],
    },
  ])(
    'fails closed and preserves ledger evidence when fixture $cleanupPhase cleanup fails',
    async ({ cleanupPhase, expectedCalls }) => {
      const configured = {
        _tag: 'configured' as const,
        runId: `notion-ds-sync-fixture-${cleanupPhase}-cleanup-failure-test`,
        parentPageId: '00000000000000000000000000000001',
        dataSourceId: '00000000000000000000000000000002',
        notionVersion: '2026-03-11' as const,
        requiredCapabilities: defaultLivePreflightCapabilities,
        ledgerPath: `tmp/notion-datasource-sync-live/fixture-${cleanupPhase}-cleanup-failure-test.json`,
      }
      const calls: string[] = []
      let trashCalls = 0
      const ledgers: LiveFixtureLedger[] = []
      const client: LiveFixtureLifecycleClient = {
        create: async () => {
          calls.push('create')
          return {
            objectId: 'fixture-page-1',
            objectType: 'page',
            purpose: `fixture-${cleanupPhase}-cleanup-failure`,
          }
        },
        mutate: async (fixture) => {
          calls.push('mutate')
          return fixture
        },
        verify: async () => {
          calls.push('verify')
        },
        trash: async () => {
          calls.push('trash')
          trashCalls += 1
          if (cleanupPhase === 'trash' || (cleanupPhase === 'final-trash' && trashCalls === 2)) {
            throw new Error('forced fixture trash cleanup failure')
          }
        },
        restore: async () => {
          calls.push('restore')
          if (cleanupPhase === 'restore') {
            throw new Error('forced fixture restore cleanup failure')
          }
        },
      }

      let failure: unknown
      try {
        await runLiveFixtureLifecycle({
          config: configured,
          client,
          options: {
            writeLedger: async ({ ledger: writtenLedger }) => {
              ledgers.push(writtenLedger)
            },
          },
        })
      } catch (cause) {
        failure = cause
      }

      expect(failure).toBeInstanceOf(LiveFixtureCleanupError)
      const expectedFailurePhase = cleanupPhase === 'final-trash' ? 'trash' : cleanupPhase
      expect(failure).toMatchObject({
        phase: expectedFailurePhase,
        ledger: ledgers.at(-1),
        message: `live fixture cleanup failed during ${expectedFailurePhase}`,
      })
      expect(calls).toEqual(expectedCalls)
      expect(ledgers.at(-1)?.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ phase: 'verify', cleanupState: 'verified' }),
          expect.objectContaining({
            phase: cleanupPhase === 'final-trash' ? 'trash' : cleanupPhase,
            cleanupState: 'cleanup-failed',
          }),
        ]),
      )
      if (cleanupPhase === 'restore' || cleanupPhase === 'final-trash') {
        expect(ledgers.at(-1)?.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ phase: 'trash', cleanupState: 'trashed' }),
          ]),
        )
      }
    },
  )

  describe.skipIf(
    processLiveConfig._tag !== 'configured' || processLiveConfig.demoPageId === undefined,
  )('credentialed automated demo showcase', () => {
    it('refreshes the visible demo page with a datasource-sync showcase', async () => {
      if (processLiveConfig._tag !== 'configured' || processLiveConfig.demoPageId === undefined) {
        return
      }

      const env = liveNotionEnvFromProcessEnv()
      const result = await runLiveNotionDemoShowcase({ env, config: processLiveConfig })

      expect(result.demoPageId).toBe(processLiveConfig.demoPageId)
      expect(result.dataSources.map((dataSource) => dataSource.key)).toEqual([
        'projects',
        'incidents',
        'customers',
        'activity',
      ])
      expect(result.dataSources.map((dataSource) => dataSource.rowIds.length)).toEqual([
        12, 30, 48, 500,
      ])
      expect(
        result.dataSources.find((dataSource) => dataSource.key === 'activity')?.observation.pages,
      ).toBeGreaterThanOrEqual(10)
      expect(result.observation.pages).toBeGreaterThanOrEqual(20)
      expect(result.observation.rows).toBeGreaterThanOrEqual(700)
      expect(result.observation.materializedBodies).toBe(12)
      expect(result.observation.observedProperties).toBe(90)
      expect(result.observation.incompleteProperties).toBe(0)

      const markdown = await runLive(
        env,
        NotionPages.getMarkdown({ pageId: processLiveConfig.demoPageId }),
      )
      expect(markdown.markdown).toContain('notion datasource sync automated demo')
      expect(markdown.markdown).toContain('Verification summary')
      expect(markdown.markdown).toContain('Data source matrix')
      expect(markdown.markdown).toContain('notion datasource sync demo projects')
      expect(markdown.markdown).toContain('notion datasource sync demo incidents')
      expect(markdown.markdown).toContain('notion datasource sync demo customers')
      expect(markdown.markdown).toContain('notion datasource sync demo activity events')
      expect(markdown.markdown).toContain('500 rows')
      expect(markdown.markdown).toContain('Metadata proof')
      expect(markdown.markdown).toContain(result.runId)
      for (const dataSource of result.dataSources) {
        expect(markdown.markdown).toContain(dataSource.dataSourceId)
        expect(markdown.markdown).toContain(dataSource.description)
      }
      expect(markdown.markdown).not.toContain(env.token ?? 'token-not-configured')
      expect(markdown.markdown).not.toContain('NOTION_API_TOKEN')
      expect(markdown.markdown).not.toContain('op://')

      const remoteCounts = await Promise.all(
        result.dataSources.map(async (dataSource) => {
          const remote = await runLive(
            env,
            NotionDataSources.retrieve({ dataSourceId: dataSource.dataSourceId }),
          )
          const rowCount = await runLive(
            env,
            NotionDatabases.queryStream({
              dataSourceId: dataSource.dataSourceId,
              pageSize: 100,
            }).pipe(
              Stream.runCollect,
              Effect.map((rows) => rows.length),
            ),
          )
          return {
            title: remote.title?.map((part) => part.plain_text ?? '').join('') ?? '',
            description: remote.description?.map((part) => part.plain_text ?? '').join('') ?? '',
            propertyNames: Object.keys(remote.properties),
            rowCount,
          }
        }),
      )
      expect(remoteCounts.map((remote) => remote.rowCount)).toEqual([12, 30, 48, 500])
      expect(remoteCounts.map((remote) => remote.title)).toEqual([
        'notion datasource sync demo projects',
        'notion datasource sync demo incidents',
        'notion datasource sync demo customers',
        'notion datasource sync demo activity events',
      ])
      expect(remoteCounts.map((remote) => remote.description)).toEqual(
        result.dataSources.map((dataSource) => dataSource.description),
      )
      expect(remoteCounts[0]?.propertyNames).toEqual(
        expect.arrayContaining([
          'Name',
          'State',
          'Budget',
          'Strategic',
          'Kickoff',
          'Teams',
          'Summary',
          'Brief',
        ]),
      )
      expect(remoteCounts[1]?.propertyNames).toEqual(
        expect.arrayContaining([
          'Name',
          'Severity',
          'Open',
          'Started',
          'Impact',
          'Systems',
          'Notes',
        ]),
      )
      expect(remoteCounts[2]?.propertyNames).toEqual(
        expect.arrayContaining([
          'Name',
          'Plan',
          'ARR',
          'Renewal',
          'Contacted',
          'Regions',
          'Health',
          'Email',
          'Phone',
        ]),
      )
      expect(remoteCounts[3]?.propertyNames).toEqual(
        expect.arrayContaining([
          'Name',
          'Segment',
          'Sequence',
          'Automated',
          'EventDate',
          'Labels',
          'Payload',
        ]),
      )
    }, 1_200_000)
  })

  it('defines a sanitized cleanup ledger shape without exposing secrets', () => {
    const configured =
      processLiveConfig._tag === 'configured'
        ? processLiveConfig
        : {
            _tag: 'configured' as const,
            runId: 'notion-ds-sync-test-run',
            parentPageId: 'parent-page-id',
            dataSourceId: 'data-source-id',
            notionVersion: '2026-03-11' as const,
            requiredCapabilities: [
              'data_source_retrieve',
              'data_source_query',
              'page_retrieve',
            ] as const,
            ledgerPath: 'tmp/notion-datasource-sync-live/notion-ds-sync-test-run.json',
          }
    const ledger = {
      ...emptyLiveFixtureLedger(configured),
      entries: [
        ledgerEntry({
          phase: 'create',
          objectId: 'page-id-1',
          objectType: 'page',
          purpose: 'capability-preflight-fixture',
        }),
      ],
    }

    expect(ledger).toEqual({
      runId: configured.runId,
      notionVersion: '2026-03-11',
      entries: [
        {
          phase: 'create',
          objectId: 'page-id-1',
          objectType: 'page',
          purpose: 'capability-preflight-fixture',
          cleanupState: 'created',
        },
      ],
    })
    expect(JSON.stringify(ledger)).not.toContain('NOTION_TOKEN')
  })
})
