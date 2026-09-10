/**
 * Reusable fixture + surface-snapshot harness for the dry-run suppression proofs
 * (CLI-R02). Shared by the one-shot proof (SM5.2,
 * `src/e2e/dry-run-suppression.e2e.test.ts`) and the watch-loop proof (SM5.3,
 * `src/e2e/watch-dry-run.e2e.test.ts`).
 *
 * The fixture establishes a REAL file-backed split workspace (`track --mode
 * shared`): the hidden control-plane `.notion/v1/state.sqlite`, the public
 * `data/v1/<source>.sqlite`, and (when materialized) `pages/v1/<source>/*.nmd` +
 * the `.notion/v1/objects` store. `captureWorkspaceSurfaces` takes a LOGICAL
 * snapshot of all seven CLI-R02 surfaces so a dry-run can be proven to leave
 * every one of them unchanged.
 *
 * Lives in `src/testing` (NOT a `.test.ts`) so multiple test files can import it
 * without re-registering each other's `describe` blocks.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Effect, Option, Schema } from 'effect'

import type { NmdFrontmatterV2 } from '@overeng/notion-effect-client'
import { renderNmdFile } from '@overeng/notion-md'

import {
  parseCliCommand,
  parseCliContext,
  resolveCliCommandNotionRefs,
  runCliCommandWithRuntime,
} from '../cli/main.ts'
import { PagePropertyItemPage } from '../core/commands.ts'
import {
  AbsolutePath,
  PropertyId,
  PropertyName,
  type AbsolutePath as AbsolutePathType,
  type DataSourceSnapshot,
} from '../core/domain.ts'
import { SyncRootId, type SyncRootId as SyncRootIdType } from '../core/events.ts'
import type { NotionGatewayClient } from '../gateway/notion.ts'
import {
  dataFilePath,
  objectsDir,
  pagesDirRelativePath,
  stateSqlitePath,
} from '../local/manifest.ts'
import { readPendingReplicaChanges } from '../replica/replica.ts'
import { openNotionSyncStore } from '../store/store.ts'
import { decode, fixedObservedAt, hash, makeFakeGatewayHarness, testIds } from './harness.ts'

/** A Notion database URL whose 32-hex id resolves to `testIds.dataSourceId` during `track`. */
export const dryRunWorkspaceDatabaseUrl =
  'https://www.notion.so/example/0123456789abcdef0123456789abcdef?v=feedfacefeedfacefeedfacefeedface'

/** The shared `select` property exercised across both dry-run proofs. */
export const dryRunSelectProp = decode({ schema: PropertyId, value: 'p-priority' })
/** Human-readable name of the shared `select` property (the SQLite `pages` column). */
export const dryRunSelectPropName = 'Priority'

/** The CLI root id for `testIds.dataSourceId` (`data-source:<id>`). */
export const dryRunWorkspaceRootId: SyncRootIdType = decode({
  schema: SyncRootId,
  value: `data-source:${testIds.dataSourceId}`,
})

/** A single page-property page seeding the tracked page's `select` value. */
export const dryRunPropertyPage = (plainText: string) =>
  decode({
    schema: PagePropertyItemPage,
    value: {
      _tag: 'PagePropertyItemPage',
      apiVersion: '2026-03-11',
      requestId: testIds.requestId,
      pageId: testIds.pageId,
      propertyId: dryRunSelectProp,
      items: [
        {
          _tag: 'PagePropertyItem',
          pageId: testIds.pageId,
          propertyId: dryRunSelectProp,
          itemHash: hash(`item-${plainText}`),
          valueHash: hash(`value-${plainText}`),
          valueJson: JSON.stringify({ _tag: 'title', plainText }),
        },
      ],
      nextCursor: null,
      hasMore: false,
    },
  })

