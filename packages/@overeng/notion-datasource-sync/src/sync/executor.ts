import { Effect, Schema, Stream } from 'effect'

import type { PatchPagePropertiesCommand, RemoteWriteCommand } from '../core/commands.ts'
import {
  bodyPointerIdentityDigest,
  renderedBodyDigest,
  PropertyId,
  type BodyPointer,
  type Hash,
  type NotionRequestId,
  type PageId,
} from '../core/domain.ts'
import { LocalStoreError, NotionGatewayError, type BodySyncError } from '../core/errors.ts'
import { IdempotencyKey } from '../core/events.ts'
import type { GuardName } from '../core/guards.ts'
import { NotionDataSourceGateway, PageBodySyncPort } from '../core/ports.ts'
import { notionRequestId } from '../gateway/gateway.ts'
import {
  annotateSpan,
  commandKind as otelCommandKind,
  shortSpanId,
  spanAttr,
  spanLabel,
  spanNames,
  withSpan,
} from '../observability/observability.ts'
import { hashStoreBytes, pageLifecycleHash } from '../store/projections.ts'
import {
  type ClaimedOutboxCommand,
  type NotionSyncStore,
  type OutboxClaimOptions,
} from '../store/store.ts'

/** Options for `executeOutboxOnce`: combines the store reference with outbox claim parameters (lease token, duration, root id). */
export type OutboxExecutorOptions = OutboxClaimOptions & {
  readonly store: NotionSyncStore
}

/**
 * Outcome of a single outbox executor step.
 *
 * - `idle` — no commands were ready to execute.
 * - `settled` — command executed and surface hash verified (success or idempotent no-op).
 * - `failed` — command was blocked, fenced, ambiguous, or encountered a retryable error; `guard` names the blocking condition.
 */
export type OutboxExecutionResult =
  | { readonly _tag: 'idle' }
  | {
      readonly _tag: 'settled'
      readonly commandId: ClaimedOutboxCommand['commandId']
      readonly settlementKind: 'verified-success' | 'verified-no-op'
    }
  | {
      readonly _tag: 'failed'
      readonly commandId: ClaimedOutboxCommand['commandId']
      readonly guard: GuardName
      readonly attemptState: 'retryable' | 'blocked' | 'fenced' | 'ambiguous'
    }

type CurrentSurface = {
  readonly baseHash: Hash
  readonly verificationHash: Hash
  readonly requestId: NotionRequestId
  readonly bodyPointer?: BodyPointer
}

type RemoteWriteResult = {
  readonly requestId: NotionRequestId
  readonly createdPageId?: PageId
  readonly createdPropertiesHash?: Hash
  readonly bodyPointer?: BodyPointer
}

/** Canonical payload hashed to verify a relation property patch — the sorted target page ids under a stable tag. */
const RelationVerificationPayload = Schema.TaggedStruct('relation', {
  pageIds: Schema.Array(Schema.String),
}).annotate({ identifier: 'NotionDatasourceSync.RelationVerificationPayload' })

const encodeRelationVerificationJson = Schema.encodeSync(
  Schema.fromJsonString(RelationVerificationPayload),
)

const relationPatchVerificationHash = (
  command: PatchPagePropertiesCommand,
): Effect.Effect<Hash | undefined, NotionGatewayError, NotionDataSourceGateway> => {
  const entries = Object.entries(command.propertyPatch)
  const [propertyId, value] = entries[0] ?? []
  if (entries.length !== 1 || propertyId === undefined || value?._tag !== 'relation') {
    // The success channel is `Hash | undefined`; `Effect.void` would widen it to
    // include `void` and break the explicit return type, so keep the explicit `undefined`.
    // @effect-diagnostics-next-line effectSucceedWithVoid:off
    return Effect.succeed(undefined)
  }

  return Effect.gen(function* () {
    const gateway = yield* NotionDataSourceGateway
    const pages = yield* gateway
      .retrievePageProperty({
        _tag: 'RetrievePagePropertyInput',
        pageId: command.pageId,
        // `propertyId` is a key of `command.propertyPatch`, a `Schema.Record` keyed by
        // `PropertyId`, so it is already a validated `PropertyId`; this is a pure re-brand
        // of an invariant-guaranteed value. A failure here is a defect, not a typed error,
        // so we keep the sync decode rather than widen the channel with `ParseError`.
        // @effect-diagnostics-next-line schemaSyncInEffect:off
        propertyId: Schema.decodeSync(PropertyId)(propertyId),
        startCursor: null,
      })
      .pipe(Stream.runCollect)
    const terminal = pages.at(-1)
    if (terminal === undefined || terminal.hasMore === true) return undefined
    const pageIds = pages
      .flatMap((page) => page.items)
      .map((item) => {
        if (item.valueJson === undefined) return undefined
        const decoded = JSON.parse(item.valueJson) as { readonly id?: unknown }
        return typeof decoded.id === 'string' ? decoded.id : undefined
      })
      .filter((pageId): pageId is string => pageId !== undefined)
      .toSorted()
    return hashStoreBytes(encodeRelationVerificationJson({ _tag: 'relation', pageIds }))
  })
}

