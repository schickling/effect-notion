import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { Effect, Layer, Redacted, Schema, Stream } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { HttpClient } from 'effect/unstable/http/HttpClient'

import {
  NOTION_API_VERSION,
  NotionConfig,
  NotionBlocks,
  NotionConfigLive,
  NotionDataSources,
  NotionDatabases,
  NotionPages,
} from '@overeng/notion-effect-client'
import { NotionMdGateway, NotionMdGatewayLive } from '@overeng/notion-md'

import { makeNotionMdPageBodySyncPort } from '../body/notion-md.ts'
import { PatchDataSourceMetadataCommand, type QueryContract } from '../core/commands.ts'
import {
  AbsolutePath,
  DataSourceId,
  PageId,
  PropertyId,
  type CapabilityName,
} from '../core/domain.ts'
import { SyncRootId } from '../core/events.ts'
import { guardCapabilities } from '../core/guards.ts'
import { LocalWorkspacePort, NotionDataSourceGateway, PageBodySyncPort } from '../core/ports.ts'
import { readOnlyGatewayCapabilities } from '../gateway/gateway.ts'
import {
  makeNotionDataSourceGatewayFromClient,
  makeNotionEffectClientGatewayClient,
  makeThrottledProvideClientEnv,
  NotionDataSourceGatewayLive,
  schemaPropertyObservationsFromRemoteProperties,
} from '../gateway/notion.ts'
import { makeFilesystemLocalWorkspacePort } from '../local/workspace.ts'
import { commandIdFor, observeRemoteDataSource } from '../sync/observation.ts'

/** Raw environment variables consumed by live-Notion E2E tests, parsed from `process.env` before validation. */
export type LiveNotionEnv = {
  readonly enabled: boolean
  readonly token: string | undefined
  readonly tokenSource: 'NOTION_API_TOKEN' | 'NOTION_TOKEN' | undefined
  readonly parentPageId: string | undefined
  readonly dataSourceId: string | undefined
  readonly e2eLedgerPageId?: string | undefined
  readonly demoPageId?: string | undefined
  readonly requiredCapabilities: string | undefined
  readonly ledgerPath: string | undefined
}

/** Tagged union representing the outcome of parsing live-Notion E2E config — either skipped, invalid, or fully configured with a run ID. */
export type LiveNotionConfig =
  | {
      readonly _tag: 'not-configured'
      readonly skipReason: string
      readonly missing: ReadonlyArray<string>
    }
  | {
      readonly _tag: 'invalid-config'
      readonly message: string
      readonly missing: ReadonlyArray<string>
      readonly invalid: ReadonlyArray<string>
    }
  | {
      readonly _tag: 'configured'
      readonly runId: string
      readonly parentPageId: string
      readonly dataSourceId: string | undefined
      readonly notionVersion: typeof NOTION_API_VERSION
      readonly requiredCapabilities: ReadonlyArray<CapabilityName>
      readonly ledgerPath: string
      readonly e2eLedgerPageId?: string | undefined
      readonly demoPageId?: string | undefined
    }

/** Narrowed alias for the `'configured'` variant of `LiveNotionConfig` — guarantees a run ID, parent page, and ledger path are present. */
export type ConfiguredLiveNotionConfig = Extract<LiveNotionConfig, { readonly _tag: 'configured' }>

/** `ConfiguredLiveNotionConfig` narrowed further to guarantee `dataSourceId` is non-undefined — required for fixture lifecycle and preflight operations. */
export type LiveNotionConfigWithDataSource = ConfiguredLiveNotionConfig & {
  readonly dataSourceId: string
}

/** Single record in the fixture ledger tracking one Notion object through its lifecycle phase and current cleanup state. */
export type LiveFixtureLedgerEntry = {
  readonly phase: 'preflight' | 'create' | 'mutate' | 'verify' | 'trash' | 'restore'
  readonly objectId: string
  readonly objectType: 'page' | 'data_source' | 'database' | 'block' | 'file'
  readonly purpose: string
  readonly cleanupState:
    | 'created'
    | 'mutated'
    | 'verified'
    | 'trashed'
    | 'restored'
    | 'verified-cleaned'
    | 'cleanup-failed'
}

/** Append-only run ledger written to disk (and optionally published to Notion) so fixture cleanup state survives test crashes. */
export type LiveFixtureLedger = {
  readonly runId: string
  readonly notionVersion: typeof NOTION_API_VERSION
  readonly entries: ReadonlyArray<LiveFixtureLedgerEntry>
}

/** Structured result returned by `runLiveNotionPreflight` — carries capability sets, the initial ledger snapshot, and identifiers for the run. */
export type LiveNotionPreflightResult = {
  readonly runId: string
  readonly dataSourceId: string
  readonly parentPageId: string
  readonly supportedCapabilities: ReadonlyArray<CapabilityName>
  readonly missingCapabilities: ReadonlyArray<CapabilityName>
  readonly ledgerPath: string
  readonly ledger: LiveFixtureLedger
}

/** Optional overrides for `runLiveNotionPreflight` — swap the gateway layer in unit tests or inject a custom ledger writer/initial state. */
export type LiveNotionPreflightOptions = {
  readonly gatewayLayer?: Layer.Layer<NotionDataSourceGateway>
  readonly writeLedger?: WriteLiveFixtureLedger
  readonly initialLedger?: LiveFixtureLedger
}

/** Minimal identity descriptor for a Notion object created by a fixture lifecycle step — passed between create/mutate/verify/trash/restore callbacks. */
export type LiveFixtureObject = {
  readonly objectId: string
  readonly objectType: LiveFixtureLedgerEntry['objectType']
  readonly purpose: string
}

/** Strategy interface that a test supplies to drive a single fixture through the full create→mutate→verify→trash→restore lifecycle against real Notion. */
export type LiveFixtureLifecycleClient = {
  readonly create: (input: {
    readonly runId: string
    readonly parentPageId: string
    readonly dataSourceId: string
  }) => Promise<LiveFixtureObject>
  readonly mutate: (fixture: LiveFixtureObject) => Promise<LiveFixtureObject>
  readonly verify: (fixture: LiveFixtureObject) => Promise<void>
  readonly trash: (fixture: LiveFixtureObject) => Promise<void>
  readonly restore: (fixture: LiveFixtureObject) => Promise<void>
}

/** Optional overrides for `runLiveFixtureLifecycle` and `runLiveFixtureSoak` — inject a custom ledger writer or seed the ledger with prior state. */
export type LiveFixtureLifecycleOptions = {
  readonly writeLedger?: WriteLiveFixtureLedger
  readonly initialLedger?: LiveFixtureLedger
}

/** Latest unclean ledger object that a resumed run should clean before starting new live fixture work. */
export type LiveFixtureCleanupResumeTarget = LiveFixtureObject & {
  readonly cleanupState: Exclude<LiveFixtureLedgerEntry['cleanupState'], 'verified-cleaned'>
}

/** Thrown when a fixture trash or restore step fails; carries the final ledger state so the caller can persist or report partial cleanup. */
export class LiveFixtureCleanupError extends Error {
  readonly phase: 'trash' | 'restore'
  readonly ledger: LiveFixtureLedger

  constructor(input: {
    readonly phase: 'trash' | 'restore'
    readonly cause: unknown
    readonly ledger: LiveFixtureLedger
  }) {
    super(`live fixture cleanup failed during ${input.phase}`, { cause: input.cause })
    this.name = 'LiveFixtureCleanupError'
    this.phase = input.phase
    this.ledger = input.ledger
  }
}

/** Default capability set for preflight checks — mirrors `readOnlyGatewayCapabilities`, sufficient for read-only E2E tests. */
export const defaultLivePreflightCapabilities =
  readOnlyGatewayCapabilities satisfies ReadonlyArray<CapabilityName>

/** Stricter capability set that requires paginated property access in addition to basic retrieve/query — used by the demo showcase and soak tests. */
export const strictLivePreflightCapabilities = [
  'data_source_retrieve',
  'data_source_query',
  'data_source_metadata_update',
  'page_retrieve',
  'page_property_paginate',
  'page_create',
] as const satisfies ReadonlyArray<CapabilityName>

const capabilityNames = new Set<CapabilityName>([
  'data_source_retrieve',
  'data_source_query',
  'data_source_metadata_update',
  'page_retrieve',
  'page_property_paginate',
  'page_property_update',
  'page_create',
  'schema_update',
  'page_trash',
  'page_restore',
])

/** Read live-Notion test configuration from `process.env` (or an injected env map) and normalize it into `LiveNotionEnv`. */
export const liveNotionEnvFromProcessEnv = (
  env: NodeJS.ProcessEnv = process.env,
): LiveNotionEnv => {
  const token =
    env.NOTION_API_TOKEN !== undefined && env.NOTION_API_TOKEN.length > 0
      ? env.NOTION_API_TOKEN
      : env.NOTION_TOKEN

  return {
    enabled: env.NOTION_DATASOURCE_SYNC_LIVE === '1',
    token,
    tokenSource:
      env.NOTION_API_TOKEN !== undefined && env.NOTION_API_TOKEN.length > 0
        ? 'NOTION_API_TOKEN'
        : env.NOTION_TOKEN === undefined
          ? undefined
          : 'NOTION_TOKEN',
    parentPageId: env.NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID,
    dataSourceId: env.NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID,
    e2eLedgerPageId: env.NOTION_DATASOURCE_SYNC_E2E_LEDGER_PAGE_ID,
    demoPageId: env.NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID,
    requiredCapabilities: env.NOTION_DATASOURCE_SYNC_REQUIRED_CAPABILITIES,
    ledgerPath: env.NOTION_DATASOURCE_SYNC_LEDGER_PATH,
  }
}