/** Notion client used only to resolve the database URL to a data source during `track`. */
export const dryRunDatabaseResolverClient = (): NotionGatewayClient => ({
  retrieveDataSource: () => Effect.succeed({ id: testIds.dataSourceId, properties: {} }),
  queryDataSource: () => Effect.succeed({ results: [], nextCursor: Option.none(), hasMore: false }),
  retrievePage: () =>
    Effect.succeed({
      id: testIds.pageId,
      parent: { type: 'data_source_id', data_source_id: testIds.dataSourceId },
      properties: {},
      last_edited_time: fixedObservedAt,
      in_trash: false,
    }),
  retrievePageProperty: () =>
    Effect.succeed({ results: [], nextCursor: Option.none(), hasMore: false }),
  retrieveDatabase: () =>
    Effect.succeed({
      id: testIds.databaseId,
      title: [],
      description: [],
      icon: null,
      data_sources: [{ id: testIds.dataSourceId, name: 'Rows' }],
    }),
  updatePage: () =>
    Effect.succeed({
      id: testIds.pageId,
      parent: { type: 'data_source_id', data_source_id: testIds.dataSourceId },
      properties: {},
      last_edited_time: fixedObservedAt,
      in_trash: false,
    }),
  createPage: () =>
    Effect.succeed({
      id: 'created-page',
      parent: { type: 'data_source_id', data_source_id: testIds.dataSourceId },
      properties: {},
      last_edited_time: fixedObservedAt,
      in_trash: false,
    }),
  updateDataSource: () => Effect.succeed({ id: testIds.dataSourceId, properties: {} }),
  updateDatabase: () =>
    Effect.succeed({ id: testIds.databaseId, title: [], description: [], icon: null }),
})

const dryRunSchemaPropertiesJson = [
  {
    propertyId: dryRunSelectProp,
    name: dryRunSelectPropName,
    type: 'select',
    configHash: hash('c-select'),
    writeClass: 'writable',
    ordinal: 0,
    configJson: JSON.stringify({
      id: dryRunSelectProp,
      name: dryRunSelectPropName,
      type: 'select',
      select: {
        options: [
          { id: 'hi', name: 'High', color: 'red' },
          { id: 'lo', name: 'Low', color: 'green' },
        ],
      },
    }),
  },
] as const

/**
 * A `DataSourceSnapshot` whose schema carries the writable `select` property, so
 * a re-observation projects it and a local edit reaches a clean
 * `PatchPageProperties` write rather than being blocked by `CurrentSurfaceMissing`.
 * Pass it as the `dataSource` to `makeFakeGatewayHarness` for the sync/watch step.
 */
export const dryRunSyncDataSource = (): DataSourceSnapshot => ({
  _tag: 'DataSourceSnapshot',
  dataSourceId: testIds.dataSourceId,
  parentDatabaseId: testIds.databaseId,
  requestId: testIds.requestId,
  observedAt: decode({ schema: Schema.DateTimeUtcFromString, value: fixedObservedAt }),
  schemaHash: hash('schema'),
  schemaProperties: [
    {
      _tag: 'DataSourcePropertySnapshot',
      propertyId: dryRunSelectProp,
      name: decode({ schema: PropertyName, value: dryRunSelectPropName }),
      type: 'select',
      configHash: hash('c-select'),
      writeClass: 'writable',
      ordinal: 0,
      configJson: JSON.stringify({ type: 'select' }),
    },
  ],
  metadataHash: hash('metadata'),
  metadataJson: JSON.stringify({
    _tag: 'CanonicalDataSourceMetadata',
    titlePlainText: 'DS',
    descriptionPlainText: '',
    icon: { _tag: 'none' },
  }),
  metadataTitlePlainText: 'DS',
  metadataDescriptionPlainText: '',
})

/** Create a fresh temp directory and return it as an `AbsolutePath` workspace root. */
export const makeDryRunWorkspace = async (prefix: string): Promise<AbsolutePathType> => {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  return decode({ schema: AbsolutePath, value: dir })
}