type ExecutorError = LocalStoreError | NotionGatewayError | BodySyncError

const idempotencyKey = Schema.decodeUnknownSync(IdempotencyKey)

const storeEffect = <TValue>({
  operation,
  f,
}: {
  readonly operation: string
  readonly f: () => TValue
}): Effect.Effect<TValue, LocalStoreError> =>
  Effect.try({
    try: f,
    catch: (cause) => {
      if (cause instanceof LocalStoreError) return cause
      const causeMessage = cause instanceof Error ? cause.message : String(cause)
      return new LocalStoreError({
        operation,
        message: `Local store operation failed: ${operation}: ${causeMessage}`,
        cause,
      })
    },
  })

const commandTag = (command: RemoteWriteCommand): string => command._tag.replace(/Command$/, '')

const commandPageId = (command: RemoteWriteCommand): string | undefined =>
  'pageId' in command ? command.pageId : undefined

const commandDataSourceId = (command: RemoteWriteCommand): string | undefined =>
  'dataSourceId' in command ? command.dataSourceId : undefined

const bodyPointerSpanAttributes = (pointer: BodyPointer | undefined) =>
  pointer === undefined
    ? {}
    : {
        [spanAttr.bodyIdentityKind]: pointer.identity._tag,
        [spanAttr.bodyIdentityDigest]: bodyPointerIdentityDigest(pointer),
        [spanAttr.bodyRenderedDigest]: renderedBodyDigest(pointer.identity),
        [spanAttr.bodyEvidenceDigest]:
          pointer.identity._tag === 'EvidenceBackedBodyIdentity'
            ? pointer.identity.evidenceFingerprint
            : undefined,
        [spanAttr.bodyCompleteness]:
          pointer.identity._tag === 'EvidenceBackedBodyIdentity'
            ? pointer.identity.completeness
            : undefined,
      }

const commandSpanAttributes = (input: {
  readonly operation: string
  readonly command: RemoteWriteCommand
}) => ({
  [spanAttr.spanLabel]: spanLabel(
    input.operation,
    otelCommandKind(input.command._tag),
    shortSpanId(input.command.commandId),
  ),
  [spanAttr.processRole]: 'library',
  [spanAttr.operation]: input.operation,
  [spanAttr.commandId]: input.command.commandId,
  [spanAttr.commandKind]: otelCommandKind(input.command._tag),
  [spanAttr.dataSourceId]: commandDataSourceId(input.command),
  [spanAttr.pageId]: commandPageId(input.command),
  ...bodyPointerSpanAttributes(
    input.command._tag === 'BodyPushCommand' ? input.command.baseBodyPointer : undefined,
  ),
})

const commandBaseHash = (command: RemoteWriteCommand): Hash => {
  switch (command._tag) {
    case 'PatchPagePropertiesCommand':
    case 'TrashPageCommand':
    case 'RestorePageCommand':
      return command.basePropertiesHash
    case 'PatchDataSourceSchemaCommand':
      return command.baseSchemaHash
    case 'PatchDataSourceMetadataCommand':
    case 'PatchDatabaseMetadataCommand':
      return command.baseMetadataHash
    case 'BodyPushCommand':
      return bodyPointerIdentityDigest(command.baseBodyPointer)
    case 'CreatePageCommand':
      return command.baseSchemaHash
  }
}