const looksLikeDummySecret = (value: string): boolean => {
  const normalized = value.trim().toLowerCase()
  return (
    normalized.length === 0 ||
    normalized === 'dummy' ||
    normalized === 'fake' ||
    normalized === 'placeholder' ||
    normalized.includes('dummy') ||
    normalized.includes('fake') ||
    normalized.includes('placeholder') ||
    normalized.includes('test-token')
  )
}

const looksLikeNotionPageId = (value: string): boolean =>
  /^[0-9a-f]{32}$/i.test(value.replaceAll('-', ''))

const parseRequiredCapabilities = (
  value: string | undefined,
): {
  readonly capabilities: ReadonlyArray<CapabilityName>
  readonly invalid: ReadonlyArray<string>
} => {
  if (value === undefined || value.trim().length === 0) {
    return { capabilities: defaultLivePreflightCapabilities, invalid: [] }
  }

  const parsed = value
    .split(',')
    .map((capability) => capability.trim())
    .filter((capability) => capability.length > 0)

  const invalid = parsed.filter(
    (capability): capability is string =>
      capabilityNames.has(capability as CapabilityName) === false,
  )

  return {
    capabilities: parsed.filter((capability): capability is CapabilityName =>
      capabilityNames.has(capability as CapabilityName),
    ),
    invalid,
  }
}

/** Validate a `LiveNotionEnv` and produce a typed `LiveNotionConfig` — returns `not-configured` when the opt-in flag is absent, `invalid-config` when tokens or IDs are missing/malformed. */
export const liveNotionConfigFromEnv = (env: LiveNotionEnv): LiveNotionConfig => {
  const parentPageId = env.parentPageId
  const dataSourceId = env.dataSourceId
  const token = env.token
  const parsedCapabilities = parseRequiredCapabilities(env.requiredCapabilities)

  if (env.enabled === false) {
    return {
      _tag: 'not-configured',
      skipReason: 'live Notion E2E disabled; set NOTION_DATASOURCE_SYNC_LIVE=1 to opt in',
      missing: ['NOTION_DATASOURCE_SYNC_LIVE=1'],
    }
  }

  const missing = [
    ...(token === undefined ? ['NOTION_API_TOKEN or NOTION_TOKEN'] : []),
    ...(parentPageId === undefined ? ['NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID'] : []),
  ]
  const invalid = [
    ...(token !== undefined && looksLikeDummySecret(token) === true
      ? [env.tokenSource ?? 'NOTION_API_TOKEN or NOTION_TOKEN']
      : []),
    ...(parentPageId !== undefined && looksLikeNotionPageId(parentPageId) === false
      ? ['NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID']
      : []),
    ...(dataSourceId !== undefined && looksLikeNotionPageId(dataSourceId) === false
      ? ['NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID']
      : []),
    ...(env.e2eLedgerPageId !== undefined && looksLikeNotionPageId(env.e2eLedgerPageId) === false
      ? ['NOTION_DATASOURCE_SYNC_E2E_LEDGER_PAGE_ID']
      : []),
    ...(env.demoPageId !== undefined && looksLikeNotionPageId(env.demoPageId) === false
      ? ['NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID']
      : []),
    ...parsedCapabilities.invalid.map(
      (capability) => `NOTION_DATASOURCE_SYNC_REQUIRED_CAPABILITIES:${capability}`,
    ),
  ]

  if (
    missing.length > 0 ||
    invalid.length > 0 ||
    token === undefined ||
    parentPageId === undefined
  ) {
    return {
      _tag: 'invalid-config',
      message: `live Notion E2E opted in with invalid configuration; missing ${missing.join(
        ', ',
      )}; invalid ${invalid.join(', ')}`,
      missing,
      invalid,
    }
  }

  return {
    _tag: 'configured',
    runId: `notion-ds-sync-${randomUUID()}`,
    parentPageId,
    dataSourceId,
    notionVersion: NOTION_API_VERSION,
    requiredCapabilities: parsedCapabilities.capabilities,
    ledgerPath: env.ledgerPath ?? `tmp/notion-datasource-sync-live/${randomUUID()}.json`,
    e2eLedgerPageId: env.e2eLedgerPageId,
    demoPageId: env.demoPageId,
  }
}

/** Construct a fresh empty ledger for a run, seeded with the run ID and Notion API version from the config. */
export const emptyLiveFixtureLedger = (config: ConfiguredLiveNotionConfig): LiveFixtureLedger =>
  ({
    runId: config.runId,
    notionVersion: config.notionVersion,
    entries: [],
  }) satisfies LiveFixtureLedger

/** Build a `LiveFixtureLedgerEntry` with `cleanupState` defaulting to `'created'` when not supplied. */
export const ledgerEntry = (
  input: Omit<LiveFixtureLedgerEntry, 'cleanupState'> & {
    readonly cleanupState?: LiveFixtureLedgerEntry['cleanupState']
  },
): LiveFixtureLedgerEntry => ({
  cleanupState: 'created',
  ...input,
})

const appendLedgerEntry = ({
  ledger,
  entry,
}: {
  readonly ledger: LiveFixtureLedger
  readonly entry: LiveFixtureLedgerEntry
}): LiveFixtureLedger => ({
  ...ledger,
  entries: [...ledger.entries, entry],
})

/** Replay the append-only cleanup ledger and return objects whose latest state still needs cleanup. */
export const liveFixtureCleanupResumeTargets = (
  ledger: LiveFixtureLedger,
): ReadonlyArray<LiveFixtureCleanupResumeTarget> => {
  const latestByObject = new Map<string, LiveFixtureLedgerEntry>()

  for (const entry of ledger.entries) {
    latestByObject.set(`${entry.objectType}:${entry.objectId}`, entry)
  }

  return [...latestByObject.values()]
    .filter(
      (entry): entry is LiveFixtureLedgerEntry & LiveFixtureCleanupResumeTarget =>
        entry.cleanupState !== 'verified-cleaned',
    )
    .map((entry) => ({
      objectId: entry.objectId,
      objectType: entry.objectType,
      purpose: entry.purpose,
      cleanupState: entry.cleanupState,
    }))
}

/** Resume cleanup from a prior ledger snapshot and persist a verified-cleaned or cleanup-failed entry for each target. */
export const resumeLiveFixtureCleanupFromLedger = async ({
  config,
  ledger,
  trash,
  writeLedger = writeLiveFixtureLedger,
}: {
  readonly config: ConfiguredLiveNotionConfig
  readonly ledger: LiveFixtureLedger
  readonly trash: (target: LiveFixtureCleanupResumeTarget) => Promise<void>
  readonly writeLedger?: WriteLiveFixtureLedger
}): Promise<LiveFixtureLedger> => {
  let resumedLedger = ledger
  const persist = async () => {
    await writeLedger({ path: config.ledgerPath, ledger: resumedLedger })
  }
  const record = async (entry: LiveFixtureLedgerEntry) => {
    resumedLedger = appendLedgerEntry({ ledger: resumedLedger, entry })
    await persist()
  }

  for (const target of liveFixtureCleanupResumeTargets(ledger)) {
    try {
      // oxlint-disable-next-line no-await-in-loop
      await trash(target)
      // oxlint-disable-next-line no-await-in-loop
      await record(
        ledgerEntry({
          phase: 'trash',
          objectId: target.objectId,
          objectType: target.objectType,
          purpose: target.purpose,
          cleanupState: 'verified-cleaned',
        }),
      )
    } catch (cause) {
      // oxlint-disable-next-line no-await-in-loop
      await record(
        ledgerEntry({
          phase: 'trash',
          objectId: target.objectId,
          objectType: target.objectType,
          purpose: target.purpose,
          cleanupState: 'cleanup-failed',
        }),
      )
      throw new LiveFixtureCleanupError({ phase: 'trash', cause, ledger: resumedLedger })
    }
  }

  return resumedLedger
}

/** Callback signature for persisting a `LiveFixtureLedger` to a path — the default impl writes JSON; tests may inject an in-memory variant. */
export type WriteLiveFixtureLedger = (input: {
  readonly path: string
  readonly ledger: LiveFixtureLedger
}) => Promise<void>

/** Callback signature for pushing a rendered ledger as Markdown to a Notion page — used to publish live run status when `e2eLedgerPageId` is configured. */
export type PublishLiveFixtureLedger = (input: {
  readonly pageId: string
  readonly markdown: string
}) => Promise<void>

/** Default `WriteLiveFixtureLedger` impl — serializes the ledger to formatted JSON and writes it to `input.path`, creating parent directories as needed. */
export const writeLiveFixtureLedger: WriteLiveFixtureLedger = async (input) => {
  await mkdir(dirname(input.path), { recursive: true })
  await writeFile(input.path, `${JSON.stringify(input.ledger, null, 2)}\n`, 'utf8')
}

const ledgerMarkerStart = '<!-- notion-datasource-sync:e2e-ledger:start -->'
const ledgerMarkerEnd = '<!-- notion-datasource-sync:e2e-ledger:end -->'

const shortHash = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 12)

const replaceMarkedLedgerSection = ({
  currentMarkdown,
  nextMarkdown,
}: {
  readonly currentMarkdown: string
  readonly nextMarkdown: string
}): string => {
  const startIndex = currentMarkdown.indexOf(ledgerMarkerStart)
  const endIndex = currentMarkdown.indexOf(ledgerMarkerEnd)
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(
      'live Notion ledger page is missing the notion-datasource-sync e2e ledger marker',
    )
  }

  const replaceEnd = endIndex + ledgerMarkerEnd.length
  return `${currentMarkdown.slice(0, startIndex)}${nextMarkdown}${currentMarkdown.slice(replaceEnd)}`
}