/** Establish a tracked workspace under the given authority mode with a real file-backed split store. */
export const establishWorkspaceWithMode = async ({
  workspace,
  mode,
}: {
  readonly workspace: AbsolutePathType
  readonly mode: 'local' | 'remote' | 'shared'
}): Promise<void> => {
  const gateway = makeFakeGatewayHarness({ propertyPages: [dryRunPropertyPage('init')] })
  const gatewayClient = dryRunDatabaseResolverClient()
  const argv = [
    'track',
    dryRunWorkspaceDatabaseUrl,
    workspace,
    '--mode',
    mode,
    '--schema-properties-json',
    JSON.stringify(dryRunSchemaPropertiesJson),
    '--no-materialize-bodies',
  ] as readonly string[]
  const command = await Effect.runPromise(
    resolveCliCommandNotionRefs({ command: parseCliCommand(argv), options: { gatewayClient } }),
  )
  const context = parseCliContext({ argv, resolvedCommand: command })
  try {
    await Effect.runPromise(
      runCliCommandWithRuntime({
        command,
        context,
        options: { gateway: gateway.gateway, gatewayClient },
      }),
    )
  } finally {
    context.store.close()
  }
}

/** Establish a `shared`-authority tracked workspace with a real file-backed split store. */
export const establishSharedWorkspace = (workspace: AbsolutePathType): Promise<void> =>
  establishWorkspaceWithMode({ workspace, mode: 'shared' })

/** Stage a PENDING local property edit in the public SQLite data file. */
export const editSelectInSqlite = ({
  sqlitePath,
  value,
}: {
  readonly sqlitePath: string
  readonly value: string
}): void => {
  const db = new DatabaseSync(sqlitePath)
  try {
    db.prepare(`UPDATE pages SET "${dryRunSelectPropName}" = ? WHERE _page_id = ?`).run(
      value,
      testIds.pageId,
    )
  } finally {
    db.close()
  }
}

/** Write a `.nmd` page file carrying frontmatter properties + a body edit. */
export const writePageNmd = async ({
  workspace,
  selectValue,
  body,
}: {
  readonly workspace: AbsolutePathType
  readonly selectValue: string
  readonly body: string
}): Promise<void> => {
  const pagesDir = join(workspace, pagesDirRelativePath(testIds.databaseId))
  await mkdir(pagesDir, { recursive: true })
  const frontmatter = {
    notion_md: {
      version: 2 as const,
      api_version: '2026-03-11' as const,
      object: 'page' as const,
      source: 'shared' as const,
      page_id: testIds.pageId,
      parent: { _tag: 'data_source' as const, id: testIds.dataSourceId },
      page: { title: 'Page', icon: null, cover: null, in_trash: false, is_locked: false },
      properties: { [dryRunSelectPropName]: { _tag: 'select' as const, value: selectValue } },
    },
  } as unknown as NmdFrontmatterV2
  await writeFile(
    join(pagesDir, `${testIds.pageId}.nmd`),
    renderNmdFile({ frontmatter, body }),
    'utf8',
  )
}

/** Recursive name+sha256 listing of `base`, entry paths prefixed with `prefix`. */
const walkDigest = ({
  base,
  prefix,
}: {
  readonly base: string
  readonly prefix: string
}): Array<readonly [string, string]> =>
  readdirSync(base)
    .toSorted()
    .flatMap((entry) => {
      const abs = join(base, entry)
      const rel = prefix === '' ? entry : `${prefix}/${entry}`
      return statSync(abs).isDirectory() === true
        ? walkDigest({ base: abs, prefix: rel })
        : [[rel, createHash('sha256').update(readFileSync(abs)).digest('hex')] as const]
    })

/** Stable per-entry name+sha256 listing of a directory tree, or `undefined` when absent. */
const dirDigest = (dir: string): ReadonlyArray<readonly [string, string]> | undefined =>
  existsSync(dir) === false ? undefined : walkDigest({ base: dir, prefix: '' })