const observeCurrentSurface = (
  command: RemoteWriteCommand,
): Effect.Effect<
  CurrentSurface,
  NotionGatewayError | BodySyncError,
  NotionDataSourceGateway | PageBodySyncPort
> =>
  Effect.gen(function* () {
    switch (command._tag) {
      case 'PatchPagePropertiesCommand':
      case 'TrashPageCommand':
      case 'RestorePageCommand': {
        const gateway = yield* NotionDataSourceGateway
        const page = yield* gateway.retrievePage(command.pageId)
        if (command._tag === 'PatchPagePropertiesCommand') {
          return {
            baseHash: page.propertiesHash,
            verificationHash: page.propertiesHash,
            requestId: page.requestId,
          }
        }
        return {
          baseHash: page.propertiesHash,
          verificationHash: pageLifecycleHash({ pageId: command.pageId, inTrash: page.inTrash }),
          requestId: page.requestId,
        }
      }
      case 'PatchDataSourceSchemaCommand': {
        const gateway = yield* NotionDataSourceGateway
        const dataSource = yield* gateway.retrieveDataSource(command.dataSourceId)
        return {
          baseHash: dataSource.schemaHash,
          verificationHash: dataSource.schemaHash,
          requestId: dataSource.requestId,
        }
      }
      case 'CreatePageCommand': {
        const gateway = yield* NotionDataSourceGateway
        const dataSource = yield* gateway.retrieveDataSource(command.dataSourceId)
        return {
          baseHash: dataSource.schemaHash,
          verificationHash: dataSource.schemaHash,
          requestId: dataSource.requestId,
        }
      }
      case 'PatchDataSourceMetadataCommand': {
        const gateway = yield* NotionDataSourceGateway
        const dataSource = yield* gateway.retrieveDataSource(command.dataSourceId)
        if (dataSource.metadataHash === undefined) {
          return yield* new NotionGatewayError({
            operation: 'retrieveDataSource',
            dataSourceId: command.dataSourceId,
            guard: 'CurrentSurfaceMissing',
            message: 'Current data-source metadata projection is missing',
          })
        }
        return {
          baseHash: dataSource.metadataHash,
          verificationHash: dataSource.metadataHash,
          requestId: dataSource.requestId,
        }
      }
      case 'PatchDatabaseMetadataCommand': {
        const gateway = yield* NotionDataSourceGateway
        const dataSource = yield* gateway.retrieveDataSource(command.dataSourceId)
        if (dataSource.metadataHash === undefined) {
          return yield* new NotionGatewayError({
            operation: 'retrieveDataSource',
            dataSourceId: command.dataSourceId,
            guard: 'CurrentSurfaceMissing',
            message: 'Current database metadata projection is missing',
          })
        }
        return {
          baseHash: dataSource.metadataHash,
          verificationHash: dataSource.metadataHash,
          requestId: dataSource.requestId,
        }
      }
      case 'BodyPushCommand': {
        const body = yield* PageBodySyncPort
        const pointer = yield* body.observe({ _tag: 'ObserveBodyInput', pageId: command.pageId })
        return {
          baseHash: bodyPointerIdentityDigest(pointer),
          verificationHash: renderedBodyDigest(pointer.identity),
          requestId: notionRequestId(`body-observe:${command.commandId}`),
          bodyPointer: pointer,
        }
      }
    }
  }).pipe(
    withSpan({
      span: 'outboxObserveSurface',
      attributes: commandSpanAttributes({
        operation: 'observeCurrentSurface',
        command,
      }),
    }),
  )

const executeRemoteWrite = (
  command: RemoteWriteCommand,
): Effect.Effect<
  RemoteWriteResult,
  NotionGatewayError | BodySyncError,
  NotionDataSourceGateway | PageBodySyncPort