/** Render a `LiveFixtureLedger` as a Markdown string suitable for publishing to a Notion ledger page — includes run metadata, entry list, and a derived status badge. */
export const formatLiveFixtureLedgerMarkdown = (input: {
  readonly ledger: LiveFixtureLedger
  readonly ledgerPath: string
  readonly demoPageId: string | undefined
}): string => {
  const cleanupFailures = input.ledger.entries.filter(
    (entry) => entry.cleanupState === 'cleanup-failed',
  )
  const latestEntry = input.ledger.entries.at(-1)
  const status =
    cleanupFailures.length > 0
      ? 'failed'
      : latestEntry?.cleanupState === 'verified-cleaned'
        ? 'passed'
        : 'running'
  const aliasByObjectId = new Map<string, string>()
  const objectAlias = (entry: LiveFixtureLedgerEntry) => {
    const existing = aliasByObjectId.get(entry.objectId)
    if (existing !== undefined) return existing
    const alias = `${entry.objectType}-${(aliasByObjectId.size + 1).toString()}`
    aliasByObjectId.set(entry.objectId, alias)
    return alias
  }
  const entries =
    input.ledger.entries.length === 0
      ? ['No ledger entries recorded yet.']
      : input.ledger.entries.map(
          (entry) =>
            `- ${entry.phase}: ${objectAlias(entry)} - ${entry.purpose} - ${entry.cleanupState}`,
        )

  return [
    ledgerMarkerStart,
    '# notion datasource sync e2e run ledger',
    '',
    `Latest status: **${status}**`,
    '',
    `- Run alias: run-${shortHash(input.ledger.runId)}`,
    `- Notion API version: ${input.ledger.notionVersion}`,
    `- Git SHA: ${process.env.GITHUB_SHA ?? process.env.GIT_COMMIT ?? 'local'}`,
    `- GitHub run: ${process.env.GITHUB_RUN_ID ?? 'local'}`,
    ...(input.demoPageId === undefined
      ? []
      : [`- Demo page alias: page-${shortHash(input.demoPageId)}`]),
    ...(latestEntry === undefined
      ? []
      : [`- Latest entry: ${latestEntry.phase} ${latestEntry.cleanupState}`]),
    ...(cleanupFailures.length === 0
      ? []
      : [`- Cleanup failures: ${cleanupFailures.length.toString()}`]),
    '',
    '## Ledger entries',
    '',
    ...entries,
    ledgerMarkerEnd,
  ].join('\n')
}

/** Build a `WriteLiveFixtureLedger` that writes locally and, when `e2eLedgerPageId` is set, also publishes the rendered Markdown to the configured Notion ledger page. */
export const makeLiveFixtureLedgerWriter = (input: {
  readonly env: LiveNotionEnv
  readonly config: ConfiguredLiveNotionConfig
  readonly writeLocalLedger?: WriteLiveFixtureLedger
  readonly publishLedger?: PublishLiveFixtureLedger
}): WriteLiveFixtureLedger => {
  const writeLocalLedger = input.writeLocalLedger ?? writeLiveFixtureLedger

  return async (entry) => {
    await writeLocalLedger(entry)

    if (input.config.e2eLedgerPageId === undefined) {
      return
    }
    const ledgerPageId = input.config.e2eLedgerPageId

    const markdown = formatLiveFixtureLedgerMarkdown({
      ledger: entry.ledger,
      ledgerPath: entry.path,
      demoPageId: input.config.demoPageId,
    })

    if (input.publishLedger !== undefined) {
      await input.publishLedger({ pageId: input.config.e2eLedgerPageId, markdown })
      return
    }

    if (input.env.token === undefined) {
      throw new Error(
        'live Notion ledger page publishing requires a token after configuration validation',
      )
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const current = yield* NotionPages.getMarkdown({ pageId: ledgerPageId })
        const nextMarkdown = replaceMarkedLedgerSection({
          currentMarkdown: current.markdown,
          nextMarkdown: markdown,
        })
        yield* NotionPages.updateMarkdown({
          pageId: ledgerPageId,
          type: 'update_content',
          content_updates: [
            {
              old_str: current.markdown,
              new_str: nextMarkdown,
            },
          ],
          allow_deleting_content: false,
        })
      }).pipe(Effect.provide(makeNotionLiveLayer({ token: input.env.token }))),
    )
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const text = (content: string) => ({ type: 'text', text: { content } })

const title = (content: string) => ({ title: [text(content)] })

const richText = (content: string) => ({ rich_text: [text(content)] })

const paragraphBlock = (content: string) => ({
  object: 'block',
  type: 'paragraph',
  paragraph: richText(content),
})

const heading2Block = (content: string) => ({
  object: 'block',
  type: 'heading_2',
  heading_2: richText(content),
})

const bulletedBlock = (content: string) => ({
  object: 'block',
  type: 'bulleted_list_item',
  bulleted_list_item: richText(content),
})

const codeBlock = (content: string) => ({
  object: 'block',
  type: 'code',
  code: {
    rich_text: [text(content)],
    language: 'plain text',
  },
})

const select = (name: string) => ({ select: { name } })

const multiSelect = (names: ReadonlyArray<string>) => ({
  multi_select: names.map((name) => ({ name })),
})

const date = (start: string) => ({ date: { start } })

const checkbox = (checked: boolean) => ({ checkbox: checked })

const mutatedTitle = (fixture: LiveFixtureObject) =>
  `notion datasource sync live fixture mutated ${fixture.objectId}`

const propertyPlainText = (property: unknown): string => {
  if (isRecord(property) === false) return ''
  const titleValue = property.title
  if (Array.isArray(titleValue) === false) return ''

  return titleValue
    .map((item) =>
      isRecord(item) === true && typeof item.plain_text === 'string' ? item.plain_text : '',
    )
    .join('')
}

const resolveTitlePropertyName = (properties: Record<string, unknown>): string => {
  const titleEntry = Object.entries(properties).find(([, property]) => {
    if (isRecord(property) === false) return false
    return property.type === 'title' || 'title' in property
  })

  if (titleEntry === undefined) {
    throw new Error('live Notion fixture data source does not expose a title property')
  }

  const [fallbackName, property] = titleEntry
  return isRecord(property) === true && typeof property.name === 'string'
    ? property.name
    : fallbackName
}

const isAlreadyArchivedNotionError = (cause: unknown): boolean => {
  const seen = new Set<unknown>()
  const visit = (value: unknown): boolean => {
    if (value === undefined || value === null || seen.has(value) === true) return false
    seen.add(value)
    if (String(value).toLowerCase().includes('archived') === true) return true
    if (typeof value !== 'object') return false
    if ('message' in value && String(value.message).toLowerCase().includes('archived') === true) {
      return true
    }
    if ('cause' in value && visit(value.cause) === true) return true
    if ('error' in value && visit(value.error) === true) return true
    if ('fiberFailure' in value && visit(value.fiberFailure) === true) return true
    return false
  }

  return visit(cause)
}

/** Result returned for one data source created by `runLiveNotionDemoShowcase`. */
export type LiveNotionDemoDataSourceResult = {
  readonly key: string
  readonly title: string
  readonly description: string
  readonly domain: string
  readonly databaseId: string
  readonly dataSourceId: string
  readonly rowIds: ReadonlyArray<string>
  readonly schemaPropertyNames: ReadonlyArray<string>
  readonly propertyFamilies: ReadonlyArray<string>
  readonly bodyRows: number
  readonly observation: {
    readonly pages: number
    readonly rows: number
    readonly materializedBodies: number
    readonly observedProperties: number
    readonly incompleteProperties: number
    readonly events: number
  }
}

/** Result returned by `runLiveNotionDemoShowcase` — includes all created database/data-source identifiers, row IDs, and observation metrics. */
export type LiveNotionDemoShowcaseResult = {
  readonly runId: string
  readonly demoPageId: string
  readonly dataSources: ReadonlyArray<LiveNotionDemoDataSourceResult>
  readonly observation: {
    readonly pages: number
    readonly rows: number
    readonly materializedBodies: number
    readonly observedProperties: number
    readonly incompleteProperties: number
    readonly events: number
  }
  readonly workspaceRoot: string
}

type DemoDataSourceSpec = {
  readonly key: string
  readonly title: string
  readonly description: string
  readonly domain: string
  readonly rowCount: number
  readonly bodyRows: number
  readonly pageSize: number
  readonly icon: string
  readonly sortPropertyName: string
  readonly schemaPropertyNames: ReadonlyArray<string>
  readonly properties: Record<string, unknown>
  readonly rowProperties: (input: {
    readonly runId: string
    readonly index: number
  }) => Record<string, unknown>
  readonly rowMarkdown: (input: { readonly runId: string; readonly index: number }) => string
}

const demoDatabaseTitlePrefix = 'notion datasource sync demo'
const staleDemoDatabaseTitlePrefixes = [
  demoDatabaseTitlePrefix,
  'notion datasource sync automated demo data',
  'notion datasource sync live data source',
  'notion ds sync relation',
] as const

