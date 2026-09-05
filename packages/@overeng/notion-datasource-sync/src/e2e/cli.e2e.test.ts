import { execFile, type ExecFileOptions } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import * as NodeContext from '@effect/platform-node/NodeServices'
import { Cause, Effect, Exit, Layer, Option, Schema, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  BodyEvidenceFingerprintSchema as NotionMdBodyEvidenceFingerprint,
  NotionApiError,
} from '@overeng/notion-effect-client'
import {
  NmdStateStore,
  NmdStateStoreLive,
  type NotionMdGatewayShape,
  type PullPageResult,
} from '@overeng/notion-md'

import {
  makeNotionMdMaterializingLocalWorkspacePort,
  makeNotionMdPageBodySyncPort,
} from '../body/notion-md.ts'
import {
  CliArgumentError,
  parseCliCommand,
  parseCliContext,
  renderCliHelpText,
  renderCliResultJson,
  resolveCliCommandNotionRefs,
  runCliCommand,
  runCliCommandWithRuntime,
  runCliMain,
  type CliContext,
} from '../cli/main.ts'
import { propertySurfaceKey } from '../core/canonical.ts'
import { PagePropertyItemPage } from '../core/commands.ts'
import {
  AbsolutePath,
  bodyDescriptorForDigest,
  bodyEvidenceFingerprintFromContentDigest,
  evidenceBackedBodyIdentity,
  PageId,
  WorkspaceRelativePath,
} from '../core/domain.ts'
import { WorkspaceNotTracked } from '../core/errors.ts'
import { SyncEventId, type SyncEvent as SyncEventType } from '../core/events.ts'
import {
  LocalWorkspacePort,
  NotionDataSourceGateway,
  PageBodySyncPort,
  type LocalWorkspacePortShape,
  type NotionDataSourceGatewayShape,
  type PageBodySyncPortShape,
} from '../core/ports.ts'
import { makeGatewayError, makeNotionApiContract } from '../gateway/gateway.ts'
import type { NotionGatewayClient, NotionGatewayPage } from '../gateway/notion.ts'
import { loadWorkspaceManifest, pagesDirRelativePath } from '../local/manifest.ts'
import { presentArtifactObservation } from '../local/workspace.ts'
import { projectReplicaFromSyncStore } from '../replica/replica.ts'
import { NotionSyncStore, openNotionSyncStore } from '../store/store.ts'
import { makeConflictRaisedEvent } from '../sync/observation.ts'
import { initOneShotSync, pullOneShotSync } from '../sync/sync.ts'
import {
  defaultQueryContract,
  decode,
  fakeBodyPage,
  fixedObservedAt,
  hash,
  bodyPointer,
  makeFakeClock,
  makeFakeGatewayHarness,
  makeHarnessPorts,
  makeStoreFixture,
  pageSnapshot,
  testIds,
} from '../testing/harness.ts'
import { computeNotionWebhookSignature } from '../webhook/notion.ts'

const execFileAsync = promisify(execFile)
const packageDir = fileURLToPath(new URL('../..', import.meta.url))
const cliPath = join(packageDir, 'src/cli/main.ts')
const cliTestTimeoutMs = 30_000

/** Reads one Buck-declared immutable tool path; nothing resolves through an ambient PATH. */
const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

const nodeBin = requireTool('NODE_BIN')

interface CliRun {
  readonly stdout: string
  readonly stderr: string
}

/**
 * Launches the source CLI entry on the attested Node runtime its shebang names. Containment binds
 * only declared roots, so `/usr/bin/env` does not exist inside the sandbox and the shebang cannot
 * dispatch; the shebang contract itself is asserted separately against the file's first line.
 */
const runCli = (args: readonly string[], options: ExecFileOptions): Promise<CliRun> =>
  execFileAsync(nodeBin, [cliPath, ...args], { ...options, encoding: 'utf8' })

const workspaceRoot = decode({ schema: AbsolutePath, value: '/tmp/notion-ds-sync-cli' })
const webhookPathPattern = /^\/notion-datasource-sync\/webhook\/notion\/[0-9a-f-]{36}$/
const webhookSetPathPattern =
  /^--set-path=\/notion-datasource-sync\/webhook\/notion\/[0-9a-f-]{36}$/
const notionMdBodyEvidenceFingerprint = Schema.decodeUnknownSync(NotionMdBodyEvidenceFingerprint)

const schemaProperties = [
  {
    propertyId: testIds.propertyA,
    name: 'Row',
    type: 'title',
    configHash: hash('config-a'),
    writeClass: 'writable' as const,
  },
]

const expectSqliteStoreFilesAbsent = async (storePath: string) => {
  await Promise.all(
    [storePath, `${storePath}-wal`, `${storePath}-shm`].map((path) =>
      expect(access(path)).rejects.toThrow(),
    ),
  )
}

const propertyPage = (valueHash = hash('property-a-base')) =>
  decode({
    schema: PagePropertyItemPage,
    value: {
      _tag: 'PagePropertyItemPage',
      apiVersion: '2026-03-11',
      requestId: testIds.requestId,
      pageId: testIds.pageId,
      propertyId: testIds.propertyA,
      items: [
        {
          _tag: 'PagePropertyItem',
          pageId: testIds.pageId,
          propertyId: testIds.propertyA,
          itemHash: valueHash,
          valueHash,
        },
      ],
      nextCursor: null,
      hasMore: false,
    },
  })

const bodyPointerFor = (bodyHash = hash('body-a')) => bodyPointer(bodyHash)

const bodyPointerForPage = (pageId: PageId, bodyHash = hash('body-a')) => ({
  ...bodyPointer(bodyHash),
  pageId,
})

const bodyPage = (bodyHash = hash('body-a'), remoteBodyHash = bodyHash) =>
  fakeBodyPage({
    pointer: bodyPointerFor(bodyHash),
    remoteIdentity: evidenceBackedBodyIdentity({
      rendered: bodyDescriptorForDigest(remoteBodyHash),
      evidenceFingerprint: bodyEvidenceFingerprintFromContentDigest(remoteBodyHash),
      completeness: 'complete',
    }),
  })

const conflictEvent = (): SyncEventType =>
  makeConflictRaisedEvent({
    rootId: testIds.rootId,
    pageId: testIds.pageId,
    propertyId: testIds.propertyA,
    surface: propertySurfaceKey({ pageId: testIds.pageId, propertyId: testIds.propertyA }),
    baseHash: hash('property-a-base'),
    localHash: hash('property-a-local'),
    remoteHash: hash('property-a-remote'),
    conflictKind: 'property',
    message: 'Local and remote changed the same property',
    now: () => new Date(fixedObservedAt),
  })

const injectedNotionPage = (): NotionGatewayPage => ({
  id: testIds.pageId,
  parent: {
    type: 'data_source_id',
    data_source_id: testIds.dataSourceId,
  },
  properties: {
    [testIds.propertyA]: {
      type: 'title',
      title: [{ plain_text: 'Row' }],
    },
  },
  last_edited_time: fixedObservedAt,
  in_trash: false,
})

const makeInjectedNotionClient = (calls: {
  retrieveDataSource: number
  queryDataSource: number
  retrievePage: number
  retrieveDatabase?: number
}): NotionGatewayClient => ({
  retrieveDataSource: () => {
    calls.retrieveDataSource += 1
    return Effect.succeed({
      id: testIds.dataSourceId,
      properties: {
        [testIds.propertyA]: {
          id: testIds.propertyA,
          name: 'Row',
          type: 'title',
        },
      },
    })
  },
  queryDataSource: () => {
    calls.queryDataSource += 1
    return Effect.succeed({
      results: [injectedNotionPage()],
      nextCursor: Option.none(),
      hasMore: false,
    })
  },
  retrievePage: () => {
    calls.retrievePage += 1
    return Effect.succeed(injectedNotionPage())
  },
  retrievePageProperty: () =>
    Effect.succeed({
      results: [],
      nextCursor: Option.none(),
      hasMore: false,
    }),
  retrieveDatabase: () => {
    calls.retrieveDatabase = (calls.retrieveDatabase ?? 0) + 1
    return Effect.succeed({
      id: 'database-1',
      title: [],
      description: [],
      icon: null,
      data_sources: [{ id: testIds.dataSourceId, name: 'Rows' }],
    })
  },
  updatePage: (input) =>
    Effect.succeed({
      ...injectedNotionPage(),
      ...(input.inTrash === undefined ? {} : { in_trash: input.inTrash }),
    }),
  createPage: (input) =>
    Effect.succeed({
      ...injectedNotionPage(),
      id: `created-${Object.keys(input.properties).join('-')}`,
    }),
  updateDataSource: () =>
    Effect.succeed({
      id: testIds.dataSourceId,
      properties: {},
    }),
  updateDatabase: () =>
    Effect.succeed({
      id: 'database-1',
      title: [],
      description: [],
      icon: null,
    }),
})

const context = (input: {
  readonly store: CliContext['store']
  readonly storePath?: CliContext['storePath']
  readonly clock: ReturnType<typeof makeFakeClock>
  readonly maxExecutorSteps?: number
  readonly workspaceRoot?: CliContext['workspaceRoot']
  readonly sourcePagesDir?: CliContext['sourcePagesDir']
  readonly schemaProperties?: CliContext['schemaProperties']
  readonly requiredCapabilities?: CliContext['requiredCapabilities']
  readonly materializeBodies?: CliContext['materializeBodies']
  readonly tailscaleProcessRunner?: CliContext['tailscaleProcessRunner']
  readonly webhookReceiverPort?: CliContext['webhookReceiverPort']
  readonly webhookReceiverPath?: CliContext['webhookReceiverPath']
  readonly webhookReceiverStarted?: CliContext['webhookReceiverStarted']
}): CliContext => ({
  store: input.store,
  ...(input.storePath === undefined ? {} : { storePath: input.storePath }),
  rootId: testIds.rootId,
  dataSourceId: testIds.dataSourceId,
  workspaceRoot: input.workspaceRoot ?? workspaceRoot,
  ...(input.sourcePagesDir === undefined ? {} : { sourcePagesDir: input.sourcePagesDir }),
  queryContract: defaultQueryContract(),
  schemaProperties: input.schemaProperties ?? schemaProperties,
  ...(input.requiredCapabilities === undefined
    ? {}
    : { requiredCapabilities: input.requiredCapabilities }),
  ...(input.materializeBodies === undefined ? {} : { materializeBodies: input.materializeBodies }),
  ...(input.maxExecutorSteps === undefined ? {} : { maxExecutorSteps: input.maxExecutorSteps }),
  ...(input.tailscaleProcessRunner === undefined
    ? {}
    : { tailscaleProcessRunner: input.tailscaleProcessRunner }),
  ...(input.webhookReceiverPort === undefined
    ? {}
    : { webhookReceiverPort: input.webhookReceiverPort }),
  ...(input.webhookReceiverPath === undefined
    ? {}
    : { webhookReceiverPath: input.webhookReceiverPath }),
  ...(input.webhookReceiverStarted === undefined
    ? {}
    : { webhookReceiverStarted: input.webhookReceiverStarted }),
  now: input.clock.now,
})

const runWithPorts = <TValue, TError>(
  effect: Effect.Effect<
    TValue,
    TError,
    NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
  >,
  input: {
    readonly gateway: NotionDataSourceGatewayShape
    readonly body?: PageBodySyncPortShape
    readonly workspace?: LocalWorkspacePortShape
  },
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(NotionDataSourceGateway, input.gateway),
      Effect.provideService(PageBodySyncPort, input.body ?? makeHarnessPorts().body),
      Effect.provideService(LocalWorkspacePort, input.workspace ?? makeHarnessPorts().workspace),
    ),
  )