> =>
  Effect.gen(function* () {
    switch (command._tag) {
      case 'PatchPagePropertiesCommand': {
        const gateway = yield* NotionDataSourceGateway
        const requestId = yield* gateway.patchPageProperties(command)
        return { requestId }
      }
      case 'CreatePageCommand': {
        const gateway = yield* NotionDataSourceGateway
        const result = yield* gateway.createPage(command)
        return {
          requestId: result.requestId,
          createdPageId: result.pageId,
          createdPropertiesHash: result.propertiesHash,
        }
      }
      case 'PatchDataSourceSchemaCommand': {
        const gateway = yield* NotionDataSourceGateway
        const requestId = yield* gateway.patchDataSourceSchema(command)
        return { requestId }
      }
      case 'PatchDataSourceMetadataCommand': {
        const gateway = yield* NotionDataSourceGateway
        const requestId = yield* gateway.patchDataSourceMetadata(command)
        return { requestId }
      }
      case 'PatchDatabaseMetadataCommand': {
        const gateway = yield* NotionDataSourceGateway
        const requestId = yield* gateway.patchDatabaseMetadata(command)
        return { requestId }
      }
      case 'TrashPageCommand': {
        const gateway = yield* NotionDataSourceGateway
        const requestId = yield* gateway.trashPage(command)
        return { requestId }
      }
      case 'RestorePageCommand': {
        const gateway = yield* NotionDataSourceGateway
        const requestId = yield* gateway.restorePage(command)
        return { requestId }
      }
      case 'BodyPushCommand': {
        const body = yield* PageBodySyncPort
        const result = yield* body.push(command)
        return { requestId: result.requestId, bodyPointer: result.bodyPointer }
      }
    }
  }).pipe(
    withSpan({
      span: 'outboxWriteRemote',
      attributes: commandSpanAttributes({
        operation: 'executeRemoteWrite',
        command,
      }),
    }),
  )

const guardFromWriteError = (error: NotionGatewayError | BodySyncError): GuardName =>
  error instanceof NotionGatewayError && error.guard !== undefined
    ? error.guard
    : 'CurrentSurfaceMissing'

const retryAfterFromWriteError = (
  error: NotionGatewayError | BodySyncError,
): { readonly retryAfterMillis?: number } =>
  error instanceof NotionGatewayError && error.retryAfterMillis !== undefined
    ? { retryAfterMillis: error.retryAfterMillis }
    : {}

const recordAttemptState = ({
  options,
  claimed,
  attemptState,
  guard,
  retryAfterMillis,
}: {
  readonly options: OutboxExecutorOptions
  readonly claimed: ClaimedOutboxCommand
  readonly attemptState: 'retryable' | 'blocked' | 'fenced' | 'ambiguous'
  readonly guard: GuardName
  readonly retryAfterMillis?: number
}) =>
  storeEffect({
    operation: 'append-outbox-attempt-state',
    f: () =>
      options.store.appendOutboxAttemptState({
        rootId: claimed.rootId,
        commandId: claimed.commandId,
        commandKey: claimed.commandKey,
        surface: claimed.surface,
        attempt: claimed.attempt,
        attemptState,
        leaseToken: claimed.leaseToken,
        guard,
        ...(retryAfterMillis === undefined ? {} : { retryAfterMillis }),
        idempotencyKey: idempotencyKey(
          `${claimed.commandKey}:attempt-state:${claimed.attempt}:${attemptState}:${guard}:${
            retryAfterMillis ?? 'no-retry-after'
          }`,
        ),
      }),
  }).pipe(
    Effect.as({
      _tag: 'failed' as const,
      commandId: claimed.commandId,
      guard,
      attemptState,
    }),
  )

const settle = ({
  options,
  claimed,
  command,
  requestId,
  observedHash,
  bodyPointer,
  createdPageId,
  settlementKind,
}: {
  readonly options: OutboxExecutorOptions
  readonly claimed: ClaimedOutboxCommand
  readonly command: RemoteWriteCommand
  readonly requestId: NotionRequestId
  readonly observedHash: Hash
  readonly bodyPointer?: BodyPointer
  readonly createdPageId?: PageId
  readonly settlementKind: 'verified-success' | 'verified-no-op'
}) =>
  storeEffect({
    operation: 'append-outbox-settlement',
    f: () =>
      options.store.appendOutboxSettlement({
        rootId: claimed.rootId,
        commandId: claimed.commandId,
        commandKey: claimed.commandKey,
        surface: claimed.surface,
        commandTag: commandTag(command),
        requestId,
        desiredHash: claimed.desiredHash,
        observedHash,
        ...(bodyPointer === undefined ? {} : { bodyPointer }),
        ...(createdPageId === undefined ? {} : { createdPageId }),
        settlementKind,
        idempotencyKey: idempotencyKey(`${claimed.commandKey}:settled`),
      }),
  }).pipe(
    Effect.as({
      _tag: 'settled' as const,
      commandId: claimed.commandId,
      settlementKind,
    }),
  )