const formatDemoIntroBlocks = (input: { readonly runId: string }) => [
  {
    object: 'block',
    type: 'heading_1',
    heading_1: richText('notion datasource sync automated demo'),
  },
  paragraphBlock(`Current run: ${input.runId}`),
  paragraphBlock(
    'This page is refreshed by the live demo. The inline data sources below are reused when present, topped up to the requested cardinalities, then observed through datasource-sync with the real Notion gateway and NotionMD body adapter.',
  ),
  heading2Block('What this run demonstrates'),
  bulletedBlock('Multiple Notion data sources under the configured demo page.'),
  bulletedBlock(
    'Different realistic domains: projects, incidents, customers, and high-volume activity events.',
  ),
  bulletedBlock(
    'Mixed schemas across title, rich text, number, checkbox, date, select, multi-select, URL, email, and phone properties.',
  ),
  bulletedBlock(
    'Bounded high-cardinality proof with a 500-row data source observed through paginated datasource queries.',
  ),
  bulletedBlock(
    'Data-source description metadata patched through the datasource-sync metadata surface.',
  ),
  bulletedBlock(
    'NotionMD body observation and workspace materialization for representative row pages.',
  ),
  bulletedBlock('Filtered high-watermark query contracts on each live data source.'),
]

const demoRowMarkdown = (input: {
  readonly runId: string
  readonly title: string
  readonly domain: string
  readonly index: number
}): string =>
  [
    `# ${input.title} ${input.index.toString()}`,
    '',
    `Generated by notion-datasource-sync demo run ${input.runId} for the ${input.domain} domain.`,
    '',
    '## Body content',
    '',
    '- This body was written through the Notion markdown endpoint.',
    '- datasource-sync observes it through the NotionMD body adapter.',
    '- The filesystem workspace receives a real NotionMD .nmd body with sidecar identity.',
  ].join('\n')

const demoProjectProperties = (input: { readonly runId: string; readonly index: number }) => {
  const state = input.index % 4 === 0 ? 'at-risk' : input.index % 3 === 0 ? 'review' : 'active'
  return {
    Name: title(`Project ${String(input.index).padStart(2, '0')} ${input.runId}`),
    State: select(state),
    Budget: { number: 25_000 + input.index * 3_750 },
    Strategic: checkbox(input.index % 2 === 0),
    Kickoff: date(`2026-06-${String((input.index % 24) + 1).padStart(2, '0')}`),
    Teams: multiSelect(input.index % 2 === 0 ? ['platform', 'growth'] : ['ops', 'research']),
    Summary: richText(`Milestone summary for project ${input.index.toString()}.`),
    Brief: { url: `https://example.com/notion-ds-sync/projects/${input.index.toString()}` },
  }
}

const demoIncidentProperties = (input: { readonly runId: string; readonly index: number }) => {
  const severity = input.index % 10 === 0 ? 'sev1' : input.index % 4 === 0 ? 'sev2' : 'sev3'
  return {
    Name: title(`Incident ${String(input.index).padStart(3, '0')} ${input.runId}`),
    Severity: select(severity),
    Open: checkbox(input.index % 5 !== 0),
    Started: date(`2026-07-${String((input.index % 28) + 1).padStart(2, '0')}`),
    Impact: { number: input.index % 10 },
    Systems: multiSelect(input.index % 3 === 0 ? ['api', 'sync'] : ['notion', 'worker']),
    Notes: richText(`Incident observation note ${input.index.toString()}.`),
  }
}

const demoCustomerProperties = (input: { readonly runId: string; readonly index: number }) => {
  const plan = input.index % 5 === 0 ? 'enterprise' : input.index % 2 === 0 ? 'team' : 'starter'
  return {
    Name: title(`Customer ${String(input.index).padStart(3, '0')} ${input.runId}`),
    Plan: select(plan),
    ARR: { number: 1_200 + input.index * 410 },
    Renewal: date(`2026-${String((input.index % 12) + 1).padStart(2, '0')}-15`),
    Contacted: checkbox(input.index % 3 === 0),
    Regions: multiSelect(input.index % 2 === 0 ? ['eu', 'us'] : ['apac']),
    Health: richText(input.index % 4 === 0 ? 'Needs attention' : 'Healthy'),
    Email: { email: `demo-customer-${input.index.toString()}@example.com` },
    Phone: { phone_number: `+1 555 ${String(1000 + input.index).padStart(4, '0')}` },
  }
}

const demoActivityProperties = (input: { readonly runId: string; readonly index: number }) => {
  const segment = input.index % 6 === 0 ? 'backfill' : input.index % 2 === 0 ? 'ingest' : 'verify'
  return {
    Name: title(`Activity event ${String(input.index).padStart(4, '0')} ${input.runId}`),
    Segment: select(segment),
    Sequence: { number: input.index },
    Automated: checkbox(true),
    EventDate: date(`2026-08-${String((input.index % 28) + 1).padStart(2, '0')}`),
    Labels: multiSelect(
      input.index % 10 === 0 ? ['high-cardinality', 'checkpoint'] : ['high-cardinality'],
    ),
    Payload: richText(`Synthetic activity payload ${input.index.toString()}.`),
  }
}

const demoDataSourceSpecs = [
  {
    key: 'projects',
    title: 'notion datasource sync demo projects',
    description:
      'Portfolio project planning data source: budgets, kickoff dates, strategic flags, team tags, summaries, and row bodies.',
    domain: 'portfolio projects',
    rowCount: 12,
    bodyRows: 12,
    pageSize: 5,
    icon: '📁',
    sortPropertyName: 'State',
    schemaPropertyNames: ['Summary'],
    properties: {
      Name: { title: {} },
      State: {
        select: {
          options: [
            { name: 'active', color: 'green' },
            { name: 'review', color: 'yellow' },
            { name: 'at-risk', color: 'red' },
          ],
        },
      },
      Budget: { number: { format: 'dollar' } },
      Strategic: { checkbox: {} },
      Kickoff: { date: {} },
      Teams: {
        multi_select: {
          options: [
            { name: 'platform', color: 'blue' },
            { name: 'growth', color: 'green' },
            { name: 'ops', color: 'orange' },
            { name: 'research', color: 'purple' },
          ],
        },
      },
      Summary: { rich_text: {} },
      Brief: { url: {} },
    },
    rowProperties: demoProjectProperties,
    rowMarkdown: (input) =>
      demoRowMarkdown({ ...input, title: 'Project brief', domain: 'portfolio projects' }),
  },
  {
    key: 'incidents',
    title: 'notion datasource sync demo incidents',
    description:
      'Incident operations data source: severity, open state, impact score, system tags, start dates, and notes.',
    domain: 'incident operations',
    rowCount: 30,
    bodyRows: 0,
    pageSize: 10,
    icon: '🚨',
    sortPropertyName: 'Severity',
    schemaPropertyNames: ['Notes'],
    properties: {
      Name: { title: {} },
      Severity: {
        select: {
          options: [
            { name: 'sev1', color: 'red' },
            { name: 'sev2', color: 'orange' },
            { name: 'sev3', color: 'yellow' },
          ],
        },
      },
      Open: { checkbox: {} },
      Started: { date: {} },
      Impact: { number: { format: 'number' } },
      Systems: {
        multi_select: {
          options: [
            { name: 'api', color: 'blue' },
            { name: 'sync', color: 'purple' },
            { name: 'notion', color: 'gray' },
            { name: 'worker', color: 'brown' },
          ],
        },
      },
      Notes: { rich_text: {} },
    },
    rowProperties: demoIncidentProperties,
    rowMarkdown: (input) =>
      demoRowMarkdown({ ...input, title: 'Incident report', domain: 'incident operations' }),
  },
  {
    key: 'customers',
    title: 'notion datasource sync demo customers',
    description:
      'Customer-success data source: plan, ARR, renewal date, regions, health, and contact fields.',
    domain: 'customer success',
    rowCount: 48,
    bodyRows: 0,
    pageSize: 24,
    icon: '🤝',
    sortPropertyName: 'Plan',
    schemaPropertyNames: ['Health'],
    properties: {
      Name: { title: {} },
      Plan: {
        select: {
          options: [
            { name: 'starter', color: 'gray' },
            { name: 'team', color: 'blue' },
            { name: 'enterprise', color: 'purple' },
          ],
        },
      },
      ARR: { number: { format: 'dollar' } },
      Renewal: { date: {} },
      Contacted: { checkbox: {} },
      Regions: {
        multi_select: {
          options: [
            { name: 'eu', color: 'green' },
            { name: 'us', color: 'blue' },
            { name: 'apac', color: 'orange' },
          ],
        },
      },
      Health: { rich_text: {} },
      Email: { email: {} },
      Phone: { phone_number: {} },
    },
    rowProperties: demoCustomerProperties,
    rowMarkdown: (input) =>
      demoRowMarkdown({ ...input, title: 'Customer note', domain: 'customer success' }),
  },
  {
    key: 'activity',
    title: 'notion datasource sync demo activity events',
    description:
      'High-cardinality activity data source: 500 generated events used to prove paginated observation and metadata sync.',
    domain: 'high-volume activity events',
    rowCount: 500,
    bodyRows: 0,
    pageSize: 50,
    icon: '📈',
    sortPropertyName: 'Segment',
    schemaPropertyNames: [],
    properties: {
      Name: { title: {} },
      Segment: {
        select: {
          options: [
            { name: 'ingest', color: 'blue' },
            { name: 'verify', color: 'green' },
            { name: 'backfill', color: 'orange' },
          ],
        },
      },
      Sequence: { number: { format: 'number' } },
      Automated: { checkbox: {} },
      EventDate: { date: {} },
      Labels: {
        multi_select: {
          options: [
            { name: 'high-cardinality', color: 'blue' },
            { name: 'checkpoint', color: 'green' },
          ],
        },
      },
      Payload: { rich_text: {} },
    },
    rowProperties: demoActivityProperties,
    rowMarkdown: (input) =>
      demoRowMarkdown({ ...input, title: 'Activity event', domain: 'high-volume activity events' }),
  },
] as const satisfies ReadonlyArray<DemoDataSourceSpec>