const runWithNmdStateStore = <TValue, TError>(
  effect: Effect.Effect<TValue, TError, NmdStateStore>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(NmdStateStoreLive.pipe(Layer.provide(NodeContext.layer)))),
  )

const createBoundSqlite = async ({
  path,
  workspace = workspaceRoot,
}: {
  readonly path: string
  readonly workspace?: AbsolutePath
}): Promise<void> => {
  const clock = makeFakeClock()
  const store = openNotionSyncStore({ path, now: clock.now })
  try {
    initOneShotSync({
      store,
      rootId: testIds.rootId,
      dataSourceId: testIds.dataSourceId,
      workspaceRoot: workspace,
      now: clock.now,
    })
    await runWithPorts(
      pullOneShotSync(
        context({
          store,
          clock,
          workspaceRoot: workspace,
        }),
      ),
      {
        gateway: makeFakeGatewayHarness({ propertyPages: [propertyPage()] }).gateway,
      },
    )
  } finally {
    store.close()
  }
  projectReplicaFromSyncStore({
    syncStorePath: path,
    replicaPath: path,
    rootId: testIds.rootId,
  })
}

const establishTrackedWorkspace = async ({
  workspace,
  mode = 'shared',
}: {
  readonly workspace: AbsolutePath
  readonly mode?: 'local' | 'remote' | 'shared'
}): Promise<void> => {
  const argv = ['track', testIds.dataSourceId, workspace, '--mode', mode, '--no-materialize-bodies']
  const command = parseCliCommand(argv)
  const context = parseCliContext({ argv, resolvedCommand: command })
  try {
    await Effect.runPromise(
      runCliCommandWithRuntime({
        command,
        context,
        options: { gateway: makeFakeGatewayHarness({ propertyPages: [propertyPage()] }).gateway },
      }),
    )
  } finally {
    context.store.close()
  }
}