const annotateOutboxResult = (result: OutboxExecutionResult) =>
  annotateSpan({
    [spanAttr.result]: result._tag,
    [spanAttr.guard]: result._tag === 'failed' ? result.guard : undefined,
    [spanAttr.settlementKind]: result._tag === 'settled' ? result.settlementKind : undefined,
  })

/** Claim and attempt to execute one pending outbox command: observe the current surface, execute the write if safe, then verify the post-write state. Returns `idle` when the outbox is empty. */
export const executeOutboxOnce = Effect.fn(spanNames.outboxAttempt)(
  (
    options: OutboxExecutorOptions,
  ): Effect.Effect<
    OutboxExecutionResult,
    ExecutorError,
    NotionDataSourceGateway | PageBodySyncPort
  > =>
    Effect.gen(function* () {
      yield* annotateSpan({
        [spanAttr.spanLabel]: spanLabel('outbox', shortSpanId(options.rootId)),
        [spanAttr.processRole]: 'library',
        [spanAttr.operation]: 'executeOutboxOnce',
        [spanAttr.rootId]: options.rootId,
        [spanAttr.leaseDurationMs]: options.leaseDurationMs,
      })
      const claimed = yield* storeEffect({
        operation: 'claim-next-outbox-command',
        f: () => options.store.claimNextOutboxCommand(options),
      })

      if (claimed === undefined) {
        const result = { _tag: 'idle' as const }
        yield* annotateSpan({
          [spanAttr.spanLabel]: spanLabel('outbox', 'idle'),
        })
        yield* annotateOutboxResult(result)
        return result
      }

      yield* annotateSpan({
        [spanAttr.spanLabel]: spanLabel('outbox', shortSpanId(claimed.commandId)),
        [spanAttr.commandId]: claimed.commandId,
        [spanAttr.attempt]: claimed.attempt,
      })

      if (claimed.command === undefined) {
        const result = yield* recordAttemptState({
          options,
          claimed,
          attemptState: 'blocked',
          guard: 'CurrentSurfaceMissing',
        })
        yield* annotateOutboxResult(result)
        return result
      }

      const command = claimed.command
      yield* annotateSpan({
        [spanAttr.spanLabel]: spanLabel(
          otelCommandKind(command._tag),
          shortSpanId(command.commandId),
        ),
        [spanAttr.commandKind]: otelCommandKind(command._tag),
        [spanAttr.dataSourceId]: commandDataSourceId(command),
        [spanAttr.pageId]: commandPageId(command),
      })
      const before = yield* observeCurrentSurface(command).pipe(
        Effect.catch((error) =>
          recordAttemptState({
            options,
            claimed,
            attemptState:
              error instanceof NotionGatewayError && error.guard === 'StaleSurfaceBase'
                ? 'blocked'
                : 'retryable',
            guard: guardFromWriteError(error),
            ...retryAfterFromWriteError(error),
          }),
        ),
      )

      if ('_tag' in before) {
        yield* annotateOutboxResult(before)
        return before
      }

      if (before.verificationHash === claimed.desiredHash) {
        const result = yield* settle({
          options,
          claimed,
          command,
          requestId: before.requestId,
          observedHash: before.verificationHash,
          ...(before.bodyPointer === undefined ? {} : { bodyPointer: before.bodyPointer }),
          settlementKind: 'verified-no-op',
        })
        yield* annotateOutboxResult(result)
        return result
      }

      if (claimed.attemptState === 'ambiguous') {
        // Reclaiming an expired running command already records the ambiguous
        // attempt in the store. Do not append a second same-attempt event here;
        // for create-page commands, retrying blindly could duplicate a row.
        const result = {
          _tag: 'failed' as const,
          commandId: claimed.commandId,
          attemptState: 'ambiguous' as const,
          guard: 'AmbiguousCommandOutcome' as const,
        } satisfies OutboxExecutionResult
        yield* annotateOutboxResult(result)
        return result
      }

      if (before.baseHash !== commandBaseHash(command)) {
        const result = yield* recordAttemptState({
          options,
          claimed,
          attemptState: 'blocked',
          guard: 'StaleSurfaceBase',
        })
        yield* annotateOutboxResult(result)
        return result
      }

      const leaseActive = yield* storeEffect({
        operation: 'check-outbox-lease',
        f: () =>
          options.store.isOutboxLeaseActive({
            rootId: claimed.rootId,
            commandId: claimed.commandId,
            leaseToken: claimed.leaseToken,
          }),
      })

      if (leaseActive === false) {
        const result = yield* recordAttemptState({
          options,
          claimed,
          attemptState: 'fenced',
          guard: 'LeaseFenceMismatch',
        })
        yield* annotateOutboxResult(result)
        return result
      }

      const writeResult = yield* executeRemoteWrite(command).pipe(
        Effect.catch((error) =>
          recordAttemptState({
            options,
            claimed,
            attemptState:
              error instanceof NotionGatewayError && error.guard === 'StaleSurfaceBase'
                ? 'blocked'
                : 'retryable',
            guard: guardFromWriteError(error),
            ...retryAfterFromWriteError(error),
          }),
        ),
      )

      if ('_tag' in writeResult) {
        yield* annotateOutboxResult(writeResult)
        return writeResult
      }

      const after =
        command._tag === 'CreatePageCommand' &&
        writeResult.createdPageId !== undefined &&
        writeResult.createdPropertiesHash !== undefined
          ? {
              baseHash: command.baseSchemaHash,
              verificationHash: writeResult.createdPropertiesHash,
              requestId: writeResult.requestId,
            }
          : yield* observeCurrentSurface(command).pipe(
              Effect.catch((error) =>
                recordAttemptState({
                  options,
                  claimed,
                  attemptState: 'retryable',
                  guard: guardFromWriteError(error),
                  ...retryAfterFromWriteError(error),
                }),
              ),
            )

      if ('_tag' in after) {
        yield* annotateOutboxResult(after)
        return after
      }

      // Page-property commands claim a property-surface hash, while the API only lets us
      // re-observe the full page property hash after patching.
      const propertyPatchChangedPage =
        command._tag === 'PatchPagePropertiesCommand' && after.baseHash !== before.baseHash
      const relationPatchHash =
        command._tag === 'PatchPagePropertiesCommand'
          ? yield* relationPatchVerificationHash(command).pipe(
              Effect.catch((error) =>
                recordAttemptState({
                  options,
                  claimed,
                  attemptState: 'retryable',
                  guard: guardFromWriteError(error),
                  ...retryAfterFromWriteError(error),
                }),
              ),
            )
          : undefined
      if (typeof relationPatchHash === 'object' && '_tag' in relationPatchHash) {
        yield* annotateOutboxResult(relationPatchHash)
        return relationPatchHash
      }
      const createReturnedPage =
        command._tag === 'CreatePageCommand' && writeResult.createdPageId !== undefined
      const verified =
        after.verificationHash === claimed.desiredHash ||
        relationPatchHash === claimed.desiredHash ||
        propertyPatchChangedPage ||
        createReturnedPage
      const bodyPointer = writeResult.bodyPointer ?? after.bodyPointer
      const result =
        verified === true
          ? yield* settle({
              options,
              claimed,
              command,
              requestId: writeResult.requestId,
              observedHash:
                propertyPatchChangedPage === true || createReturnedPage === true
                  ? claimed.desiredHash
                  : after.verificationHash,
              ...(writeResult.createdPageId === undefined
                ? {}
                : { createdPageId: writeResult.createdPageId }),
              ...(bodyPointer === undefined ? {} : { bodyPointer }),
              settlementKind: 'verified-success',
            })
          : yield* recordAttemptState({
              options,
              claimed,
              attemptState: 'retryable',
              guard: 'ReadAfterWriteMismatch',
            })
      yield* annotateOutboxResult(result)
      return result
    }),
)