const formatDemoVerificationBlocks = (result: LiveNotionDemoShowcaseResult) => [
  {
    object: 'block',
    type: 'heading_2',
    heading_2: richText('Verification summary'),
  },
  paragraphBlock(
    'The latest automated demo run completed against live Notion with multiple data sources and a high-cardinality proof.',
  ),
  bulletedBlock(`Run ID: ${result.runId}`),
  bulletedBlock(`Data sources: ${result.dataSources.length.toString()}`),
  bulletedBlock(
    `Rows created: ${result.dataSources
      .reduce((sum, dataSource) => sum + dataSource.rowIds.length, 0)
      .toString()}`,
  ),
  bulletedBlock(
    `High-cardinality proof: ${
      result.dataSources.find((dataSource) => dataSource.rowIds.length >= 500)?.title ?? 'missing'
    } has ${
      result.dataSources
        .find((dataSource) => dataSource.rowIds.length >= 500)
        ?.rowIds.length.toString() ?? '0'
    } rows`,
  ),
  bulletedBlock(
    `Observation: ${result.observation.pages.toString()} query pages, ${result.observation.rows.toString()} rows, ${result.observation.events.toString()} sync events`,
  ),
  bulletedBlock(
    `Bodies materialized: ${result.observation.materializedBodies.toString()}; properties observed: ${result.observation.observedProperties.toString()}; incomplete properties: ${result.observation.incompleteProperties.toString()}`,
  ),
  bulletedBlock('Metadata proof: every demo data source has a synced description.'),
  codeBlock(
    `NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID=${result.demoPageId}\nNOTION_DATASOURCE_SYNC_LIVE=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run src/e2e/live-notion.e2e.test.ts --config vitest.config.ts`,
  ),
  {
    object: 'block',
    type: 'heading_3',
    heading_3: richText('Data source matrix'),
  },
  ...result.dataSources.flatMap((dataSource) => [
    bulletedBlock(
      `${dataSource.title}: ${dataSource.domain}; ${dataSource.rowIds.length.toString()} rows; schema ${dataSource.schemaPropertyNames.join(', ')}; property families ${dataSource.propertyFamilies.join(', ')}; bodies ${dataSource.bodyRows.toString()}; query pages ${dataSource.observation.pages.toString()}`,
    ),
    bulletedBlock(`Description: ${dataSource.description}`),
    bulletedBlock(`Data source ID: ${dataSource.dataSourceId}`),
  ]),
]

const collectBlocks = (pageId: string) =>
  NotionBlocks.retrieveChildrenStream({ blockId: pageId, pageSize: 100 }).pipe(Stream.runCollect)

const archiveDemoDatabase = (databaseId: string) =>
  NotionDatabases.archive({ databaseId }).pipe(
    Effect.catch(() =>
      NotionDatabases.update({ databaseId, in_trash: false }).pipe(
        Effect.andThen(NotionDatabases.archive({ databaseId })),
        Effect.ignore,
      ),
    ),
    Effect.andThen(NotionBlocks.delete({ blockId: databaseId }).pipe(Effect.ignore)),
    Effect.asVoid,
  )

type DemoDatabaseBlock = {
  readonly databaseId: string
  readonly title: string
}

const childDatabaseBlock = (block: unknown): DemoDatabaseBlock | undefined => {
  if (
    isRecord(block) === false ||
    block.type !== 'child_database' ||
    typeof block.id !== 'string'
  ) {
    return undefined
  }
  const childDatabase = block.child_database
  if (
    isRecord(childDatabase) === false ||
    !('title' in childDatabase) ||
    typeof childDatabase.title !== 'string'
  ) {
    return undefined
  }
  return { databaseId: block.id, title: childDatabase.title }
}

const currentDemoTitles: ReadonlySet<string> = new Set(
  demoDataSourceSpecs.map((spec) => spec.title),
)

const cleanupDemoPageForRerun = ({ pageId }: { readonly pageId: string }) =>
  Effect.gen(function* () {
    const children = yield* collectBlocks(pageId)
    const keptByTitle = new Set<string>()
    const keptDatabases: DemoDatabaseBlock[] = []

    yield* Effect.forEach(
      children,
      (block) => {
        const database = childDatabaseBlock(block)
        if (database === undefined) {
          if (isRecord(block) === true && typeof block.id === 'string') {
            return NotionBlocks.delete({ blockId: block.id }).pipe(Effect.ignore)
          }
          return Effect.void
        }

        if (
          currentDemoTitles.has(database.title) === true &&
          keptByTitle.has(database.title) === false
        ) {
          keptByTitle.add(database.title)
          keptDatabases.push(database)
          return Effect.void
        }

        if (
          staleDemoDatabaseTitlePrefixes.some((prefix) => database.title.startsWith(prefix)) ===
          true
        ) {
          return archiveDemoDatabase(database.databaseId)
        }
        return Effect.void
      },
      { concurrency: 2 },
    )

    return keptDatabases
  })

const existingDemoDatabaseForSpec = ({
  existing,
  spec,
}: {
  readonly existing: ReadonlyArray<DemoDatabaseBlock>
  readonly spec: DemoDataSourceSpec
}): DemoDatabaseBlock | undefined =>
  existing.find(
    (database) => database.title === spec.title || database.title.startsWith(spec.title),
  )

const resolvePropertyId = ({
  properties,
  name,
}: {
  readonly properties: Record<string, unknown>
  readonly name: string
}): string => {
  const property = properties[name]
  if (isRecord(property) === false || typeof property.id !== 'string') {
    throw new Error(`demo data source does not expose expected property ${name}`)
  }
  return property.id
}

const propertyFamilies = (properties: Record<string, unknown>): ReadonlyArray<string> =>
  Object.values(properties)
    .flatMap((property) =>
      isRecord(property) === true && typeof property.type === 'string'
        ? [property.type]
        : Object.keys(property as Record<string, unknown>),
    )
    .filter((family, index, families) => families.indexOf(family) === index)
    .toSorted()

const titlePropertyNameForSpec = (spec: DemoDataSourceSpec): string => {
  const titleEntry = Object.entries(spec.properties).find(
    ([, definition]) => isRecord(definition) === true && 'title' in definition,
  )
  if (titleEntry === undefined) {
    throw new Error(`demo data source spec ${spec.key} does not define a title property`)
  }
  return titleEntry[0]
}

const nonTitlePropertiesForSpec = (spec: DemoDataSourceSpec): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(spec.properties).filter(
      ([, definition]) => isRecord(definition) === false || !('title' in definition),
    ),
  )

const patchDemoDataSourceMetadata = ({
  dataSourceId,
  runId,
  spec,
}: {
  readonly dataSourceId: string
  readonly runId: string
  readonly spec: DemoDataSourceSpec
}) =>
  Effect.gen(function* () {
    const notionConfig = yield* NotionConfig
    const httpClient = yield* HttpClient
    const provideClientEnv = <A, E>(effect: Effect.Effect<A, E, NotionConfig | HttpClient>) =>
      effect.pipe(
        Effect.provideService(NotionConfig, notionConfig),
        Effect.provideService(HttpClient, httpClient),
      )
    /* Explicit ~3 rps throttle so this live path mirrors production pacing. */
    const withThrottle = yield* makeThrottledProvideClientEnv()
    const gateway = makeNotionDataSourceGatewayFromClient({
      client: makeNotionEffectClientGatewayClient(withThrottle(provideClientEnv)),
    })
    const metadata = yield* gateway.retrieveDataSource(DataSourceId.make(dataSourceId))
    if (metadata.metadataHash === undefined) {
      throw new Error(`demo data source metadata hash unavailable for ${spec.key}`)
    }
    yield* gateway.patchDataSourceMetadata(
      PatchDataSourceMetadataCommand.make({
        _tag: 'PatchDataSourceMetadataCommand',
        commandId: commandIdFor(`demo-metadata:${runId}:${dataSourceId}:${spec.description}`),
        dataSourceId: DataSourceId.make(dataSourceId),
        baseMetadataHash: metadata.metadataHash,
        metadataPatch: { descriptionPlainText: spec.description },
      }),
    )
  }).pipe(Effect.scoped)

const createDemoDatabase = ({
  demoPageId,
  runId,
  spec,
  existing,
}: {
  readonly demoPageId: string
  readonly runId: string
  readonly spec: DemoDataSourceSpec
  readonly existing?: DemoDatabaseBlock | undefined
}) =>
  Effect.gen(function* () {
    const createFresh = Effect.gen(function* () {
      if (existing !== undefined) {
        yield* archiveDemoDatabase(existing.databaseId).pipe(Effect.ignore)
      }
      const database = yield* NotionDatabases.create({
        parent: { type: 'page_id', page_id: demoPageId },
        title: [text(`${spec.title} (${runId})`)],
        is_inline: true,
        properties: { [titlePropertyNameForSpec(spec)]: { title: {} } },
      })
      const resolvedDatabase = yield* NotionDatabases.retrieve({ databaseId: database.id })
      const dataSourceId =
        resolvedDatabase.data_sources?.[0]?.id ?? database.data_sources?.[0]?.id ?? database.id

      yield* NotionDataSources.update({
        dataSourceId,
        title: [text(spec.title)],
        properties: nonTitlePropertiesForSpec(spec),
        icon: { type: 'emoji', emoji: spec.icon },
      })
      yield* patchDemoDataSourceMetadata({ dataSourceId, runId, spec })

      return { databaseId: database.id, dataSourceId }
    })

    if (existing === undefined) {
      return yield* createFresh
    }

    return yield* Effect.gen(function* () {
      const database = yield* NotionDatabases.retrieve({ databaseId: existing.databaseId })
      const dataSourceId = database.data_sources?.[0]?.id ?? database.id
      yield* NotionDataSources.update({
        dataSourceId,
        title: [text(spec.title)],
        properties: nonTitlePropertiesForSpec(spec),
        icon: { type: 'emoji', emoji: spec.icon },
      })
      yield* patchDemoDataSourceMetadata({ dataSourceId, runId, spec })
      return { databaseId: existing.databaseId, dataSourceId }
    }).pipe(Effect.catch(() => createFresh))
  })