/** Snapshot of every durable workspace surface (CLI-R02). */
export type WorkspaceSurfaceSnapshot = {
  readonly eventLog: { readonly count: number }
  readonly outbox: ReadonlyArray<{ readonly commandId: string; readonly state: string }>
  readonly settlement: ReadonlyArray<string>
  readonly dataRows: ReadonlyArray<unknown> | undefined
  readonly dataChanges:
    | ReadonlyArray<{ readonly kind: string; readonly status: string }>
    | undefined
  readonly objects: ReadonlyArray<readonly [string, string]> | undefined
  readonly pages: ReadonlyArray<readonly [string, string]> | undefined
  readonly signals: ReadonlyArray<{
    readonly signalId: string
    readonly state: string
    readonly attemptCount: number
    readonly leaseToken: string | undefined
  }>
}

/**
 * Logical snapshot of every durable workspace surface (CLI-R02).
 *
 * The invariants are LOGICAL, not byte-level, by design: opening a SQLite
 * connection (even a read) can rewrite header/free-list pages, so a raw byte
 * hash of `.notion/v1/state.sqlite` or `data/v1/<src>.sqlite` is a false signal
 * (it diffs without any logical change). Instead each SQLite surface is read
 * through its own query: event count, outbox rows, signal-inbox rows, data-file
 * row values, AND the pending-replica-change status (which proves the data file
 * was not settled / planned / written back). The object store and `.nmd` files
 * are plain content-addressed files that do NOT churn, so those keep byte hashes.
 *
 * The signal-inbox snapshot is the observer-non-interference oracle for the
 * watch dry-run loop (SM5.3): a dry-run must never claim/settle/release a real
 * daemon's signal, so `state` / `attemptCount` / `leaseToken` must be invariant.
 */
export const captureWorkspaceSurfaces = (workspace: AbsolutePathType): WorkspaceSurfaceSnapshot => {
  const statePath = stateSqlitePath(workspace)
  const dataPath = dataFilePath({ workspaceRoot: workspace, name: testIds.databaseId })
  const pagesDir = join(workspace, pagesDirRelativePath(testIds.databaseId))

  // Surface 1 (event log) + surfaces 3/4 (outbox + settlement) + signal inbox:
  // logical reads from the hidden control-plane store.
  const store = openNotionSyncStore({ path: statePath })
  let eventLog: { readonly count: number }
  let outbox: ReadonlyArray<{ readonly commandId: string; readonly state: string }>
  let signals: WorkspaceSurfaceSnapshot['signals']
  try {
    eventLog = { count: store.replay(dryRunWorkspaceRootId).length }
    outbox = store
      .readOutbox(dryRunWorkspaceRootId)
      .map((row) => ({ commandId: row.commandId, state: row.state }))
    signals = store.readSignals(dryRunWorkspaceRootId).map((signal) => ({
      signalId: signal.signalId,
      state: signal.state,
      attemptCount: signal.attemptCount,
      leaseToken: signal.leaseToken,
    }))
  } finally {
    store.close()
  }

  // Surface 2 (public data file): logical row values for the tracked page.
  const dataRows = (() => {
    if (existsSync(dataPath) === false) return undefined
    const db = new DatabaseSync(dataPath, { readOnly: true })
    try {
      return db
        .prepare(`SELECT _page_id, "${dryRunSelectPropName}" AS v FROM pages ORDER BY _page_id`)
        .all()
    } finally {
      db.close()
    }
  })()

  // Surface 2 (continued): the staged local edit's CDC status. Any settle /
  // plan / write-back under dry-run would advance this away from `pending`.
  const dataChanges =
    existsSync(dataPath) === true
      ? readPendingReplicaChanges(dataPath).map((change) => ({
          kind: change.kind,
          status: change.status,
        }))
      : undefined

  return {
    eventLog,
    outbox,
    settlement: outbox.map((row) => row.state),
    dataRows,
    dataChanges,
    objects: dirDigest(objectsDir(workspace)),
    pages: dirDigest(pagesDir),
    signals,
  }
}