describe('CLI command surface', () => {
  it('prints db runtime version from the shared CLI build stamp contract', async () => {
    const { stdout, stderr } = await runCli(['--version'], {
      cwd: packageDir,
      env: {
        ...process.env,
        CLI_BUILD_STAMP: JSON.stringify({
          type: 'local',
          rev: 'abc123',
          ts: 1_764_590_000,
          dirty: true,
        }),
      },
      timeout: cliTestTimeoutMs,
    })

    expect(stdout).toContain('0.1.0 — running from local source (abc123,')
    expect(stdout).toContain('with uncommitted changes')
    expect(stderr).not.toContain('CliErrorEnvelope')
  })

  it('prints db runtime help without opening a store', async () => {
    const { stdout, stderr } = await runCli(['--help'], {
      cwd: packageDir,
      timeout: cliTestTimeoutMs,
    })

    expect(stdout).toBe(renderCliHelpText())
    expect(stdout).toContain('notion db')
    expect(stdout).toContain('Packaged Node-backed entrypoint')
    expect(stdout).toContain('sync')
    expect(stderr).not.toContain('CliErrorEnvelope')
  })

  it('prints shell completions from the import-safe Effect command tree', async () => {
    const { stdout } = await runCli(['--completions', 'bash'], {
      cwd: packageDir,
      timeout: cliTestTimeoutMs,
    })

    expect(stdout).toContain('track')
    expect(stdout).toContain('sync')
    expect(stdout).toContain('status')
    expect(stdout).toContain('conflicts')
    // The removed reconciliation verbs must not be advertised in completions
    // (CLI-R01); guards against a descriptor regression re-exposing them.
    // Word boundaries avoid false positives on bash's `_init_completion`
    // helper emitted by the Effect v4 completion template.
    expect(stdout).not.toMatch(/\binit\b/u)
    expect(stdout).not.toMatch(/\bpull\b/u)
    expect(stdout).not.toMatch(/\bpush\b/u)
    expect(stdout).not.toMatch(/\bfrom-notion\b/u)
  })

  it(
    'runs the source CLI entry on the Node runtime its shebang names, with node:sqlite available',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-'))
      try {
        const sqlitePath = join(dir, 'store.sqlite')
        await createBoundSqlite({ path: sqlitePath })
        // The entry still declares Node as its runtime for an ambient shell; the run below
        // exercises that same runtime through the attested tool containment does admit.
        expect((await readFile(cliPath, 'utf8')).split('\n', 1)[0]).toBe('#!/usr/bin/env node')
        const { stdout } = await runCli(
          [
            'status',
            '--sqlite',
            sqlitePath,
            '--root-id',
            testIds.rootId,
            '--data-source-id',
            testIds.dataSourceId,
            '--workspace-root',
            workspaceRoot,
          ],
          { cwd: packageDir, timeout: cliTestTimeoutMs },
        )

        expect(JSON.parse(stdout)).toMatchObject({
          _tag: 'CliResultEnvelope',
          command: 'status',
          ok: true,
        })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    cliTestTimeoutMs,
  )

  it('keeps sync --watch unbounded by default until --max-cycles is provided', () => {
    expect(parseCliCommand(['sync', '--watch', '--state', '/tmp/watch.json'])).toEqual({
      _tag: 'sync',
      watch: true,
      statePath: '/tmp/watch.json',
      dryRun: false,
    })
    expect(parseCliCommand(['sync', '--watch', '/tmp/workspace', '--max-cycles', '2'])).toEqual({
      _tag: 'sync',
      workspaceRoot: '/tmp/workspace',
      dryRun: false,
      watch: true,
      maxCycles: 2,
    })
    expect(
      parseCliCommand([
        'sync',
        '--watch',
        '--webhook',
        'none',
        '--watch-priority',
        'development',
        '--non-interactive',
      ]),
    ).toEqual({
      _tag: 'sync',
      dryRun: false,
      watch: true,
      watchPriority: 'development',
      webhook: 'none',
      nonInteractive: true,
    })
    expect(
      parseCliCommand([
        'sync',
        '--watch',
        '--webhook',
        'tailscale',
        '--webhook-required',
        '--max-cycles',
        '1',
      ]),
    ).toEqual({
      _tag: 'sync',
      dryRun: false,
      watch: true,
      webhook: 'tailscale',
      webhookRequired: true,
      maxCycles: 1,
    })
    expect(parseCliCommand(['sync', '--watch', '--webhook', 'manual'])).toEqual({
      _tag: 'sync',
      dryRun: false,
      watch: true,
      webhook: 'manual',
    })
    expect(() => parseCliCommand(['watch', '--state', '/tmp/watch.json'])).toThrow(CliArgumentError)
  })

  // SM5.3 (CLI-R02): a `sync --watch --dry-run` is a non-interfering observer
  // that writes NOTHING durable, but a webhook receiver enqueues durable signals
  // on delivery. Reject the combination at parse time (before any receiver
  // starts) for both providers; the default `--webhook none` dry-run watch and
  // an explicit `--webhook none` still parse.
  it('rejects a webhook receiver under sync --watch --dry-run at parse time', () => {
    const webhookRejection =
      'sync --watch --dry-run cannot run a webhook receiver (it would enqueue durable signals); use --webhook none for a dry-run watch'
    for (const provider of ['manual', 'tailscale'] as const) {
      expect(() =>
        parseCliCommand(['sync', '--watch', '--dry-run', '--webhook', provider]),
      ).toThrow(webhookRejection)
    }
    expect(parseCliCommand(['sync', '--watch', '--dry-run'])).toEqual({
      _tag: 'sync',
      dryRun: true,
      watch: true,
    })
    expect(parseCliCommand(['sync', '--watch', '--dry-run', '--webhook', 'none'])).toEqual({
      _tag: 'sync',
      dryRun: true,
      watch: true,
      webhook: 'none',
    })
  })

  it('parses track as the adoption verb with a workspace-wide authority --mode', () => {
    // `track <remote> <workspace>` defaults the authority mode to `remote`
    // (safe-by-default mirror adoption; VRS cli/spec.md).
    expect(parseCliCommand(['track', 'data-source-1', '/tmp/notion-workspace'])).toMatchObject({
      _tag: 'track',
      dataSourceId: 'data-source-1',
      remoteRef: { _tag: 'data-source', dataSourceId: 'data-source-1' },
      workspaceRoot: '/tmp/notion-workspace',
      authorityMode: 'remote',
      dryRun: false,
    })
    // `track --mode <m>` carries the chosen workspace-wide authority mode.
    for (const mode of ['local', 'remote', 'shared'] as const) {
      expect(
        parseCliCommand(['track', 'data-source-1', '/tmp/notion-workspace', '--mode', mode]),
      ).toMatchObject({ _tag: 'track', authorityMode: mode })
    }
    // An unknown authority mode is rejected.
    expect(() =>
      parseCliCommand(['track', 'data-source-1', '/tmp/notion-workspace', '--mode', 'bogus']),
    ).toThrow('--mode must be one of: local, remote, shared')
    // Missing positionals fail closed.
    expect(() => parseCliCommand(['track'])).toThrow(
      'track requires a Notion data source or database URL',
    )
    expect(() => parseCliCommand(['track', 'data-source-1'])).toThrow(
      'track requires a workspace root',
    )
    // `--limit` is dry-run only, mirroring the legacy establish path.
    expect(() =>
      parseCliCommand(['track', 'data-source-1', '/tmp/notion-workspace', '--limit', '25']),
    ).toThrow('--limit is only supported with track --dry-run')
  })

  it('rejects a per-run --mode on established commands (authority is workspace-wide)', () => {
    // Authority mode is set once by `track`; every established command refuses a
    // per-run override (decisions 0015, 0019) instead of silently ignoring it.
    const rejected = 'authority mode is workspace-wide; set it with `track --mode`'
    expect(() => parseCliCommand(['sync', '/tmp/ws', '--mode', 'shared'])).toThrow(rejected)
    expect(() => parseCliCommand(['sync', '--watch', '--mode', 'local'])).toThrow(rejected)
    expect(() => parseCliCommand(['status', '/tmp/ws', '--mode', 'remote'])).toThrow(rejected)
    expect(() =>
      parseCliCommand(['export', '/tmp/ws', '--output', '/tmp/out', '--mode', 'shared']),
    ).toThrow(rejected)
    expect(() => parseCliCommand(['doctor', '--mode', 'shared'])).toThrow(rejected)
  })

  it(
    'emits a structured diagnostic and exits nonzero for invalid numeric flags',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-'))
      try {
        await expect(
          runCli(
            [
              'sync',
              '--watch',
              '--state',
              '/tmp/watch.json',
              '--max-cycles',
              '--sqlite',
              join(dir, 'store.sqlite'),
              '--root-id',
              testIds.rootId,
              '--data-source-id',
              testIds.dataSourceId,
              '--workspace-root',
              workspaceRoot,
            ],
            { cwd: packageDir, timeout: cliTestTimeoutMs },
          ),
        ).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining('Missing value for --max-cycles'),
        })

        await expect(
          runCli(
            [
              'status',
              '--sqlite',
              join(dir, 'store.sqlite'),
              '--root-id',
              testIds.rootId,
              '--data-source-id',
              testIds.dataSourceId,
              '--workspace-root',
              workspaceRoot,
              '--max-executor-steps',
            ],
            { cwd: packageDir, timeout: cliTestTimeoutMs },
          ),
        ).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining('Missing value for --max-executor-steps'),
        })

        await expect(
          runCli(['sync', '--watch', '--state', '/tmp/watch.json', '--max-cycles', 'NaN'], {
            cwd: packageDir,
            timeout: cliTestTimeoutMs,
          }),
        ).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining('CliErrorEnvelope'),
        })

        await expect(
          runCli(
            [
              'sync',
              '--watch',
              '--state',
              '/tmp/watch.json',
              '--max-cycles',
              '0',
              '--sqlite',
              join(dir, 'store.sqlite'),
              '--root-id',
              testIds.rootId,
              '--data-source-id',
              testIds.dataSourceId,
              '--workspace-root',
              workspaceRoot,
            ],
            {
              cwd: packageDir,
              timeout: cliTestTimeoutMs,
            },
          ),
        ).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining('--max-cycles must be a positive integer'),
        })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    cliTestTimeoutMs * 2,
  )

  it('rejects unsupported numeric flag shapes before command execution', () => {
    expect(() =>
      parseCliCommand([
        'sync',
        '--watch',
        '--state',
        '/tmp/watch.json',
        '--max-cycles',
        '1',
        '--max-cycles',
        '2',
      ]),
    ).toThrow(CliArgumentError)

    expect(() =>
      parseCliCommand(['sync', '--watch', '--state', '/tmp/watch.json', '--max-cycles', '1e2']),
    ).toThrow('--max-cycles must be a positive integer')
    expect(() =>
      parseCliCommand([
        'sync',
        '--watch',
        '--state',
        '/tmp/watch.json',
        '--max-cycles',
        'Infinity',
      ]),
    ).toThrow('--max-cycles must be a positive integer')
    expect(() =>
      parseCliCommand(['sync', '--watch', '--state', '/tmp/watch.json', '--max-cycles', '-1']),
    ).toThrow('--max-cycles must be a positive integer')
  })

  it('rejects the removed internal reconciliation verbs with clean-break guidance', () => {
    // `init`/`pull`/`push` are internal reconciliation phases, not public
    // commands (CLI-R01). The internal functions remain; the public verbs are
    // a clean-break removal that points operators back at `sync`.
    for (const verb of ['init', 'pull', 'push'] as const) {
      expect(() => parseCliCommand([verb, '--dry-run'])).toThrow(
        `${verb} is an internal reconciliation phase, not a public command; use \`sync\``,
      )
    }
  })

  it('parses mutating dry-run flags and explicit unsupported command gaps', () => {
    expect(parseCliCommand(['sync', '--dry-run'])).toEqual({
      _tag: 'sync',
      dryRun: true,
    })
    expect(
      parseCliCommand(['conflicts', 'resolve', '--conflict-id', 'conflict-1', '--dry-run']),
    ).toMatchObject({
      _tag: 'conflicts-resolve',
      conflictId: 'conflict-1',
      dryRun: true,
    })
    expect(parseCliCommand(['forget', '--page-id', testIds.pageId, '--dry-run'])).toEqual({
      _tag: 'forget',
      pageId: testIds.pageId,
      dryRun: true,
    })
    expect(parseCliCommand(['restore', '--page-id', testIds.pageId, '--dry-run'])).toEqual({
      _tag: 'restore',
      pageId: testIds.pageId,
      dryRun: true,
    })
  })

  it('parses established workspace forms and rejects the removed sync --from-notion alias', () => {
    expect(parseCliCommand(['sync', '/tmp/notion-workspace', '--dry-run'])).toEqual({
      _tag: 'sync',
      workspaceRoot: '/tmp/notion-workspace',
      dryRun: true,
    })
    expect(
      parseCliCommand([
        'export',
        '/tmp/notion-workspace',
        '--output',
        '/tmp/export.ndjson',
        '--format',
        'json',
        '--require-clean',
      ]),
    ).toEqual({
      _tag: 'export',
      workspaceRoot: '/tmp/notion-workspace',
      outputPath: '/tmp/export.ndjson',
      format: 'json',
      requireClean: true,
      dryRun: false,
    })
    expect(() => parseCliCommand(['sync', '/tmp/a', '/tmp/b'])).toThrow(CliArgumentError)
    expect(() => parseCliCommand(['export', '--format', 'csv', '--output', '/tmp/a'])).toThrow(
      CliArgumentError,
    )
    // Adoption is now `track`; `sync --from-notion` is a clean-break removal.
    expect(() =>
      parseCliCommand(['sync', '--from-notion', '0123456789abcdef0123456789abcdef', '/tmp/ws']),
    ).toThrow('use `track <id-or-url> <root> --mode <local|remote|shared>`')
  })

  it('resolves a Notion database URL to a single child data source before opening context', async () => {
    const calls = {
      retrieveDataSource: 0,
      queryDataSource: 0,
      retrievePage: 0,
      retrieveDatabase: 0,
    }
    const command = parseCliCommand([
      'track',
      'https://www.notion.so/example/0123456789abcdef0123456789abcdef?v=feedfacefeedfacefeedfacefeedface',
      '/tmp/notion-workspace',
      '--mode',
      'remote',
      '--dry-run',
    ])

    const resolved = await Effect.runPromise(
      resolveCliCommandNotionRefs({
        command,
        options: { gatewayClient: makeInjectedNotionClient(calls) },
      }),
    )

    expect(resolved).toMatchObject({
      _tag: 'track',
      dataSourceId: testIds.dataSourceId,
      remoteRef: { _tag: 'data-source', dataSourceId: testIds.dataSourceId },
    })
    expect(calls.retrieveDatabase).toBe(1)
    expect(calls.retrieveDataSource).toBe(0)
  })

  it('adopts an explicit data-source URL without database lookup', async () => {
    const calls = {
      retrieveDataSource: 0,
      queryDataSource: 0,
      retrievePage: 0,
      retrieveDatabase: 0,
    }
    const command = parseCliCommand([
      'track',
      'https://api.notion.com/v1/data_sources/0123456789abcdef0123456789abcdef',
      '/tmp/notion-workspace',
      '--mode',
      'remote',
      '--dry-run',
    ])

    const resolved = await Effect.runPromise(
      resolveCliCommandNotionRefs({
        command,
        options: { gatewayClient: makeInjectedNotionClient(calls) },
      }),
    )

    expect(resolved).toEqual(command)
    expect(resolved).toMatchObject({
      _tag: 'track',
      dataSourceId: '01234567-89ab-cdef-0123-456789abcdef',
      remoteRef: {
        _tag: 'data-source',
        dataSourceId: '01234567-89ab-cdef-0123-456789abcdef',
      },
    })
    expect(calls.retrieveDatabase).toBe(0)
  })

  it('fails closed when a Notion database URL has no child data sources', async () => {
    const calls = { retrieveDataSource: 0, queryDataSource: 0, retrievePage: 0 }
    const client: NotionGatewayClient = {
      ...makeInjectedNotionClient(calls),
      retrieveDatabase: () =>
        Effect.succeed({
          id: 'database-1',
          title: [],
          description: [],
          icon: null,
          data_sources: [],
        }),
    }
    const command = parseCliCommand([
      'track',
      'https://www.notion.so/example/0123456789abcdef0123456789abcdef',
      '/tmp/notion-workspace',
      '--mode',
      'remote',
      '--dry-run',
    ])

    await expect(
      Effect.runPromise(
        resolveCliCommandNotionRefs({ command, options: { gatewayClient: client } }),
      ),
    ).rejects.toThrow('does not report any child data sources')
  })

  it('fails closed with a sanitized diagnostic when database resolution is inaccessible', async () => {
    const calls = { retrieveDataSource: 0, queryDataSource: 0, retrievePage: 0 }
    const client: NotionGatewayClient = {
      ...makeInjectedNotionClient(calls),
      retrieveDatabase: () =>
        Effect.fail(
          new NotionApiError({
            status: 404,
            code: 'object_not_found',
            message: 'private workspace object',
            retryAfterSeconds: Option.none(),
            requestId: Option.none(),
            url: Option.none(),
            method: Option.some('GET'),
          }),
        ),
    }
    const command = parseCliCommand([
      'track',
      'https://www.notion.so/example/0123456789abcdef0123456789abcdef',
      '/tmp/notion-workspace',
      '--mode',
      'remote',
      '--dry-run',
    ])

    await expect(
      Effect.runPromise(
        resolveCliCommandNotionRefs({ command, options: { gatewayClient: client } }),
      ),
    ).rejects.toThrow(
      'Unable to retrieve the Notion database while resolving the adoption ref; verify the integration can access the database, or pass a data source ID directly.',
    )
  })

  it('fails closed when a Notion database URL has multiple child data sources', async () => {
    const calls = { retrieveDataSource: 0, queryDataSource: 0, retrievePage: 0 }
    const client: NotionGatewayClient = {
      ...makeInjectedNotionClient(calls),
      retrieveDatabase: () =>
        Effect.succeed({
          id: 'database-1',
          title: [],
          description: [],
          icon: null,
          data_sources: [
            { id: testIds.dataSourceId, name: 'First' },
            { id: '00000000-0000-0000-0000-000000000002', name: 'Second' },
          ],
        }),
    }
    const command = parseCliCommand([
      'track',
      'https://www.notion.so/example/0123456789abcdef0123456789abcdef',
      '/tmp/notion-workspace',
      '--mode',
      'remote',
      '--dry-run',
    ])

    await expect(
      Effect.runPromise(
        resolveCliCommandNotionRefs({ command, options: { gatewayClient: client } }),
      ),
    ).rejects.toThrow('multiple child data sources')
  })

  it('renders BigInt values in JSON envelopes without throwing', () => {
    const rendered = renderCliResultJson({
      _tag: 'CliResultEnvelope',
      version: 'v1',
      command: 'status',
      ok: true,
      rootId: testIds.rootId,
      status: { state: 'clean', binding: undefined, counts: { events: 1n } },
      surface: { conflicts: [], guards: [], tombstones: [], outbox: [] },
      result: { sequence: 42n },
    } as unknown as Parameters<typeof renderCliResultJson>[0])

    expect(JSON.parse(rendered)).toMatchObject({
      status: { counts: { events: '1' } },
      result: { sequence: '42' },
    })
  })

  it('rejects the removed --store flag instead of treating it as a workspace dependency', () => {
    expect(() =>
      parseCliContext({
        argv: [
          'status',
          '--store',
          '/tmp/legacy-store.sqlite',
          '--root-id',
          testIds.rootId,
          '--data-source-id',
          testIds.dataSourceId,
          '--workspace-root',
          workspaceRoot,
        ],
      }),
    ).toThrow('--store has been removed')
  })

  it('discovers established workspace config for sync and suggests establishment when missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-config-'))
    try {
      const workspaceRootDir = decode({ schema: AbsolutePath, value: dir })
      // Untracked workspace (no v1 manifest) fails closed with tracking guidance
      // that points at the canonical adoption verb (`track`).
      expect(() => parseCliContext({ argv: ['sync', dir] })).toThrow(/Run track <database-url>/)

      // Establish through the public adoption command so the manifest and hidden
      // control-plane binding are created together.
      await establishTrackedWorkspace({ workspace: workspaceRootDir })
      const ctx = parseCliContext({ argv: ['sync', dir] })
      try {
        expect(ctx.rootId).toBe(`data-source:${testIds.dataSourceId}`)
        expect(ctx.dataSourceId).toBe(testIds.dataSourceId)
        expect(ctx.workspaceRoot).toBe(dir)
      } finally {
        ctx.store.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('runCliMain surfaces an untracked workspace as a typed failure, not a defect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-untracked-'))
    try {
      // The workspace-discovery errors thrown by `parseCliContext` are expected
      // CLI failures and must reach the failure channel (so the top-level
      // `renderCliErrorJson` envelope renders them) rather than the defect
      // channel. Driving `runCliMain` end-to-end is what proves the `catch`
      // mapper at the `parseCliContext` call site keeps them as failures.
      const exit = await Effect.runPromiseExit(
        runCliMain({ argv: ['sync', dir] }).pipe(Effect.scoped),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) === true) {
        const failure = Cause.findErrorOption(exit.cause)
        // A defect would surface through `Cause.hasDies`, not a fail reason.
        expect(Option.isSome(failure)).toBe(true)
        expect(Cause.hasDies(exit.cause)).toBe(false)
        if (Option.isSome(failure) === true) {
          expect(failure.value).toBeInstanceOf(WorkspaceNotTracked)
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('track --mode establishes the workspace and round-trips authority_mode into the manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-track-'))
    try {
      // `track --mode shared` establishes the workspace (closing the SM2 M3 gap:
      // track has the data_source_id to write a complete manifest entry) and
      // records the workspace-wide authority mode.
      const command = parseCliCommand([
        'track',
        'data-source-1',
        dir,
        '--mode',
        'shared',
        '--no-materialize-bodies',
      ])
      const ctx = parseCliContext({
        argv: ['track', 'data-source-1', dir, '--no-materialize-bodies'],
        resolvedCommand: command,
      })
      try {
        expect(ctx.dataSourceId).toBe('data-source-1')
        expect(ctx.workspaceRoot).toBe(dir)
        // The selected authority mode is available to the pending establish run...
        expect(ctx.authorityMode).toBe('shared')
        // SM5b: the source's page directory is read onto the context too, so the
        // CLI materializes `.nmd` page files under `pages/v1/<name>/`. This pins
        // the manifest -> CliContext.sourcePagesDir hop (the on-disk landing is
        // proven by the real-CLI NotionMD materialization test).
        expect(ctx.sourcePagesDir).toBe(pagesDirRelativePath('data-source-1'))
      } finally {
        ctx.store.close()
      }
      // Parsing only prepares the manifest entry; it must not leave a tracked
      // workspace behind before remote establishment succeeds.
      expect(loadWorkspaceManifest(decode({ schema: AbsolutePath, value: dir }))._tag).toBe(
        'untracked',
      )

      const runCtx = parseCliContext({
        argv: ['track', 'data-source-1', dir, '--mode', 'shared', '--no-materialize-bodies'],
        resolvedCommand: command,
      })
      try {
        await Effect.runPromise(
          runCliCommandWithRuntime({
            command,
            context: runCtx,
            options: {
              gateway: makeFakeGatewayHarness({ propertyPages: [propertyPage()] }).gateway,
            },
          }),
        )
      } finally {
        runCtx.store.close()
      }
      // ...and a successful track durably writes notion.workspace.v1.json.
      const manifest = loadWorkspaceManifest(decode({ schema: AbsolutePath, value: dir }))
      expect(manifest._tag).toBe('tracked')
      if (manifest._tag === 'tracked') {
        expect(manifest.manifest.authority_mode).toBe('shared')
        expect(manifest.manifest.data_sources).toMatchObject([
          { data_source_id: 'data-source-1', database_id: 'data-source-1' },
        ])
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('track --mode local persists the local authority mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-track-'))
    try {
      const command = parseCliCommand(['track', 'data-source-1', dir, '--mode', 'local'])
      const ctx = parseCliContext({
        argv: ['track', 'data-source-1', dir],
        resolvedCommand: command,
      })
      ctx.store.close()
      await establishTrackedWorkspace({
        workspace: decode({ schema: AbsolutePath, value: dir }),
        mode: 'local',
      })
      const manifest = loadWorkspaceManifest(decode({ schema: AbsolutePath, value: dir }))
      expect(manifest._tag === 'tracked' && manifest.manifest.authority_mode).toBe('local')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('resolves a Notion database URL to a child data source for track', async () => {
    const calls = {
      retrieveDataSource: 0,
      queryDataSource: 0,
      retrievePage: 0,
      retrieveDatabase: 0,
    }
    const command = parseCliCommand([
      'track',
      'https://www.notion.so/example/0123456789abcdef0123456789abcdef?v=feedfacefeedfacefeedfacefeedface',
      '/tmp/notion-workspace',
      '--mode',
      'remote',
    ])

    const resolved = await Effect.runPromise(
      resolveCliCommandNotionRefs({
        command,
        options: { gatewayClient: makeInjectedNotionClient(calls) },
      }),
    )

    expect(resolved).toMatchObject({
      _tag: 'track',
      dataSourceId: testIds.dataSourceId,
      remoteRef: { _tag: 'data-source', dataSourceId: testIds.dataSourceId },
      authorityMode: 'remote',
    })
    expect(calls.retrieveDatabase).toBe(1)
  })

  it.each([
    { argv: ['migrate', 'store'] as const, expected: 'Expected one of:' },
    { argv: ['migrate', 'schema'] as const, expected: 'Expected one of:' },
    { argv: ['repair'] as const, expected: 'Expected one of:' },
  ])(
    'rejects removed command $argv before opening an explicit SQLite file',
    async ({ argv, expected }) => {
      const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-unsupported-'))
      const storePath = join(dir, 'store.sqlite')
      try {
        await createBoundSqlite({ path: storePath })
        await expect(
          runCli(
            [
              ...argv,
              '--sqlite',
              storePath,
              '--root-id',
              testIds.rootId,
              '--data-source-id',
              testIds.dataSourceId,
              '--workspace-root',
              workspaceRoot,
            ],
            { cwd: packageDir, timeout: cliTestTimeoutMs },
          ),
        ).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining(expected),
        })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    cliTestTimeoutMs,
  )

  it.each([
    {
      argv: ['init'] as const,
      expected: 'init is an internal reconciliation phase, not a public command; use `sync`',
    },
    {
      argv: ['pull'] as const,
      expected: 'pull is an internal reconciliation phase, not a public command; use `sync`',
    },
    {
      argv: ['push'] as const,
      expected: 'push is an internal reconciliation phase, not a public command; use `sync`',
    },
    {
      argv: ['sync', '--from-notion', 'data-source-1', workspaceRoot] as const,
      expected: 'sync --from-notion has been removed; use `track',
    },
  ])(
    'exits non-zero with clean-break guidance for the removed verb $argv at the binary entry',
    async ({ argv, expected }) => {
      const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-clean-break-'))
      const storePath = join(dir, 'store.sqlite')
      try {
        await createBoundSqlite({ path: storePath })
        await expect(
          runCli(
            [
              ...argv,
              '--sqlite',
              storePath,
              '--root-id',
              testIds.rootId,
              '--data-source-id',
              testIds.dataSourceId,
              '--workspace-root',
              workspaceRoot,
            ],
            { cwd: packageDir, timeout: cliTestTimeoutMs },
          ),
        ).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining(expected),
        })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    cliTestTimeoutMs,
  )

  it(
    'accepts valid numeric CLI flags',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-'))
      try {
        const sqlitePath = join(dir, 'store.sqlite')
        await createBoundSqlite({ path: sqlitePath })
        const { stdout } = await runCli(
          [
            'status',
            '--sqlite',
            sqlitePath,
            '--root-id',
            testIds.rootId,
            '--data-source-id',
            testIds.dataSourceId,
            '--workspace-root',
            workspaceRoot,
            '--max-executor-steps',
            '1',
          ],
          { cwd: packageDir, timeout: cliTestTimeoutMs },
        )

        expect(JSON.parse(stdout)).toMatchObject({
          _tag: 'CliResultEnvelope',
          command: 'status',
          ok: true,
        })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    cliTestTimeoutMs,
  )

  it('rejects query contracts before opening a product replica store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-context-'))
    const storePath = join(dir, 'store.sqlite')
    try {
      await expect(
        Effect.runPromise(
          runCliMain({
            argv: [
              'status',
              '--sqlite',
              storePath,
              '--root-id',
              testIds.rootId,
              '--data-source-id',
              testIds.dataSourceId,
              '--workspace-root',
              workspaceRoot,
              '--query-contract-json',
              JSON.stringify(defaultQueryContract()),
            ],
          }),
        ),
      ).rejects.toThrow('--query-contract-json is not supported')

      await expectSqliteStoreFilesAbsent(storePath)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('closes the store when command execution fails after context open', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-finalizer-'))
    const originalClose = NotionSyncStore.prototype.close
    const storePrototype = NotionSyncStore.prototype as {
      close: (this: NotionSyncStore) => void
    }
    let closeCalls = 0
    storePrototype.close = function close(this: NotionSyncStore) {
      closeCalls += 1
      return originalClose.call(this)
    }

    const failingGateway: NotionDataSourceGatewayShape = {
      apiContract: makeNotionApiContract({ supportedCapabilities: [] }),
      preflightCapabilities: () =>
        Effect.fail(
          makeGatewayError({
            operation: 'preflightCapabilities',
            dataSourceId: testIds.dataSourceId,
            guard: 'CapabilityPreflightFailed',
            message: 'forced preflight failure',
          }),
        ),
      retrieveDataSource: () => Effect.die('retrieveDataSource should not be called'),
      queryRows: () => Stream.die('queryRows should not be called'),
      retrievePage: () => Effect.die('retrievePage should not be called'),
      retrievePageProperty: () => Stream.die('retrievePageProperty should not be called'),
      patchPageProperties: () => Effect.die('patchPageProperties should not be called'),
      createPage: () => Effect.die('createPage should not be called'),
      patchDataSourceSchema: () => Effect.die('patchDataSourceSchema should not be called'),
      patchDataSourceMetadata: () => Effect.die('patchDataSourceMetadata should not be called'),
      patchDatabaseMetadata: () => Effect.die('patchDatabaseMetadata should not be called'),
      trashPage: () => Effect.die('trashPage should not be called'),
      restorePage: () => Effect.die('restorePage should not be called'),
    }

    try {
      await createBoundSqlite({ path: join(dir, 'store.sqlite') })
      closeCalls = 0
      await expect(
        Effect.runPromise(
          runCliMain({
            argv: [
              'sync',
              '--sqlite',
              join(dir, 'store.sqlite'),
              '--root-id',
              testIds.rootId,
              '--data-source-id',
              testIds.dataSourceId,
              '--workspace-root',
              workspaceRoot,
            ],
            options: { gateway: failingGateway },
          }),
        ),
      ).rejects.toThrow('forced preflight failure')
      expect(closeCalls).toBe(1)
    } finally {
      storePrototype.close = originalClose
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('renders sync progress on stderr while keeping the JSON result on stdout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-progress-'))
    const originalStdoutWrite = process.stdout.write
    const originalStderrWrite = process.stderr.write
    let stdout = ''
    let stderr = ''

    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += Buffer.isBuffer(chunk) === true ? chunk.toString('utf8') : String(chunk)
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += Buffer.isBuffer(chunk) === true ? chunk.toString('utf8') : String(chunk)
      return true
    }) as typeof process.stderr.write

    try {
      const sqlitePath = join(dir, 'store.sqlite')
      await createBoundSqlite({ path: sqlitePath })
      await Effect.runPromise(
        runCliMain({
          argv: [
            'sync',
            '--sqlite',
            sqlitePath,
            '--root-id',
            testIds.rootId,
            '--data-source-id',
            testIds.dataSourceId,
            '--workspace-root',
            workspaceRoot,
            '--no-materialize-bodies',
          ],
          options: {
            gateway: makeFakeGatewayHarness({ propertyPages: [propertyPage()] }).gateway,
          },
        }),
      )

      expect(JSON.parse(stdout)).toMatchObject({
        _tag: 'CliResultEnvelope',
        command: 'sync',
        ok: true,
      })
      expect(stderr).toContain('notion db')
      expect(stderr).toContain('sync')
      expect(stderr).toContain('100%')
    } finally {
      process.stdout.write = originalStdoutWrite
      process.stderr.write = originalStderrWrite
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('renders sync --watch progress on stderr through the top-level CLI wrapper', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-watch-progress-'))
    const originalStdoutWrite = process.stdout.write
    const originalStderrWrite = process.stderr.write
    let stdout = ''
    let stderr = ''

    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += Buffer.isBuffer(chunk) === true ? chunk.toString('utf8') : String(chunk)
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += Buffer.isBuffer(chunk) === true ? chunk.toString('utf8') : String(chunk)
      return true
    }) as typeof process.stderr.write

    try {
      const sqlitePath = join(dir, 'store.sqlite')
      await createBoundSqlite({ path: sqlitePath })
      await Effect.runPromise(
        runCliMain({
          argv: [
            'sync',
            '--watch',
            '--sqlite',
            sqlitePath,
            '--state',
            join(dir, 'watch.json'),
            '--max-cycles',
            '1',
            '--no-materialize-bodies',
          ],
          options: {
            gateway: makeFakeGatewayHarness({ propertyPages: [propertyPage()] }).gateway,
          },
        }),
      )

      expect(JSON.parse(stdout)).toMatchObject({
        _tag: 'CliResultEnvelope',
        command: 'sync',
        ok: true,
      })
      expect(stderr).toContain('notion db')
      expect(stderr).toContain('sync')
      expect(stderr).toContain('100%')
    } finally {
      process.stdout.write = originalStdoutWrite
      process.stderr.write = originalStderrWrite
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('wires pull/sync through an injected Notion client, generic body port, and filesystem workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-runtime-'))
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const calls = { retrieveDataSource: 0, queryDataSource: 0, retrievePage: 0 }
    const ctx = context({
      store: storeFixture.store,
      clock,
      workspaceRoot: decode({ schema: AbsolutePath, value: dir }),
      schemaProperties: [],
      webhookReceiverPort: 0,
    })
    const body = makeHarnessPorts({ bodyPages: [bodyPage()] }).body

    try {
      await Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'init',
            dataSourceId: testIds.dataSourceId,
            workspaceRoot: ctx.workspaceRoot,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      const result = await Effect.runPromise(
        runCliCommandWithRuntime({
          command: { _tag: 'sync' },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      expect(result).toMatchObject({
        _tag: 'CliResultEnvelope',
        command: 'sync',
        status: { state: 'clean' },
      })
      expect(calls).toEqual({ retrieveDataSource: 2, queryDataSource: 1, retrievePage: 0 })
      await expect(
        readFile(join(dir, `page-${testIds.pageId}--${testIds.pageId}.nmd`), 'utf8'),
      ).resolves.toContain('notion-datasource-sync body materialization placeholder')
    } finally {
      storeFixture.cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('wires CLI sync through a real NotionMD body adapter and materializing workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-nmd-runtime-'))
    const root = decode({ schema: AbsolutePath, value: dir })
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const markdown = '# CLI NotionMD body\n\nReal NotionMD CLI body.\n'
    const pullPageResult: PullPageResult = {
      page: {
        id: testIds.pageId,
        title: 'CLI NotionMD body',
        title_property_key: 'Name',
        url: undefined,
        parent: { type: 'workspace', workspace: true },
        icon: null,
        cover: null,
        in_trash: false,
        is_locked: false,
        last_edited_time: fixedObservedAt,
        properties: {},
      },
      markdown: {
        markdown,
        truncated: false,
        unknown_block_ids: [],
        body_evidence_fingerprint: notionMdBodyEvidenceFingerprint(hash(markdown)),
      },
      storage: {
        _tag: 'self_contained',
        unsupported_blocks: [],
        files: [],
        comments: [],
      },
    }
    const notionMdGateway: NotionMdGatewayShape = {
      pullPage: () => Effect.succeed(pullPageResult),
      updateMarkdown: () => Effect.die('updateMarkdown should not be called by this test'),
      updatePageProperties: () =>
        Effect.die('updatePageProperties should not be called by this test'),
      updatePageMetadata: () => Effect.die('updatePageMetadata should not be called by this test'),
      retrieveDataSource: () => Effect.die('retrieveDataSource should not be called by this test'),
      listChildPages: () => Effect.succeed([]),
      createPage: () => Effect.die('createPage should not be called by this test'),
      movePage: () => Effect.die('movePage should not be called by this test'),
      archivePage: () => Effect.die('archivePage should not be called by this test'),
    }

    try {
      const stateStore = await runWithNmdStateStore(NmdStateStore)
      const body = makeNotionMdPageBodySyncPort({ gateway: notionMdGateway })
      const workspace = makeNotionMdMaterializingLocalWorkspacePort({
        root,
        gateway: notionMdGateway,
        stateStore,
      })
      // SM5b: a tracked workspace carries `sourcePagesDir`, so the production
      // chain (context.sourcePagesDir -> remoteObservationContext ->
      // bodyPathForPage -> observeRemoteDataSource -> workspace.materialize)
      // materializes the `.nmd` under `pages/v1/<name>/` instead of the root.
      const pagesDir = pagesDirRelativePath(testIds.databaseId)
      const ctx = context({
        store: storeFixture.store,
        clock,
        workspaceRoot: root,
        sourcePagesDir: pagesDir,
        schemaProperties: [],
      })

      await runWithPorts(
        runCliCommand(
          {
            _tag: 'init',
            dataSourceId: testIds.dataSourceId,
            workspaceRoot: root,
          },
          ctx,
        ),
        { gateway: gateway.gateway, body, workspace },
      )

      const result = await runWithPorts(runCliCommand({ _tag: 'sync' }, ctx), {
        gateway: gateway.gateway,
        body,
        workspace,
      })
      const materializedPath = join(dir, pagesDir, `page-${testIds.pageId}--${testIds.pageId}.nmd`)
      const materialized = await readFile(materializedPath, 'utf8')

      expect(result).toMatchObject({
        _tag: 'CliResultEnvelope',
        command: 'sync',
        status: { state: 'clean' },
      })
      // The `.nmd` page file lands under the source's pages/v1/<name> directory.
      expect(materializedPath).toContain(`pages/v1/${testIds.databaseId}/`)
      expect(materialized).toContain('"page_id": "page-1"')
      expect(materialized).toContain('Real NotionMD CLI body.')
      expect(materialized).not.toContain('notion-datasource-sync body materialization placeholder')
    } finally {
      storeFixture.cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('establishes from Notion as a remote-only first run and reruns idempotently', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const ctx = context({ store: storeFixture.store, clock })
    const ports = makeHarnessPorts({ bodyPages: [bodyPage()] })
    const localWrites = {
      scans: 0,
      materializations: 0,
    }
    const workspace: LocalWorkspacePortShape = {
      scan: (root) => {
        localWrites.scans += 1
        return ports.workspace.scan(root)
      },
      claimPath: ports.workspace.claimPath,
      materialize: (plan) => {
        localWrites.materializations += 1
        return ports.workspace.materialize(plan)
      },
    }

    try {
      const first = await runWithPorts(
        runCliCommand(
          {
            _tag: 'track',
            dataSourceId: testIds.dataSourceId,
            remoteRef: { _tag: 'data-source', dataSourceId: testIds.dataSourceId },
            workspaceRoot,
            authorityMode: 'shared',
          },
          ctx,
        ),
        { gateway: gateway.gateway, body: ports.body, workspace },
      )
      const afterFirstEvents = storeFixture.store.replay(testIds.rootId).length
      clock.advanceMillis(1_000)
      const second = await runWithPorts(
        runCliCommand(
          {
            _tag: 'track',
            dataSourceId: testIds.dataSourceId,
            remoteRef: { _tag: 'data-source', dataSourceId: testIds.dataSourceId },
            workspaceRoot,
            authorityMode: 'shared',
          },
          ctx,
        ),
        { gateway: gateway.gateway, body: ports.body, workspace },
      )

      expect(first).toMatchObject({
        command: 'track',
        result: {
          mode: 'establish-from-notion',
          pushed: false,
          pull: { appendedEvents: expect.any(Number) },
        },
      })
      expect(
        (first.result as { readonly pull: { readonly appendedEvents: number } }).pull
          .appendedEvents,
      ).toBeGreaterThan(0)
      expect(second.result).toMatchObject({ pushed: false, pull: { appendedEvents: 0 } })
      expect(storeFixture.store.replay(testIds.rootId)).toHaveLength(afterFirstEvents)
      expect(storeFixture.store.readOutbox(testIds.rootId)).toHaveLength(0)
      expect(localWrites.scans).toBe(0)
      expect(localWrites.materializations).toBe(2)
      expect(gateway.ledger.attemptedPatchPageProperties).toHaveLength(0)
      expect(gateway.ledger.attemptedPatchDataSourceSchemas).toHaveLength(0)
    } finally {
      storeFixture.cleanup()
    }
  })

  it('dry-runs establishment without durable events or body materialization', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const ctx = context({ store: storeFixture.store, clock, materializeBodies: false })
    const ports = makeHarnessPorts({ bodyPages: [bodyPage()] })
    let materializations = 0
    const workspace: LocalWorkspacePortShape = {
      scan: ports.workspace.scan,
      claimPath: ports.workspace.claimPath,
      materialize: (plan) => {
        materializations += 1
        return ports.workspace.materialize(plan)
      },
    }

    try {
      const result = await runWithPorts(
        runCliCommand(
          {
            _tag: 'track',
            dataSourceId: testIds.dataSourceId,
            remoteRef: { _tag: 'data-source', dataSourceId: testIds.dataSourceId },
            workspaceRoot,
            authorityMode: 'shared',
            dryRun: true,
          },
          ctx,
        ),
        { gateway: gateway.gateway, body: ports.body, workspace },
      )

      expect(result.result).toMatchObject({
        pushed: false,
        binding: { binding: undefined },
        pull: { appendedEvents: 0 },
      })
      expect(storeFixture.store.replay(testIds.rootId)).toHaveLength(0)
      expect(materializations).toBe(0)
      expect(gateway.ledger.attemptedPatchPageProperties).toHaveLength(0)
    } finally {
      storeFixture.cleanup()
    }
  })

  it('bounded establishment dry-run observes only the preview row limit and writes nothing', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const pageIds = ['page-preview-1', 'page-preview-2', 'page-preview-3'].map((value) =>
      decode({ schema: PageId, value }),
    )
    const pages = pageIds.map((pageId, index) =>
      pageSnapshot({
        pageId,
        propertiesHash: hash(`preview-properties-${index}`),
      }),
    )
    const gateway = makeFakeGatewayHarness({ pages })
    const ctx = context({
      store: storeFixture.store,
      clock,
      materializeBodies: false,
    })
    const ports = makeHarnessPorts({
      bodyPages: pageIds.map((pageId, index) =>
        fakeBodyPage({
          pageId,
          pointer: bodyPointerForPage(pageId, hash(`preview-body-${index}`)),
        }),
      ),
    })
    let materializations = 0
    const workspace: LocalWorkspacePortShape = {
      scan: ports.workspace.scan,
      claimPath: ports.workspace.claimPath,
      materialize: (plan) => {
        materializations += 1
        return ports.workspace.materialize(plan)
      },
    }

    try {
      const result = await runWithPorts(
        runCliCommand(
          {
            _tag: 'track',
            dataSourceId: testIds.dataSourceId,
            remoteRef: { _tag: 'data-source', dataSourceId: testIds.dataSourceId },
            workspaceRoot,
            authorityMode: 'shared',
            dryRun: true,
            limit: 2,
          },
          { ...ctx, rowLimit: 2, queryContract: { ...ctx.queryContract, pageSize: 2 } },
        ),
        { gateway: gateway.gateway, body: ports.body, workspace },
      )
      const observation = (
        result.result as { readonly pull: { readonly observation: { readonly query: unknown } } }
      ).pull.observation.query

      expect(observation).toMatchObject({
        rows: 2,
        cappedAtLimit: true,
        rowLimit: 2,
      })
      expect(storeFixture.store.replay(testIds.rootId)).toHaveLength(0)
      expect(materializations).toBe(0)
    } finally {
      storeFixture.cleanup()
    }
  })

  it('blocks establishment when body materialization would overwrite an unmanaged file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-establish-collision-'))
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const calls = { retrieveDataSource: 0, queryDataSource: 0, retrievePage: 0 }
    const ctx = context({
      store: storeFixture.store,
      clock,
      workspaceRoot: decode({ schema: AbsolutePath, value: dir }),
      schemaProperties: [],
    })
    const expectedPath = join(dir, `page-${testIds.pageId}--${testIds.pageId}.nmd`)
    const body = makeHarnessPorts({ bodyPages: [bodyPage()] }).body

    try {
      await writeFile(expectedPath, 'local unmanaged draft', 'utf8')
      await expect(
        Effect.runPromise(
          runCliCommandWithRuntime({
            command: {
              _tag: 'track',
              dataSourceId: testIds.dataSourceId,
              remoteRef: { _tag: 'data-source', dataSourceId: testIds.dataSourceId },
              workspaceRoot: ctx.workspaceRoot,
              authorityMode: 'shared',
            },
            context: ctx,
            options: { gatewayClient: makeInjectedNotionClient(calls), body },
          }),
        ),
      ).rejects.toThrow('Workspace path collision has no sidecar or claim identity')
      expect(storeFixture.store.readOutbox(testIds.rootId)).toHaveLength(0)
    } finally {
      storeFixture.cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails closed when a discovered workspace binding does not match the config context', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const ctx = context({ store: storeFixture.store, clock })

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.otherDataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      await expect(
        runWithPorts(runCliCommand({ _tag: 'sync', workspaceRoot }, ctx), {
          gateway: gateway.gateway,
        }),
      ).rejects.toThrow('Workspace config/store binding mismatch')
    } finally {
      storeFixture.cleanup()
    }
  })

  it('runs one bounded sync --watch cycle through real runtime wiring over a temp filesystem', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-watch-'))
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const calls = { retrieveDataSource: 0, queryDataSource: 0, retrievePage: 0 }
    const ctx = context({
      store: storeFixture.store,
      clock,
      workspaceRoot: decode({ schema: AbsolutePath, value: dir }),
      schemaProperties: [],
    })
    const body = makeHarnessPorts({ bodyPages: [bodyPage()] }).body

    try {
      await Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'init',
            dataSourceId: testIds.dataSourceId,
            workspaceRoot: ctx.workspaceRoot,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      const result = await Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'sync',
            watch: true,
            statePath: join(dir, 'watch.json'),
            maxCycles: 1,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      expect(result).toMatchObject({
        command: 'sync',
        result: { _tag: 'WatchDaemonRunResult', cycles: 1, completed: 1 },
      })
      await expect(readFile(join(dir, 'watch.json'), 'utf8')).resolves.toContain(
        '"lastCompleteCycle": 1',
      )
    } finally {
      storeFixture.cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('runs sync --watch with manual webhook mode as a local receiver seam', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-watch-webhook-'))
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const calls = { retrieveDataSource: 0, queryDataSource: 0, retrievePage: 0 }
    const ctx = context({
      store: storeFixture.store,
      clock,
      workspaceRoot: decode({ schema: AbsolutePath, value: dir }),
      schemaProperties: [],
    })
    const body = makeHarnessPorts({ bodyPages: [bodyPage()] }).body

    try {
      await Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'init',
            dataSourceId: testIds.dataSourceId,
            workspaceRoot: ctx.workspaceRoot,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      const result = await Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'sync',
            watch: true,
            webhook: 'manual',
            statePath: join(dir, 'watch.json'),
            maxCycles: 1,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      expect(result).toMatchObject({
        command: 'sync',
        result: {
          _tag: 'SyncWatchRunResult',
          webhook: {
            _tag: 'WebhookManualStatus',
            provider: 'manual',
            state: 'running',
            receiver: {
              path: expect.stringMatching(webhookPathPattern),
            },
            exposure: {
              provider: 'manual',
              path: expect.stringMatching(webhookPathPattern),
            },
          },
          daemon: { _tag: 'WatchDaemonRunResult', cycles: 1, completed: 1 },
        },
      })
    } finally {
      storeFixture.cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('preserves an explicitly configured webhook receiver path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-watch-webhook-explicit-'))
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const calls = { retrieveDataSource: 0, queryDataSource: 0, retrievePage: 0 }
    const explicitPath = '/custom/notion/webhook'
    const ctx = context({
      store: storeFixture.store,
      clock,
      workspaceRoot: decode({ schema: AbsolutePath, value: dir }),
      schemaProperties: [],
      webhookReceiverPath: explicitPath,
    })
    const body = makeHarnessPorts({ bodyPages: [bodyPage()] }).body

    try {
      await Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'init',
            dataSourceId: testIds.dataSourceId,
            workspaceRoot: ctx.workspaceRoot,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      const result = await Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'sync',
            watch: true,
            webhook: 'manual',
            statePath: join(dir, 'watch.json'),
            maxCycles: 1,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      expect(result).toMatchObject({
        result: {
          _tag: 'SyncWatchRunResult',
          webhook: {
            _tag: 'WebhookManualStatus',
            receiver: { path: explicitPath },
            exposure: { path: explicitPath },
          },
        },
      })
    } finally {
      storeFixture.cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('checks Tailscale Funnel status for sync --watch --webhook tailscale', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-watch-tailscale-'))
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const calls = { retrieveDataSource: 0, queryDataSource: 0, retrievePage: 0 }
    const tailscaleCalls: string[][] = []
    let tailscaleWebhookPath = ''
    const ctx = context({
      store: storeFixture.store,
      clock,
      workspaceRoot: decode({ schema: AbsolutePath, value: dir }),
      schemaProperties: [],
      webhookReceiverPort: 0,
      tailscaleProcessRunner: async (command, args) => {
        tailscaleCalls.push([command, ...args])
        const setPath = args.find((arg) => arg.startsWith('--set-path='))
        if (setPath !== undefined && setPath.endsWith(' off') === false) {
          tailscaleWebhookPath = setPath.slice('--set-path='.length)
        }
        if (args.join(' ') !== 'funnel status --json') {
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            Web: [
              {
                Path: tailscaleWebhookPath,
                URL: `https://tasks.tailnet.example${tailscaleWebhookPath}`,
              },
            ],
          }),
          stderr: '',
        }
      },
    })
    const body = makeHarnessPorts({ bodyPages: [bodyPage()] }).body

    try {
      await Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'init',
            dataSourceId: testIds.dataSourceId,
            workspaceRoot: ctx.workspaceRoot,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      const result = await Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'sync',
            watch: true,
            webhook: 'tailscale',
            webhookRequired: true,
            statePath: join(dir, 'watch.json'),
            maxCycles: 1,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      expect(tailscaleCalls).toEqual([
        [
          'tailscale',
          'funnel',
          '--bg',
          '--https=443',
          expect.stringMatching(webhookSetPathPattern),
          expect.stringMatching(/^localhost:[0-9]+$/),
        ],
        ['tailscale', 'funnel', 'status', '--json'],
        ['tailscale', 'funnel', '--bg', expect.stringMatching(webhookSetPathPattern), 'off'],
      ])
      expect(result).toMatchObject({
        command: 'sync',
        result: {
          _tag: 'SyncWatchRunResult',
          webhook: {
            _tag: 'WebhookTailscaleStatus',
            provider: 'tailscale',
            state: 'running',
            receiver: {
              path: expect.stringMatching(webhookPathPattern),
            },
            exposure: {
              provider: 'tailscale-funnel',
              publicUrl: expect.stringMatching(
                /^https:\/\/tasks\.tailnet\.example\/notion-datasource-sync\/webhook\/notion\/[0-9a-f-]{36}$/,
              ),
              localTarget: expect.stringMatching(/^localhost:[0-9]+$/),
              path: expect.stringMatching(webhookPathPattern),
            },
          },
          daemon: { _tag: 'WatchDaemonRunResult', cycles: 1, completed: 1 },
        },
      })
    } finally {
      storeFixture.cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails sync --watch --webhook-required when Tailscale status is not running', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const ctx = context({
      store: storeFixture.store,
      clock,
      schemaProperties: [],
      webhookReceiverPort: 0,
      tailscaleProcessRunner: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'not running',
      }),
    })

    try {
      await expect(
        Effect.runPromise(
          runCliCommandWithRuntime({
            command: {
              _tag: 'sync',
              watch: true,
              webhook: 'tailscale',
              webhookRequired: true,
              maxCycles: 1,
            },
            context: ctx,
            options: {
              gatewayClient: makeInjectedNotionClient({
                retrieveDataSource: 0,
                queryDataSource: 0,
                retrievePage: 0,
              }),
            },
          }),
        ),
      ).rejects.toThrow('sync --watch --webhook-required could not start Tailscale Funnel')
    } finally {
      storeFixture.cleanup()
    }
  })

  it('wakes sync --watch from a manual webhook delivery before the normal poll interval', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-watch-wake-'))
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const calls = { retrieveDataSource: 0, queryDataSource: 0, retrievePage: 0 }
    let receiverResolve: ((status: { readonly url: string }) => void) | undefined
    const receiverStarted = new Promise<{ readonly url: string }>((resolve) => {
      receiverResolve = resolve
    })
    const ctx = context({
      store: storeFixture.store,
      clock,
      workspaceRoot: decode({ schema: AbsolutePath, value: dir }),
      schemaProperties: [],
      webhookReceiverPort: 0,
      webhookReceiverStarted: (status) => receiverResolve?.(status),
    })
    const body = makeHarnessPorts({ bodyPages: [bodyPage()] }).body
    const verificationToken = 'cli-watch-webhook-verification-token'
    const withTimeout = async <TValue>(promise: Promise<TValue>, millis: number): Promise<TValue> =>
      await Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`timed out after ${millis.toString()}ms`)), millis),
        ),
      ])
    const waitForFirstCycle = async () => {
      const deadline = Date.now() + 10_000
      await new Promise<void>((resolve, reject) => {
        const interval = setInterval(() => {
          void (async () => {
            try {
              const state = JSON.parse(await readFile(join(dir, 'watch.json'), 'utf8')) as {
                readonly lastCompleteCycle?: unknown
              }
              if (state.lastCompleteCycle === 1) {
                clearInterval(interval)
                resolve()
                return
              }
            } catch {
              // File is created after the first cycle completes.
            }
            if (Date.now() > deadline) {
              clearInterval(interval)
              reject(new Error('sync --watch did not complete first cycle'))
            }
          })()
        }, 25)
      })
    }

    try {
      await Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'init',
            dataSourceId: testIds.dataSourceId,
            workspaceRoot: ctx.workspaceRoot,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      const running = Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'sync',
            watch: true,
            webhook: 'manual',
            watchPriority: 'normal',
            statePath: join(dir, 'watch.json'),
            maxCycles: 2,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      const receiver = await withTimeout(receiverStarted, 1_000)
      await waitForFirstCycle()

      const verificationResponse = await fetch(receiver.url, {
        method: 'POST',
        body: JSON.stringify({ verification_token: verificationToken }),
        headers: { 'content-type': 'application/json' },
      })
      expect(verificationResponse.status).toBe(200)

      const rawBody = JSON.stringify({
        id: 'cli-watch-wake-event',
        type: 'page.updated',
        timestamp: '2026-05-29T08:00:00.000Z',
        entity: { id: testIds.pageId, type: 'page' },
        data: { parent: { data_source_id: testIds.dataSourceId } },
      })
      const eventResponse = await fetch(receiver.url, {
        method: 'POST',
        body: rawBody,
        headers: {
          'content-type': 'application/json',
          'x-notion-signature': computeNotionWebhookSignature({ rawBody, verificationToken }),
        },
      })
      expect(eventResponse.status).toBe(200)

      const result = await withTimeout(running, 10_000)
      expect(result).toMatchObject({
        command: 'sync',
        result: {
          _tag: 'SyncWatchRunResult',
          daemon: { _tag: 'WatchDaemonRunResult', cycles: 2, completed: 2 },
        },
      })
      expect(storeFixture.store.readSignalStatus(testIds.rootId)).toEqual({
        pending: 0,
        claimed: 0,
        processed: 1,
        failed: 0,
      })
    } finally {
      storeFixture.cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('wakes sync --watch from a Tailscale webhook delivery before the normal poll interval', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-watch-tailscale-wake-'))
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const calls = { retrieveDataSource: 0, queryDataSource: 0, retrievePage: 0 }
    let receiverResolve: ((status: { readonly url: string }) => void) | undefined
    const receiverStarted = new Promise<{ readonly url: string }>((resolve) => {
      receiverResolve = resolve
    })
    const tailscaleCalls: string[][] = []
    let tailscaleWebhookPath = ''
    const ctx = context({
      store: storeFixture.store,
      clock,
      workspaceRoot: decode({ schema: AbsolutePath, value: dir }),
      schemaProperties: [],
      webhookReceiverPort: 0,
      webhookReceiverStarted: (status) => receiverResolve?.(status),
      tailscaleProcessRunner: async (command, args) => {
        tailscaleCalls.push([command, ...args])
        const setPath = args.find((arg) => arg.startsWith('--set-path='))
        if (setPath !== undefined) {
          tailscaleWebhookPath = setPath.slice('--set-path='.length)
        }
        if (args.join(' ') !== 'funnel status --json') {
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            Web: [
              {
                Path: tailscaleWebhookPath,
                URL: `https://tasks.tailnet.example${tailscaleWebhookPath}`,
              },
            ],
          }),
          stderr: '',
        }
      },
    })
    const body = makeHarnessPorts({ bodyPages: [bodyPage()] }).body
    const verificationToken = 'cli-watch-tailscale-webhook-verification-token'
    const withTimeout = async <TValue>(promise: Promise<TValue>, millis: number): Promise<TValue> =>
      await Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`timed out after ${millis.toString()}ms`)), millis),
        ),
      ])
    const waitForFirstCycle = async () => {
      const deadline = Date.now() + 10_000
      await new Promise<void>((resolve, reject) => {
        const interval = setInterval(() => {
          void (async () => {
            try {
              const state = JSON.parse(await readFile(join(dir, 'watch.json'), 'utf8')) as {
                readonly lastCompleteCycle?: unknown
              }
              if (state.lastCompleteCycle === 1) {
                clearInterval(interval)
                resolve()
                return
              }
            } catch {
              // File is created after the first cycle completes.
            }
            if (Date.now() > deadline) {
              clearInterval(interval)
              reject(new Error('sync --watch did not complete first cycle'))
            }
          })()
        }, 25)
      })
    }

    try {
      await Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'init',
            dataSourceId: testIds.dataSourceId,
            workspaceRoot: ctx.workspaceRoot,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      const running = Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'sync',
            watch: true,
            webhook: 'tailscale',
            watchPriority: 'normal',
            statePath: join(dir, 'watch.json'),
            maxCycles: 2,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      const receiver = await withTimeout(receiverStarted, 1_000)
      await waitForFirstCycle()

      const verificationResponse = await fetch(receiver.url, {
        method: 'POST',
        body: JSON.stringify({ verification_token: verificationToken }),
        headers: { 'content-type': 'application/json' },
      })
      expect(verificationResponse.status).toBe(200)

      const rawBody = JSON.stringify({
        id: 'cli-watch-tailscale-wake-event',
        type: 'page.updated',
        timestamp: '2026-05-29T08:00:00.000Z',
        entity: { id: testIds.pageId, type: 'page' },
        data: { parent: { data_source_id: testIds.dataSourceId } },
      })
      const eventResponse = await fetch(receiver.url, {
        method: 'POST',
        body: rawBody,
        headers: {
          'content-type': 'application/json',
          'x-notion-signature': computeNotionWebhookSignature({ rawBody, verificationToken }),
        },
      })
      expect(eventResponse.status).toBe(200)

      const result = await withTimeout(running, 10_000)
      expect(result).toMatchObject({
        command: 'sync',
        result: {
          _tag: 'SyncWatchRunResult',
          webhook: { provider: 'tailscale', state: 'running' },
          daemon: { _tag: 'WatchDaemonRunResult', cycles: 2, completed: 2 },
        },
      })
      expect(tailscaleCalls).toEqual([
        [
          'tailscale',
          'funnel',
          '--bg',
          '--https=443',
          expect.stringMatching(webhookSetPathPattern),
          expect.stringMatching(/^localhost:[0-9]+$/),
        ],
        ['tailscale', 'funnel', 'status', '--json'],
        ['tailscale', 'funnel', '--bg', expect.stringMatching(webhookSetPathPattern), 'off'],
      ])
      expect(storeFixture.store.readSignalStatus(testIds.rootId)).toEqual({
        pending: 0,
        claimed: 0,
        processed: 1,
        failed: 0,
      })
    } finally {
      storeFixture.cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns clean, pending, and conflict status envelopes for one-shot sync', async () => {
    const cleanClock = makeFakeClock()
    const cleanStore = makeStoreFixture({ mode: 'memory', now: cleanClock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })

    try {
      await runWithPorts(
        runCliCommand(
          {
            _tag: 'init',
            dataSourceId: testIds.dataSourceId,
            workspaceRoot,
          },
          context({ store: cleanStore.store, clock: cleanClock }),
        ),
        { gateway: gateway.gateway },
      )
      const clean = await runWithPorts(
        runCliCommand({ _tag: 'sync' }, context({ store: cleanStore.store, clock: cleanClock })),
        { gateway: gateway.gateway },
      )
      expect(clean).toMatchObject({
        _tag: 'CliResultEnvelope',
        command: 'sync',
        status: { state: 'clean' },
      })
    } finally {
      cleanStore.cleanup()
    }

    const pendingClock = makeFakeClock()
    const pendingStore = makeStoreFixture({ mode: 'memory', now: pendingClock.now })
    try {
      initOneShotSync({
        store: pendingStore.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: pendingClock.now,
      })
      await runWithPorts(
        pullOneShotSync({
          ...context({ store: pendingStore.store, clock: pendingClock }),
          store: pendingStore.store,
        }),
        { gateway: gateway.gateway },
      )
      const pending = await runWithPorts(
        runCliCommand(
          { _tag: 'sync' },
          context({ store: pendingStore.store, clock: pendingClock, maxExecutorSteps: 0 }),
        ),
        {
          gateway: gateway.gateway,
          body: makeHarnessPorts({ bodyPages: [bodyPage()] }).body,
          workspace: makeHarnessPorts({
            localObservations: [
              presentArtifactObservation({
                pageId: testIds.pageId,
                path: decode({ schema: WorkspaceRelativePath, value: 'row--page-1.nmd' }),
                contentHash: hash('body-local'),
                observedAt: decode({
                  schema: Schema.DateTimeUtcFromString,
                  value: fixedObservedAt,
                }),
              }),
            ],
          }).workspace,
        },
      )
      expect(pending.status.state).toBe('pending')
      expect(pending.status.counts.pending).toBe(1)
    } finally {
      pendingStore.cleanup()
    }

    const conflictClock = makeFakeClock()
    const conflictStore = makeStoreFixture({ mode: 'memory', now: conflictClock.now })
    try {
      initOneShotSync({
        store: conflictStore.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: conflictClock.now,
      })
      await runWithPorts(
        pullOneShotSync({
          ...context({ store: conflictStore.store, clock: conflictClock }),
          store: conflictStore.store,
        }),
        { gateway: gateway.gateway },
      )
      const conflict = await runWithPorts(
        runCliCommand(
          { _tag: 'sync' },
          context({ store: conflictStore.store, clock: conflictClock }),
        ),
        {
          gateway: gateway.gateway,
          body: makeHarnessPorts({ bodyPages: [bodyPage(hash('body-a'), hash('body-remote'))] })
            .body,
          workspace: makeHarnessPorts({
            localObservations: [
              presentArtifactObservation({
                pageId: testIds.pageId,
                path: decode({ schema: WorkspaceRelativePath, value: 'row--page-1.nmd' }),
                contentHash: hash('body-local'),
                observedAt: decode({
                  schema: Schema.DateTimeUtcFromString,
                  value: fixedObservedAt,
                }),
              }),
            ],
          }).workspace,
        },
      )
      expect(conflict.status.state).toBe('conflict')
      expect(conflict.surface.conflicts).toHaveLength(1)
    } finally {
      conflictStore.cleanup()
    }
  })

  it('dry-runs push and sync without appending events, mutating outbox, or issuing remote writes', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const ctx = context({ store: storeFixture.store, clock })
    const ports = makeHarnessPorts({
      bodyPages: [bodyPage()],
      localObservations: [
        presentArtifactObservation({
          pageId: testIds.pageId,
          path: decode({ schema: WorkspaceRelativePath, value: 'row--page-1.nmd' }),
          contentHash: hash('body-local'),
          observedAt: decode({ schema: Schema.DateTimeUtcFromString, value: fixedObservedAt }),
        }),
      ],
    })

    try {
      await runWithPorts(
        runCliCommand(
          {
            _tag: 'init',
            dataSourceId: testIds.dataSourceId,
            workspaceRoot,
          },
          ctx,
        ),
        { gateway: gateway.gateway },
      )
      await runWithPorts(pullOneShotSync({ ...ctx, store: storeFixture.store }), {
        gateway: gateway.gateway,
      })

      const beforeEvents = storeFixture.store.replay(testIds.rootId).length
      const beforeOutbox = storeFixture.store.readOutbox(testIds.rootId).length

      const push = await runWithPorts(runCliCommand({ _tag: 'push', dryRun: true }, ctx), {
        gateway: gateway.gateway,
        body: ports.body,
        workspace: ports.workspace,
      })
      expect(push.result).toMatchObject({
        plan: { decisions: [{ _tag: 'EnqueueCommands' }] },
        executor: { steps: 0, results: [] },
      })

      const sync = await runWithPorts(runCliCommand({ _tag: 'sync', dryRun: true }, ctx), {
        gateway: gateway.gateway,
        body: ports.body,
        workspace: ports.workspace,
      })
      expect(sync.result).toMatchObject({
        pull: { appendedEvents: 0 },
        push: { plan: { decisions: [{ _tag: 'EnqueueCommands' }] } },
      })

      expect(storeFixture.store.replay(testIds.rootId)).toHaveLength(beforeEvents)
      expect(storeFixture.store.readOutbox(testIds.rootId)).toHaveLength(beforeOutbox)
      expect(gateway.ledger.attemptedPatchPageProperties).toHaveLength(0)
      expect(gateway.ledger.attemptedPatchDataSourceSchemas).toHaveLength(0)
      expect(gateway.ledger.attemptedTrashPages).toHaveLength(0)
      expect(gateway.ledger.attemptedRestorePages).toHaveLength(0)
    } finally {
      storeFixture.cleanup()
    }
  })

  it('push reads pending public rows changes from the replica SQLite file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-push-rows-'))
    const sqlitePath = join(dir, 'store.sqlite')
    const clock = makeFakeClock()
    let store: NotionSyncStore | undefined

    try {
      await createBoundSqlite({ path: sqlitePath })
      const database = new DatabaseSync(sqlitePath)
      try {
        database
          .prepare(`UPDATE pages SET "Row_prop_a" = ? WHERE _page_id = ?`)
          .run('CLI push row edit', testIds.pageId)
      } finally {
        database.close()
      }

      store = openNotionSyncStore({ path: sqlitePath, now: clock.now })
      const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
      const result = await runWithPorts(
        runCliCommand(
          { _tag: 'push', dryRun: true },
          context({ store, storePath: sqlitePath, clock }),
        ),
        {
          gateway: gateway.gateway,
        },
      )

      expect(result.result).toMatchObject({
        plan: { decisions: [{ _tag: 'EnqueueCommands' }] },
        executor: { steps: 0, results: [] },
      })
      expect(gateway.ledger.attemptedPatchPageProperties).toEqual([])
    } finally {
      store?.close()
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('exports rows, schema, sync status, and pending metadata from the replica', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-export-'))
    const sqlitePath = join(dir, 'store.sqlite')
    const outputPath = join(dir, 'export.ndjson')
    const clock = makeFakeClock()
    let store: NotionSyncStore | undefined

    try {
      await createBoundSqlite({ path: sqlitePath })
      const database = new DatabaseSync(sqlitePath)
      try {
        database
          .prepare(`UPDATE pages SET "Row_prop_a" = ? WHERE _page_id = ?`)
          .run('Pending export edit', testIds.pageId)
      } finally {
        database.close()
      }

      store = openNotionSyncStore({ path: sqlitePath, now: clock.now })
      const result = await runWithPorts(
        runCliCommand(
          {
            _tag: 'export',
            outputPath: decode({ schema: AbsolutePath, value: outputPath }),
            format: 'ndjson',
          },
          context({ store, storePath: sqlitePath, clock }),
        ),
        { gateway: makeFakeGatewayHarness({ propertyPages: [propertyPage()] }).gateway },
      )

      expect(result.command).toBe('export')
      expect(result.result).toMatchObject({
        _tag: 'ReplicaExportResult',
        clean: false,
        counts: { pages: 1, pendingChanges: 1 },
      })
      const lines = (await readFile(outputPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(lines.map((line) => line.type)).toEqual(
        expect.arrayContaining(['metadata', 'sync_status', 'schema', 'schema_property', 'page']),
      )
      expect(lines).toContainEqual(
        expect.objectContaining({
          type: 'pending_change',
          record: expect.objectContaining({ status: 'pending' }),
        }),
      )

      await expect(
        runWithPorts(
          runCliCommand(
            {
              _tag: 'export',
              outputPath: decode({ schema: AbsolutePath, value: join(dir, 'clean.ndjson') }),
              format: 'ndjson',
              requireClean: true,
            },
            context({ store, storePath: sqlitePath, clock }),
          ),
          { gateway: makeFakeGatewayHarness({ propertyPages: [propertyPage()] }).gateway },
        ),
      ).rejects.toThrow('Replica has pending local changes or open conflicts')
    } finally {
      store?.close()
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)

  // Plain `export --dry-run` (no refresh): this test proves output-file and
  // output-directory write suppression directly. Projection-write suppression is
  // proven non-vacuously by the `export --refresh --dry-run` test below: both
  // paths share the same `projectReplicaIfWritable` dry-run early-return.
  it('export --dry-run produces the plan but writes no output file or output directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-export-dry-run-'))
    const sqlitePath = join(dir, 'store.sqlite')
    // Nested, non-existent output directory: a real run would `mkdirSync` it.
    // Dry-run must suppress that directory creation too, not just the file.
    const outputDir = join(dir, 'exports', 'nested')
    const outputPath = join(outputDir, 'export.ndjson')
    const clock = makeFakeClock()
    let store: NotionSyncStore | undefined

    try {
      await createBoundSqlite({ path: sqlitePath })
      store = openNotionSyncStore({ path: sqlitePath, now: clock.now })
      const result = await runWithPorts(
        runCliCommand(
          {
            _tag: 'export',
            outputPath: decode({ schema: AbsolutePath, value: outputPath }),
            format: 'ndjson',
            dryRun: true,
          },
          context({ store, storePath: sqlitePath, clock }),
        ),
        { gateway: makeFakeGatewayHarness({ propertyPages: [propertyPage()] }).gateway },
      )

      // Reads still run: the plan/counts are computed from the real replica.
      expect(result.command).toBe('export')
      expect(result.result).toMatchObject({
        _tag: 'ReplicaExportResult',
        outputPath,
        counts: { pages: 1 },
      })
      // ...but neither the output file nor its (nested) parent directory is
      // created — proving `mkdirSync` suppression, not just file absence.
      await expect(access(outputPath)).rejects.toThrow()
      await expect(access(outputDir)).rejects.toThrow()
    } finally {
      store?.close()
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('export --refresh --dry-run observes remotely but suppresses projection, hidden, and output writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-export-refresh-dry-run-'))
    const sqlitePath = join(dir, 'store.sqlite')
    const outputPath = join(dir, 'export.ndjson')

    try {
      await createBoundSqlite({ path: sqlitePath })
      // Snapshot the unified `--sqlite` store: a suppressed refresh must leave
      // both the public projection AND the hidden event log byte-identical.
      const before = await readFile(sqlitePath)
      const calls = { retrieveDataSource: 0, queryDataSource: 0, retrievePage: 0 }
      const client = {
        ...makeInjectedNotionClient(calls),
        updatePage: () => {
          throw new Error('export must not update pages')
        },
        createPage: () => {
          throw new Error('export must not create pages')
        },
        updateDataSource: () => {
          throw new Error('export must not update data sources')
        },
        updateDatabase: () => {
          throw new Error('export must not update databases')
        },
      } satisfies NotionGatewayClient

      const argv = [
        'export',
        '--sqlite',
        sqlitePath,
        '--refresh',
        '--dry-run',
        '--output',
        outputPath,
        '--no-materialize-bodies',
      ] as readonly string[]
      const command = parseCliCommand(argv)
      const ctx = parseCliContext({ argv, resolvedCommand: command })
      try {
        const result = await runCliCommandWithRuntime({
          command,
          context: ctx,
          options: { gatewayClient: client },
        }).pipe(Effect.runPromise)
        expect(result.command).toBe('export')
      } finally {
        ctx.store.close()
      }

      // Real reads still run so the refresh/export plan can be reported — but
      // never a remote write (the throwing gateway methods above guarantee it).
      expect(calls.retrieveDataSource).toBeGreaterThan(0)
      // No projection or hidden write: the store file is byte-for-byte unchanged.
      expect(await readFile(sqlitePath)).toEqual(before)
      // No export output written.
      await expect(access(outputPath)).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('refreshes the established binding via export --refresh by pull only and never invokes remote writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-export-refresh-'))
    const sqlitePath = join(dir, 'store.sqlite')
    const outputPath = join(dir, 'export.json')

    try {
      // Drive through argv/`parseCliContext` so the store-resolution path
      // (resolving the established binding from `--sqlite`, no remote ref) is
      // actually exercised — `export --refresh` operates on the existing data
      // file only (CLI-R02).
      await createBoundSqlite({ path: sqlitePath })
      const calls = { retrieveDataSource: 0, queryDataSource: 0, retrievePage: 0 }
      const client = {
        ...makeInjectedNotionClient(calls),
        updatePage: () => {
          throw new Error('export must not update pages')
        },
        createPage: () => {
          throw new Error('export must not create pages')
        },
        updateDataSource: () => {
          throw new Error('export must not update data sources')
        },
        updateDatabase: () => {
          throw new Error('export must not update databases')
        },
      } satisfies NotionGatewayClient

      const argv = [
        'export',
        '--sqlite',
        sqlitePath,
        '--refresh',
        '--output',
        outputPath,
        '--format',
        'json',
        '--no-materialize-bodies',
      ] as readonly string[]
      const command = parseCliCommand(argv)
      const ctx = parseCliContext({ argv, resolvedCommand: command })
      try {
        await runCliCommandWithRuntime({
          command,
          context: ctx,
          options: { gatewayClient: client },
        }).pipe(Effect.runPromise)
      } finally {
        ctx.store.close()
      }

      expect(calls.retrieveDataSource).toBeGreaterThan(0)
      expect(calls.queryDataSource).toBeGreaterThan(0)
      const exported = JSON.parse(await readFile(outputPath, 'utf8'))
      expect(exported).toMatchObject({
        _tag: 'NotionDatasourceReplicaExport',
        sync: { status: expect.any(Object) },
      })
      expect(exported).not.toHaveProperty('bodies')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('lists and resolves conflicts through the existing user-command API', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })

    try {
      const conflict = storeFixture.store.appendEvent(conflictEvent())
      const ctx = context({ store: storeFixture.store, clock })

      const listed = await runWithPorts(runCliCommand({ _tag: 'conflicts-list' }, ctx), {
        gateway: gateway.gateway,
      })
      expect(listed).toMatchObject({
        command: 'conflicts-list',
        status: { state: 'conflict' },
        surface: { conflicts: [{ state: 'open' }] },
      })

      const resolved = await runWithPorts(
        runCliCommand(
          {
            _tag: 'conflicts-resolve',
            conflictId: decode({ schema: SyncEventId, value: conflict.eventId }),
            choice: { _tag: 'keep-remote' },
          },
          ctx,
        ),
        { gateway: gateway.gateway },
      )
      expect(resolved.result).toMatchObject({
        _tag: 'UserCommandResultEnvelope',
        action: 'resolve-conflict:keep-remote',
        applied: { events: [{ _tag: 'ConflictResolved' }] },
      })
      expect(resolved.status.state).toBe('clean')

      const forget = await runWithPorts(
        runCliCommand({ _tag: 'forget', pageId: testIds.pageId }, ctx),
        { gateway: gateway.gateway },
      )
      expect(forget.result).toMatchObject({
        _tag: 'UserCommandResultEnvelope',
        action: 'forget-page',
        applied: { events: [{ _tag: 'RowForgotten' }] },
      })

      const restore = await runWithPorts(
        runCliCommand({ _tag: 'restore', pageId: testIds.pageId, dryRun: true }, ctx),
        { gateway: gateway.gateway },
      )
      expect(restore.result).toMatchObject({
        _tag: 'UserCommandResultEnvelope',
        action: 'restore-page',
        dryRun: true,
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('dry-runs conflict resolution, forget, and restore without appending events or outbox rows', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })

    try {
      const conflict = storeFixture.store.appendEvent(conflictEvent())
      const ctx = context({ store: storeFixture.store, clock })
      const beforeEvents = storeFixture.store.replay(testIds.rootId).length
      const beforeOutbox = storeFixture.store.readOutbox(testIds.rootId).length

      const resolved = await runWithPorts(
        runCliCommand(
          {
            _tag: 'conflicts-resolve',
            conflictId: decode({ schema: SyncEventId, value: conflict.eventId }),
            choice: { _tag: 'keep-remote' },
            dryRun: true,
          },
          ctx,
        ),
        { gateway: gateway.gateway },
      )
      expect(resolved.result).toMatchObject({
        _tag: 'UserCommandResultEnvelope',
        action: 'resolve-conflict:keep-remote',
        dryRun: true,
        applied: { events: [], commands: [] },
      })

      const forget = await runWithPorts(
        runCliCommand({ _tag: 'forget', pageId: testIds.pageId, dryRun: true }, ctx),
        { gateway: gateway.gateway },
      )
      expect(forget.result).toMatchObject({
        _tag: 'UserCommandResultEnvelope',
        action: 'forget-page',
        dryRun: true,
        applied: { events: [] },
      })

      const restore = await runWithPorts(
        runCliCommand({ _tag: 'restore', pageId: testIds.pageId, dryRun: true }, ctx),
        { gateway: gateway.gateway },
      )
      expect(restore.result).toMatchObject({
        _tag: 'UserCommandResultEnvelope',
        action: 'restore-page',
        dryRun: true,
        applied: { events: [], commands: [] },
      })

      expect(storeFixture.store.replay(testIds.rootId)).toHaveLength(beforeEvents)
      expect(storeFixture.store.readOutbox(testIds.rootId)).toHaveLength(beforeOutbox)
    } finally {
      storeFixture.cleanup()
    }
  })
})