const queryDemoRowIds = (dataSourceId: string) =>
  NotionDatabases.queryStream({
    dataSourceId,
    pageSize: 100,
    sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
  }).pipe(
    Stream.map((page) => page.id),
    Stream.runCollect,
  )

const createDemoRows = ({
  dataSourceId,
  runId,
  spec,
  startIndex,
}: {
  readonly dataSourceId: string
  readonly runId: string
  readonly spec: DemoDataSourceSpec
  readonly startIndex: number
}) =>
  Effect.forEach(
    Array.from({ length: spec.rowCount - startIndex + 1 }, (_, index) => startIndex + index),
    (index) =>
      NotionPages.create({
        parent: { type: 'data_source_id', data_source_id: dataSourceId },
        properties: spec.rowProperties({ runId, index }),
        ...(index <= spec.bodyRows ? { markdown: spec.rowMarkdown({ runId, index }) } : {}),
      }).pipe(Effect.map((page) => page.id)),
    { concurrency: 4 },
  )

const ensureDemoRows = ({
  dataSourceId,
  runId,
  spec,
}: {
  readonly dataSourceId: string
  readonly runId: string
  readonly spec: DemoDataSourceSpec
}) =>
  Effect.gen(function* () {
    const existingRowIds = yield* queryDemoRowIds(dataSourceId)
    if (existingRowIds.length >= spec.rowCount) {
      return existingRowIds.slice(0, spec.rowCount)
    }
    const createdRowIds = yield* createDemoRows({
      dataSourceId,
      runId,
      spec,
      startIndex: existingRowIds.length + 1,
    })
    return [...existingRowIds, ...createdRowIds]
  })

const observeDemoDataSource = ({
  dataSourceId,
  dataSourceProperties,
  rootId,
  workspaceRoot,
  spec,
}: {
  readonly dataSourceId: string
  readonly dataSourceProperties: Record<string, unknown>
  readonly rootId: SyncRootId
  readonly workspaceRoot: AbsolutePath
  readonly spec: DemoDataSourceSpec
}) =>
  Effect.gen(function* () {
    const notionMdGateway = yield* NotionMdGateway
    const bodyPort = makeNotionMdPageBodySyncPort({ gateway: notionMdGateway })
    const workspace = makeFilesystemLocalWorkspacePort({ root: workspaceRoot })
    const sortPropertyId = resolvePropertyId({
      properties: dataSourceProperties,
      name: spec.sortPropertyName,
    })
    const schemaProperties = schemaPropertyObservationsFromRemoteProperties(
      dataSourceProperties,
    ).filter((property) => spec.schemaPropertyNames.includes(property.name))
    const queryContract: QueryContract = {
      _tag: 'QueryContract',
      apiVersion: NOTION_API_VERSION,
      filter: null,
      sorts: [
        {
          _tag: 'CanonicalNotionSort',
          propertyId: PropertyId.make(sortPropertyId),
          direction: 'ascending',
        },
      ],
      pageSize: spec.pageSize,
      highWatermark: null,
      membershipScope: 'all-data-source-rows',
    }
    const first = yield* observeRemoteDataSource({
      rootId,
      dataSourceId: DataSourceId.make(dataSourceId),
      workspaceRoot,
      queryContract,
      schemaProperties,
      materializeBodies: spec.bodyRows > 0,
      requiredCapabilities: strictLivePreflightCapabilities,
    }).pipe(
      Effect.provideService(PageBodySyncPort, bodyPort),
      Effect.provideService(LocalWorkspacePort, workspace),
    )

    return {
      pages: first.query.pages,
      rows: first.query.rows,
      materializedBodies: first.materialized.length,
      observedProperties: first.properties.observed,
      incompleteProperties: first.properties.incomplete,
      events: first.events.length,
    }
  })

/**
 * End-to-end demo run against a real Notion workspace — creates multiple inline data sources with realistic
 * schemas and row counts, observes them through datasource-sync, and appends a verification summary.
 *
 * Cleans up the temporary workspace directory in a `finally` block but does NOT archive the current Notion databases.
 */
export const runLiveNotionDemoShowcase = async ({
  env,
  config,
}: {
  readonly env: LiveNotionEnv
  readonly config: ConfiguredLiveNotionConfig
}): Promise<LiveNotionDemoShowcaseResult> => {
  if (env.token === undefined) {
    throw new Error('live Notion demo showcase requires a token after configuration validation')
  }
  if (config.demoPageId === undefined) {
    throw new Error('live Notion demo showcase requires NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID')
  }
  const demoPageId = config.demoPageId

  const layer = makeNotionLiveLayer({ token: env.token, maxRetries: 8, retryBaseDelay: 1_000 })
  const run = <A, E>(effect: Effect.Effect<A, E, NotionConfig | HttpClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))

  const created = await run(
    Effect.gen(function* () {
      const existing = yield* cleanupDemoPageForRerun({ pageId: demoPageId })
      yield* NotionBlocks.append({
        blockId: demoPageId,
        position: { type: 'start' },
        children: formatDemoIntroBlocks({ runId: config.runId }),
      })

      return yield* Effect.forEach(
        demoDataSourceSpecs,
        (spec) =>
          createDemoDatabase({
            demoPageId,
            runId: config.runId,
            spec,
            existing: existingDemoDatabaseForSpec({ existing, spec }),
          }),
        { concurrency: 1 },
      )
    }),
  )
  if (created.length !== demoDataSourceSpecs.length) {
    throw new Error('live Notion demo showcase did not create all requested data sources')
  }

  const rowIdsByKey = await run(
    Effect.forEach(
      demoDataSourceSpecs,
      (spec, index) =>
        ensureDemoRows({
          dataSourceId: created[index]?.dataSourceId ?? '',
          runId: config.runId,
          spec,
        }).pipe(Effect.map((rowIds) => [spec.key, rowIds] as const)),
      { concurrency: 1 },
    ),
  )

  const dataSources = await run(
    Effect.forEach(
      created,
      (source) => NotionDataSources.retrieve({ dataSourceId: source.dataSourceId }),
      { concurrency: 2 },
    ),
  )
  const workspaceRoot = Schema.decodeSync(AbsolutePath)(
    await mkdtemp(join(tmpdir(), 'notion-ds-sync-demo-')),
  )
  const rootId = Schema.decodeSync(SyncRootId)(`demo:${config.runId}`)

  try {
    const observationLayer = Layer.mergeAll(
      NotionDataSourceGatewayLive.pipe(Layer.provide(layer)),
      NotionMdGatewayLive.pipe(Layer.provide(layer)),
    )
    const observations = await Effect.runPromise(
      Effect.forEach(
        demoDataSourceSpecs,
        (spec, index) =>
          observeDemoDataSource({
            dataSourceId: created[index]?.dataSourceId ?? '',
            dataSourceProperties: dataSources[index]?.properties ?? {},
            rootId,
            workspaceRoot,
            spec,
          }),
        { concurrency: 1 },
      ).pipe(Effect.provide(observationLayer)),
    )

    const sourceResults = demoDataSourceSpecs.map((spec, index) => {
      const source = created[index]
      const dataSource = dataSources[index]
      const observation = observations[index]
      if (source === undefined || dataSource === undefined || observation === undefined) {
        throw new Error(`live Notion demo showcase missing result for ${spec.key}`)
      }
      return {
        key: spec.key,
        title: spec.title,
        description: spec.description,
        domain: spec.domain,
        databaseId: source.databaseId,
        dataSourceId: source.dataSourceId,
        rowIds: rowIdsByKey.find(([key]) => key === spec.key)?.[1] ?? [],
        schemaPropertyNames: spec.schemaPropertyNames,
        propertyFamilies: propertyFamilies(dataSource.properties),
        bodyRows: spec.bodyRows,
        observation,
      } satisfies LiveNotionDemoDataSourceResult
    })
    const aggregateObservation = sourceResults.reduce(
      (sum, source) => ({
        pages: sum.pages + source.observation.pages,
        rows: sum.rows + source.observation.rows,
        materializedBodies: sum.materializedBodies + source.observation.materializedBodies,
        observedProperties: sum.observedProperties + source.observation.observedProperties,
        incompleteProperties: sum.incompleteProperties + source.observation.incompleteProperties,
        events: sum.events + source.observation.events,
      }),
      {
        pages: 0,
        rows: 0,
        materializedBodies: 0,
        observedProperties: 0,
        incompleteProperties: 0,
        events: 0,
      },
    )
    const result: LiveNotionDemoShowcaseResult = {
      runId: config.runId,
      demoPageId,
      dataSources: sourceResults,
      observation: aggregateObservation,
      workspaceRoot,
    }

    await run(
      NotionBlocks.append({
        blockId: demoPageId,
        children: formatDemoVerificationBlocks(result),
      }),
    )

    return result
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

const makeNotionLiveLayer = ({
  token,
  maxRetries,
  retryBaseDelay,
}: {
  readonly token: string
  readonly maxRetries?: number
  readonly retryBaseDelay?: number
}) =>
  Layer.mergeAll(
    NotionConfigLive({
      authToken: Redacted.make(token),
      retryEnabled: true,
      maxRetries: maxRetries ?? 2,
      retryBaseDelay: retryBaseDelay ?? 500,
    }),
    FetchHttpClient.layer,
  )

/** Create a `LiveFixtureLifecycleClient` that operates on real Notion pages in the given data source — suitable for passing to `runLiveFixtureLifecycle`. */
export const makeLiveNotionFixtureLifecycleClient = ({
  env,
  config,
}: {
  readonly env: LiveNotionEnv
  readonly config: LiveNotionConfigWithDataSource
}): LiveFixtureLifecycleClient => {
  if (env.token === undefined) {
    throw new Error('live Notion fixture lifecycle requires a token after configuration validation')
  }

  const layer = makeNotionLiveLayer({ token: env.token })
  const run = <A, E>(effect: Effect.Effect<A, E, NotionConfig | HttpClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))

  const titlePropertyName = Effect.gen(function* () {
    const dataSource = yield* NotionDataSources.retrieve({
      dataSourceId: config.dataSourceId,
    })
    return resolveTitlePropertyName(dataSource.properties)
  })

  const verifyPageState = (input: {
    readonly pageId: string
    readonly expectedTitle: string
    readonly expectedInTrash: boolean
  }) =>
    Effect.gen(function* () {
      const page = yield* NotionPages.retrieve({ pageId: input.pageId })
      const titleName = yield* titlePropertyName
      const actualTitle = propertyPlainText(page.properties[titleName])

      if (page.in_trash !== input.expectedInTrash) {
        throw new Error(
          `live Notion fixture ${input.pageId} expected in_trash=${input.expectedInTrash.toString()}`,
        )
      }

      if (actualTitle !== input.expectedTitle) {
        throw new Error(`live Notion fixture ${input.pageId} title verification failed`)
      }
    })

  return {
    create: ({ runId, dataSourceId }) =>
      run(
        Effect.gen(function* () {
          const titleName = yield* titlePropertyName
          const page = yield* NotionPages.create({
            parent: { type: 'data_source_id', data_source_id: dataSourceId },
            properties: {
              [titleName]: title(`notion datasource sync live fixture ${runId}`),
            },
          })

          return {
            objectId: page.id,
            objectType: 'page',
            purpose: 'live-notion-row-fixture',
          } satisfies LiveFixtureObject
        }),
      ),
    mutate: (fixture) =>
      run(
        Effect.gen(function* () {
          const titleName = yield* titlePropertyName
          yield* NotionPages.update({
            pageId: fixture.objectId,
            properties: {
              [titleName]: title(mutatedTitle(fixture)),
            },
          })
          return fixture
        }),
      ),
    verify: (fixture) =>
      run(
        verifyPageState({
          pageId: fixture.objectId,
          expectedTitle: mutatedTitle(fixture),
          expectedInTrash: false,
        }),
      ),
    trash: (fixture) =>
      run(
        Effect.gen(function* () {
          yield* NotionPages.update({ pageId: fixture.objectId, in_trash: true })
          const page = yield* NotionPages.retrieve({ pageId: fixture.objectId })
          if (page.in_trash !== true) {
            throw new Error(`live Notion fixture ${fixture.objectId} trash verification failed`)
          }
        }),
      ),
    restore: (fixture) =>
      run(
        Effect.gen(function* () {
          yield* NotionPages.update({ pageId: fixture.objectId, in_trash: false })
          yield* verifyPageState({
            pageId: fixture.objectId,
            expectedTitle: mutatedTitle(fixture),
            expectedInTrash: false,
          })
        }),
      ),
  }
}

/** Provisioned fixture handle returned by `provisionLiveNotionDataSourceFixture` — bundles the resolved config (with a concrete data-source ID) and a cleanup callback. */
export type LiveNotionDataSourceFixture = {
  readonly config: LiveNotionConfigWithDataSource
  readonly ledger: LiveFixtureLedger
  readonly cleanup: (ledger: LiveFixtureLedger) => Promise<LiveFixtureLedger>
}

/**
 * Provision a disposable inline Notion database for a test run and return a `LiveNotionDataSourceFixture`.
 *
 * When `config.dataSourceId` is already set, it short-circuits without creating anything. Otherwise it creates
 * a new inline database under `config.parentPageId` and registers both the database and the derived data-source
 * in the ledger. The returned `cleanup` callback archives the database and updates the ledger accordingly.
 */
export const provisionLiveNotionDataSourceFixture = async ({
  env,
  config,
  options = {},
}: {
  readonly env: LiveNotionEnv
  readonly config: ConfiguredLiveNotionConfig
  readonly options?: LiveFixtureLifecycleOptions
}): Promise<LiveNotionDataSourceFixture> => {
  if (env.token === undefined) {
    throw new Error(
      'live Notion data source fixture requires a token after configuration validation',
    )
  }

  if (config.dataSourceId !== undefined) {
    return {
      config: { ...config, dataSourceId: config.dataSourceId },
      ledger: options.initialLedger ?? emptyLiveFixtureLedger(config),
      cleanup: async (ledger) => ledger,
    }
  }

  const writeLedger = options.writeLedger ?? makeLiveFixtureLedgerWriter({ env, config })
  const layer = makeNotionLiveLayer({ token: env.token })
  let ledger = options.initialLedger ?? emptyLiveFixtureLedger(config)

  const persist = async () => {
    await writeLedger({ path: config.ledgerPath, ledger })
  }

  const record = async (entry: LiveFixtureLedgerEntry) => {
    ledger = appendLedgerEntry({ ledger, entry })
    await persist()
  }

  const database = await Effect.runPromise(
    NotionDatabases.create({
      parent: { type: 'page_id', page_id: config.parentPageId },
      title: [text(`notion datasource sync live data source ${config.runId}`)],
      is_inline: true,
      properties: {
        Name: { title: {} },
        Done: { checkbox: {} },
        Notes: { rich_text: {} },
        Count: { number: { format: 'number' } },
        Stage: {
          select: {
            options: [
              { name: 'todo', color: 'gray' },
              { name: 'doing', color: 'blue' },
              { name: 'done', color: 'green' },
            ],
          },
        },
        Due: { date: {} },
      },
    }).pipe(Effect.provide(layer)),
  )
  const dataSourceId = database.data_sources?.[0]?.id ?? database.id

  await record(
    ledgerEntry({
      phase: 'create',
      objectId: database.id,
      objectType: 'database',
      purpose: 'live-notion-disposable-database',
      cleanupState: 'created',
    }),
  )
  await record(
    ledgerEntry({
      phase: 'create',
      objectId: dataSourceId,
      objectType: 'data_source',
      purpose: 'live-notion-disposable-data-source',
      cleanupState: 'created',
    }),
  )

  const cleanup = async (inputLedger: LiveFixtureLedger): Promise<LiveFixtureLedger> => {
    ledger = inputLedger

    try {
      const archived = await Effect.runPromise(
        NotionDatabases.archive({ databaseId: database.id }).pipe(Effect.provide(layer)),
      )

      if (archived.in_trash !== true) {
        throw new Error(`live Notion fixture database ${database.id} archive verification failed`)
      }

      await record(
        ledgerEntry({
          phase: 'trash',
          objectId: dataSourceId,
          objectType: 'data_source',
          purpose: 'live-notion-disposable-data-source',
          cleanupState: 'verified-cleaned',
        }),
      )
      await record(
        ledgerEntry({
          phase: 'trash',
          objectId: database.id,
          objectType: 'database',
          purpose: 'live-notion-disposable-database',
          cleanupState: 'verified-cleaned',
        }),
      )
      return ledger
    } catch (cause) {
      if (isAlreadyArchivedNotionError(cause) === true) {
        await record(
          ledgerEntry({
            phase: 'trash',
            objectId: dataSourceId,
            objectType: 'data_source',
            purpose: 'live-notion-disposable-data-source',
            cleanupState: 'verified-cleaned',
          }),
        )
        await record(
          ledgerEntry({
            phase: 'trash',
            objectId: database.id,
            objectType: 'database',
            purpose: 'live-notion-disposable-database',
            cleanupState: 'verified-cleaned',
          }),
        )
        return ledger
      }
      await record(
        ledgerEntry({
          phase: 'trash',
          objectId: database.id,
          objectType: 'database',
          purpose: 'live-notion-disposable-database',
          cleanupState: 'cleanup-failed',
        }),
      )
      throw new LiveFixtureCleanupError({ phase: 'trash', cause, ledger })
    }
  }

  return {
    config: { ...config, dataSourceId },
    ledger,
    cleanup,
  }
}

/**
 * Drive a single create→mutate→verify→trash→restore→re-trash cycle against real Notion using the supplied client.
 *
 * Records each phase in the ledger and persists it after every step. If the operation phase throws, the fixture
 * is still trashed before the error is re-raised. Throws `LiveFixtureCleanupError` if cleanup itself fails.
 */
export const runLiveFixtureLifecycle = async ({
  config,
  client,
  options = {},
}: {
  readonly config: LiveNotionConfigWithDataSource
  readonly client: LiveFixtureLifecycleClient
  readonly options?: LiveFixtureLifecycleOptions
}): Promise<LiveFixtureLedger> => {
  const writeLedger = options.writeLedger ?? writeLiveFixtureLedger
  let ledger = options.initialLedger ?? emptyLiveFixtureLedger(config)
  let fixture: LiveFixtureObject | undefined

  const persist = async () => {
    await writeLedger({ path: config.ledgerPath, ledger })
  }

  const record = async (entry: LiveFixtureLedgerEntry) => {
    ledger = appendLedgerEntry({ ledger, entry })
    await persist()
  }

  const trashFixture = async ({
    fixtureToTrash,
    cleanupState,
  }: {
    readonly fixtureToTrash: LiveFixtureObject
    readonly cleanupState: LiveFixtureLedgerEntry['cleanupState']
  }) => {
    try {
      await client.trash(fixtureToTrash)
      await record(
        ledgerEntry({
          phase: 'trash',
          objectId: fixtureToTrash.objectId,
          objectType: fixtureToTrash.objectType,
          purpose: fixtureToTrash.purpose,
          cleanupState,
        }),
      )
    } catch (cause) {
      if (cleanupState === 'verified-cleaned' && isAlreadyArchivedNotionError(cause) === true) {
        await record(
          ledgerEntry({
            phase: 'trash',
            objectId: fixtureToTrash.objectId,
            objectType: fixtureToTrash.objectType,
            purpose: fixtureToTrash.purpose,
            cleanupState: 'verified-cleaned',
          }),
        )
        return
      }
      await record(
        ledgerEntry({
          phase: 'trash',
          objectId: fixtureToTrash.objectId,
          objectType: fixtureToTrash.objectType,
          purpose: fixtureToTrash.purpose,
          cleanupState: 'cleanup-failed',
        }),
      )
      throw new LiveFixtureCleanupError({ phase: 'trash', cause, ledger })
    }
  }

  let operationFailure: { readonly cause: unknown } | undefined

  try {
    fixture = await client.create({
      runId: config.runId,
      parentPageId: config.parentPageId,
      dataSourceId: config.dataSourceId,
    })
    await record(
      ledgerEntry({
        phase: 'create',
        objectId: fixture.objectId,
        objectType: fixture.objectType,
        purpose: fixture.purpose,
        cleanupState: 'created',
      }),
    )

    fixture = await client.mutate(fixture)
    await record(
      ledgerEntry({
        phase: 'mutate',
        objectId: fixture.objectId,
        objectType: fixture.objectType,
        purpose: fixture.purpose,
        cleanupState: 'mutated',
      }),
    )

    await client.verify(fixture)
    await record(
      ledgerEntry({
        phase: 'verify',
        objectId: fixture.objectId,
        objectType: fixture.objectType,
        purpose: fixture.purpose,
        cleanupState: 'verified',
      }),
    )
  } catch (cause) {
    operationFailure = { cause }
  }

  if (fixture !== undefined) {
    if (operationFailure !== undefined) {
      await trashFixture({ fixtureToTrash: fixture, cleanupState: 'verified-cleaned' })
    } else {
      await trashFixture({ fixtureToTrash: fixture, cleanupState: 'trashed' })

      try {
        await client.restore(fixture)
        await record(
          ledgerEntry({
            phase: 'restore',
            objectId: fixture.objectId,
            objectType: fixture.objectType,
            purpose: fixture.purpose,
            cleanupState: 'restored',
          }),
        )
      } catch (cause) {
        await record(
          ledgerEntry({
            phase: 'restore',
            objectId: fixture.objectId,
            objectType: fixture.objectType,
            purpose: fixture.purpose,
            cleanupState: 'cleanup-failed',
          }),
        )
        throw new LiveFixtureCleanupError({ phase: 'restore', cause, ledger })
      }

      await trashFixture({ fixtureToTrash: fixture, cleanupState: 'verified-cleaned' })
    }
  }

  if (operationFailure !== undefined) {
    throw operationFailure.cause
  }

  return ledger
}

/** Run `runLiveFixtureLifecycle` repeatedly for `options.cycles` iterations, accumulating the ledger across cycles — useful for stress-testing Notion API reliability. */
export const runLiveFixtureSoak = async ({
  config,
  client,
  options,
}: {
  readonly config: LiveNotionConfigWithDataSource
  readonly client: LiveFixtureLifecycleClient
  readonly options: LiveFixtureLifecycleOptions & {
    readonly scenarioName: string
    readonly cycles: number
  }
}): Promise<LiveFixtureLedger> => {
  if (options.cycles < 1 || Number.isInteger(options.cycles) === false) {
    throw new Error('live fixture soak requires a positive integer cycle count')
  }

  const writeLedger = options.writeLedger ?? writeLiveFixtureLedger
  let ledger = options.initialLedger ?? emptyLiveFixtureLedger(config)

  const persist = async () => {
    await writeLedger({ path: config.ledgerPath, ledger })
  }

  const record = async (entry: LiveFixtureLedgerEntry) => {
    ledger = appendLedgerEntry({ ledger, entry })
    await persist()
  }

  await record(
    ledgerEntry({
      phase: 'verify',
      objectId: config.dataSourceId,
      objectType: 'data_source',
      purpose: `${options.scenarioName}:start:${options.cycles.toString()}-cycles`,
      cleanupState: 'verified',
    }),
  )

  for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
    // Cycles must run serially: each cycle's verification asserts state set
    // by the previous cycle's cleanup; parallel execution would invalidate
    // the soak invariant.
    // oxlint-disable-next-line no-await-in-loop
    ledger = await runLiveFixtureLifecycle({
      config,
      client,
      options: { initialLedger: ledger, writeLedger },
    })
    // oxlint-disable-next-line no-await-in-loop
    await record(
      ledgerEntry({
        phase: 'verify',
        objectId: config.dataSourceId,
        objectType: 'data_source',
        purpose: `${options.scenarioName}:cycle:${cycle.toString()}`,
        cleanupState: 'verified',
      }),
    )
  }

  await record(
    ledgerEntry({
      phase: 'verify',
      objectId: config.dataSourceId,
      objectType: 'data_source',
      purpose: `${options.scenarioName}:complete`,
      cleanupState: 'verified-cleaned',
    }),
  )

  return ledger
}

/**
 * Verify that the configured Notion data source and parent page are accessible and that the integration token
 * carries at least the required capabilities.
 *
 * Writes an initial preflight ledger snapshot and returns a `LiveNotionPreflightResult` with capability details.
 * Throws if any required capability is missing or if either API call fails.
 */
export const runLiveNotionPreflight = async ({
  env,
  config,
  options = {},
}: {
  readonly env: LiveNotionEnv
  readonly config: LiveNotionConfigWithDataSource
  readonly options?: LiveNotionPreflightOptions
}): Promise<LiveNotionPreflightResult> => {
  if (env.token === undefined) {
    throw new Error('live Notion preflight requires a token after configuration validation')
  }

  const gatewayLayer =
    options.gatewayLayer ??
    NotionDataSourceGatewayLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          NotionConfigLive({
            authToken: Redacted.make(env.token),
            retryEnabled: true,
            maxRetries: 2,
            retryBaseDelay: 500,
          }),
          FetchHttpClient.layer,
        ),
      ),
    )

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const gateway = yield* NotionDataSourceGateway
      const preflight = yield* gateway.preflightCapabilities({
        _tag: 'CapabilityPreflightInput',
        dataSourceId: DataSourceId.make(config.dataSourceId),
        requiredCapabilities: config.requiredCapabilities,
      })
      const capabilityGuard = guardCapabilities({
        required: config.requiredCapabilities,
        supported: preflight.supportedCapabilities,
      })

      if (capabilityGuard._tag === 'blocked') {
        throw new Error(capabilityGuard.message)
      }

      yield* gateway
        .queryRows({
          _tag: 'QueryRowsInput',
          dataSourceId: DataSourceId.make(config.dataSourceId),
          queryContract: {
            _tag: 'QueryContract',
            apiVersion: NOTION_API_VERSION,
            filter: null,
            sorts: [],
            pageSize: 1,
            highWatermark: null,
            membershipScope: 'all-data-source-rows',
          },
          startCursor: null,
        })
        .pipe(Stream.runHead)

      yield* gateway.retrievePage(PageId.make(config.parentPageId))

      return {
        preflight,
        capabilityGuard,
      }
    }).pipe(Effect.provide(gatewayLayer)),
  )

  const ledger = {
    ...(options.initialLedger ?? emptyLiveFixtureLedger(config)),
    entries: [
      ...(options.initialLedger?.entries ?? []),
      ledgerEntry({
        phase: 'preflight',
        objectId: config.dataSourceId,
        objectType: 'data_source',
        purpose: 'capability-preflight-data-source-access',
        cleanupState: 'verified-cleaned',
      }),
      ledgerEntry({
        phase: 'preflight',
        objectId: config.parentPageId,
        objectType: 'page',
        purpose: 'capability-preflight-parent-page-access',
        cleanupState: 'verified-cleaned',
      }),
    ],
  }

  await (options.writeLedger ?? makeLiveFixtureLedgerWriter({ env, config }))({
    path: config.ledgerPath,
    ledger,
  })

  return {
    runId: config.runId,
    dataSourceId: config.dataSourceId,
    parentPageId: config.parentPageId,
    supportedCapabilities: result.preflight.supportedCapabilities,
    missingCapabilities: result.preflight.missingCapabilities,
    ledgerPath: config.ledgerPath,
    ledger,
  }
}
