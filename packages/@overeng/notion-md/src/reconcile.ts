import { basename } from 'node:path'

import { Effect, FileSystem, type Path } from 'effect'

import {
  gateNmdLocalState,
  NOTION_API_VERSION,
  type NmdFrontmatterV2,
  type NmdLocalState,
  type NmdParentRef,
  type NmdStorage,
  type NmdSyncStateV1,
  type NmdWritablePropertyValue,
} from '@overeng/notion-effect-client'

import { runBatch, type BatchResult } from './batch.ts'
import { canonicalizeBlockMarkdown } from './canonical-markdown.ts'
import { classifyCommentWrite, type CommentWriteOperation } from './comment-boundary.ts'
import {
  NmdCliError,
  NmdConflictError,
  NmdDestructiveBodyBlockedError,
  NmdFrontmatterError,
  NmdNonBodyWriteBlockedError,
  type NmdError,
} from './errors.ts'
import { parseNmdFile, renderNmdFile } from './frontmatter.ts'
import { normalizeMarkdownLineEndings, sha256Digest } from './hash.ts'
import { classifyMediaWrite, type MediaWriteOperation } from './media-boundary.ts'
import { NotionMdGateway, type RemotePageSnapshot } from './model.ts'
import {
  CommentBoundarySpan,
  DestructiveBodySpan,
  MediaBoundarySpan,
  ReconcileFileSpan,
  StatusFileSpan,
  TrackPageSpan,
  withOperation,
} from './observability.ts'
import {
  decideReconcile,
  porcelainStatus,
  type PorcelainStatus,
  type ReconcileDecision,
} from './reconcile-core.ts'
import { decideShared, sharedPorcelain, type SharedOutcome } from './reconcile-shared.ts'
import {
  garbageCollectObjects,
  NmdStateStore,
  readBaseSnapshot,
  readSyncStateOptional,
  validateReferencedObjects,
  type NmdObjectGcResult,
} from './state-store.ts'
import { findTreeMembership } from './tree-index.ts'

/*
 * Source-aware reconcile engine (spec "Internal layering").
 *
 * `statusFile` is read-only and safe by construction: it never reaches an apply
 * path. `reconcileFile` dispatches per file on frontmatter `source` (R34) —
 * never on flags or arity — and moves the file toward in-sync.
 *
 * The single-source path (`local`/`remote`) is stateless: it compares
 * `render(local)` against `read(current remote)` under the R33 relation with no
 * stored base. The `shared` path is the only one that touches the base+merge
 * leaf.
 */

/** Read a `.nmd` file and pair it with its (optional) sidecar via the R31/R32 gate. */
const readGatedLocalState = (path: string): Effect.Effect<NmdLocalState, NmdError, NmdStateStore> =>
  Effect.gen(function* () {
    const store = yield* NmdStateStore
    const content = yield* store.readNmdFile({ path })
    const parsed = yield* parseNmdFile({ path, content })
    const pageId = parsed.frontmatter.notion_md.page_id
    const syncState = pageId === null ? undefined : yield* readSyncStateOptional({ path, pageId })
    const gated = gateNmdLocalState({ frontmatter: parsed.frontmatter, syncState })
    if (gated instanceof Error) {
      return yield* new NmdFrontmatterError({
        path,
        message: gated.message,
      })
    }
    if (gated._tag === 'shared-bound') {
      yield* validateReferencedObjects({ path, syncState: gated.syncState })
    }
    return gated
  })

/** The local body for a `.nmd` file, in canonical R33 form. */
const localBody = (path: string): Effect.Effect<string, NmdError, NmdStateStore> =>
  Effect.gen(function* () {
    const store = yield* NmdStateStore
    const content = yield* store.readNmdFile({ path })
    const parsed = yield* parseNmdFile({ path, content })
    return parsed.body
  })

/** Result of a read-only status pass over one self-describing `.nmd` file. */
export interface ReconcileStatus {
  readonly path: string
  readonly source: NmdLocalState['_tag']
  readonly pageId: string | undefined
  /** git-porcelain word: in-sync / local-ahead / remote-ahead / diverged / unbound. */
  readonly status: PorcelainStatus
}

/** Options for a single-page reconcile/sync pass: target path plus the destructive-write and dry-run gates. */
export interface ReconcileOptions {
  readonly path: string
  readonly force?: boolean
  readonly dryRun?: boolean
  readonly allowDeletingUnknownBlocks?: boolean
  readonly allowReviewMarkup?: boolean
  readonly gcObjects?: boolean
}

type WithObjectGc = {
  readonly objectGc?: NmdObjectGcResult
}

/** Tagged result of one `reconcileFile` pass. */
export type ReconcileResult =
  | ({
      readonly _tag: 'noop'
      readonly path: string
      readonly pageId: string
      readonly dryRun?: true
    } & WithObjectGc)
  | ({ readonly _tag: 'created'; readonly path: string; readonly pageId: string } & WithObjectGc)
  | ({
      readonly _tag: 'created'
      readonly path: string
      readonly pageId: undefined
      readonly parentPageId: string
      readonly dryRun: true
    } & WithObjectGc)
  | ({
      readonly _tag: 'pushed'
      readonly path: string
      readonly pageId: string
      readonly dryRun?: true
    } & WithObjectGc)
  | ({
      readonly _tag: 'pulled'
      readonly path: string
      readonly pageId: string
      readonly dryRun?: true
    } & WithObjectGc)
  | ({
      readonly _tag: 'shared-merged'
      readonly path: string
      readonly pageId: string
      readonly dryRun?: true
    } & WithObjectGc)
  | ({
      readonly _tag: 'shared-conflict'
      readonly path: string
      readonly pageId: string
      readonly conflictPath: string
      readonly dryRun?: true
    } & WithObjectGc)

/** Construct a `ReconcileResult` with literal `_tag` discrimination preserved. */
const result = (r: ReconcileResult): ReconcileResult => r

/** Construct a `ReconcileStatus` with literal discrimination preserved. */
const statusResult = (s: ReconcileStatus): ReconcileStatus => s

const containsRoughdraftReviewMarkup = (body: string): boolean =>
  /\{(?:==|\+\+|--|~~|>>)/u.test(body)

const storageUnknownBlockIds = (storage: NmdStorage): readonly string[] => {
  switch (storage._tag) {
    case 'self_contained':
      return storage.unsupported_blocks.map((block) => block.block_id)
    case 'object_store':
      return storage.unsupported_block_ids
  }
}

const unique = (values: readonly string[]): readonly string[] => [...new Set(values)]

const unresolvedUnknownBlockIds = (opts: {
  readonly syncState?: NmdSyncStateV1
  readonly remoteUnknownBlockIds?: readonly string[]
}): readonly string[] =>
  unique([
    ...(opts.syncState?.body.unknown_block_ids ?? []),
    ...(opts.syncState === undefined ? [] : storageUnknownBlockIds(opts.syncState.storage)),
    ...(opts.remoteUnknownBlockIds ?? []),
  ])

const assertReviewMarkupAllowed = (opts: {
  readonly path: string
  readonly pageId: string
  readonly body: string
  readonly allowReviewMarkup?: boolean | undefined
}): Effect.Effect<void, NmdDestructiveBodyBlockedError> => {
  const blocked =
    containsRoughdraftReviewMarkup(opts.body) === true && opts.allowReviewMarkup !== true
  return Effect.gen(function* () {
    if (blocked === true) {
      return yield* new NmdDestructiveBodyBlockedError({
        page_id: opts.pageId,
        guard: 'ReviewMarkupAsContent',
        message:
          'Local body contains unresolved Roughdraft review markup; refusing sync so review state is not sent as Notion content. Pass --allow-review-markup only when writing the literal markup is intended.',
        allowFlag: '--allow-review-markup',
      })
    }
  }).pipe(
    withOperation({
      operation: DestructiveBodySpan,
      attributes: {
        guard: 'ReviewMarkupAsContent',
        blockCount: 0,
        verdict: blocked === true ? 'blocked' : 'inert',
      },
    }),
  )
}

const assertUnknownDeletionAllowed = (opts: {
  readonly path: string
  readonly pageId: string
  readonly unknownBlockIds: readonly string[]
  readonly allowDeletingUnknownBlocks?: boolean | undefined
}): Effect.Effect<void, NmdDestructiveBodyBlockedError> => {
  const blocked = opts.unknownBlockIds.length > 0 && opts.allowDeletingUnknownBlocks !== true
  return Effect.gen(function* () {
    if (blocked === true) {
      return yield* new NmdDestructiveBodyBlockedError({
        page_id: opts.pageId,
        guard: 'UnknownBlockDeletion',
        message:
          'Page contains unresolved unknown Notion blocks; refusing sync because the body write can delete them. Pass --allow-delete-unknown-blocks only for explicit destructive intent.',
        allowFlag: '--allow-delete-unknown-blocks',
      })
    }
  }).pipe(
    withOperation({
      operation: DestructiveBodySpan,
      attributes: {
        guard: 'UnknownBlockDeletion',
        blockCount: opts.unknownBlockIds.length,
        verdict: blocked === true ? 'blocked' : 'inert',
      },
    }),
  )
}

const maybeGcObjects = (opts: {
  readonly path: string
  readonly syncStates: readonly NmdSyncStateV1[]
  readonly enabled?: boolean | undefined
  readonly dryRun?: boolean
}): Effect.Effect<NmdObjectGcResult | undefined, NmdError, NmdStateStore> =>
  opts.enabled === true
    ? garbageCollectObjects({
        path: opts.path,
        syncStates: opts.syncStates,
        ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
      })
    : // @effect-diagnostics-next-line effectSucceedWithVoid:off -- success channel is `NmdObjectGcResult | undefined`; `Effect.void` would narrow to `Effect<void>` and break the union
      Effect.succeed(undefined)

const withObjectGc = <R extends ReconcileResult>({
  result: reconciled,
  objectGc,
}: {
  readonly result: R
  readonly objectGc: NmdObjectGcResult | undefined
}): R => (objectGc === undefined ? reconciled : ({ ...reconciled, objectGc } as R))

const remoteBodyFor = (pageId: string) =>
  Effect.gen(function* () {
    const gateway = yield* NotionMdGateway
    const pulled = yield* gateway.pullPage({ pageId })
    return { pulled, body: normalizeMarkdownLineEndings(pulled.markdown.markdown) }
  })

const rejectTreeManagedMember = (
  path: string,
): Effect.Effect<void, NmdError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const membership = yield* findTreeMembership(path)
    if (membership !== undefined && membership.isRoot === false) {
      return yield* new NmdCliError({
        message: `${path} is a member of the notion-md tree at ${membership.root}; run \`notion-md sync ${membership.root}\` (the tree composes child anchors — a single-file operation would use the wrong state root).`,
      })
    }
  })

/**
 * Read-only status (R30/R36 safe-by-construction): there is no write path in
 * this call graph. Reports the live in-sync decision per file in git-porcelain
 * vocabulary.
 */
export const statusFile = (opts: {
  readonly path: string
}): Effect.Effect<
  ReconcileStatus,
  NmdError,
  FileSystem.FileSystem | NotionMdGateway | NmdStateStore
> =>
  Effect.gen(function* () {
    yield* rejectTreeManagedMember(opts.path)
    const local = yield* readGatedLocalState(opts.path)

    if (local._tag === 'local-unbound') {
      return statusResult({
        path: opts.path,
        source: local._tag,
        pageId: undefined,
        status: 'unbound',
      })
    }

    const pageId = local.pageId
    const { body: remote } = yield* remoteBodyFor(pageId)
    const rendered = yield* localBody(opts.path)

    if (local._tag === 'shared-bound') {
      const base = yield* readBaseSnapshot({ path: opts.path, syncState: local.syncState })
      const outcome = decideShared({ baseBody: base.body, localBody: rendered, remoteBody: remote })
      return statusResult({
        path: opts.path,
        source: local._tag,
        pageId,
        status: sharedPorcelain(outcome),
      })
    }

    const decision = decideReconcile({
      local,
      compare: { renderedLocal: rendered, currentRemote: remote },
    })
    return statusResult({
      path: opts.path,
      source: local._tag,
      pageId,
      status: porcelainStatus(decision),
    })
  }).pipe(withOperation({ operation: StatusFileSpan, attributes: { label: basename(opts.path) } }))

const toParentRef = (page: RemotePageSnapshot): NmdParentRef => {
  switch (page.parent.type) {
    case 'page_id':
      return { _tag: 'page', id: page.parent.page_id }
    case 'data_source_id':
      return { _tag: 'data_source', id: page.parent.data_source_id }
    case 'database_id':
      return { _tag: 'database', id: page.parent.database_id }
    case 'block_id':
      return { _tag: 'block', id: page.parent.block_id }
    case 'workspace':
      return { _tag: 'workspace' }
    case 'agent_id':
      return { _tag: 'agent', id: page.parent.agent_id }
    default:
      return { _tag: 'unknown', raw: page.parent }
  }
}

const boundFrontmatter = (opts: {
  readonly frontmatter: NmdFrontmatterV2
  readonly page: RemotePageSnapshot
}): NmdFrontmatterV2 => ({
  notion_md: {
    ...opts.frontmatter.notion_md,
    page_id: opts.page.id,
    ...(opts.page.url === undefined ? {} : { url: opts.page.url }),
  },
})

const remoteFrontmatter = (opts: {
  readonly source: NmdFrontmatterV2['notion_md']['source']
  readonly page: RemotePageSnapshot
  /**
   * Writable frontmatter properties to embed (visible-name → value). notion-md
   * does NOT decide which properties are user-editable — the caller (e.g.
   * datasource-sync, from its observed schema/cells) supplies exactly the
   * writable set. Omitted/absent keeps the standalone `{}` behavior so a plain
   * `.nmd` is byte-unchanged (Phase 2 standalone contract).
   */
  readonly properties?: Readonly<Record<string, NmdWritablePropertyValue>>
}): NmdFrontmatterV2 => ({
  notion_md: {
    version: 2,
    api_version: NOTION_API_VERSION,
    object: 'page',
    source: opts.source,
    page_id: opts.page.id,
    ...(opts.page.url === undefined ? {} : { url: opts.page.url }),
    parent: toParentRef(opts.page),
    page: {
      title: opts.page.title,
      icon: opts.page.icon,
      cover: opts.page.cover,
      in_trash: opts.page.in_trash,
      is_locked: opts.page.is_locked,
    },
    properties: opts.properties === undefined ? {} : { ...opts.properties },
  },
})

const parentPageIdOf = (parent: NmdParentRef): string | undefined =>
  parent._tag === 'page' ? parent.id : undefined

const emptyStorage = (): NmdStorage => ({
  _tag: 'self_contained',
  unsupported_blocks: [],
  files: [],
  comments: [],
})

/**
 * Files/media write boundary (SM6.1). Classifies the declared storage at a
 * write site and fails closed with a named guard when it carries modeled,
 * byte-backed file/media payloads notion-md cannot durably transfer yet.
 *
 * Evaluated before the dry-run early-return at every call site, so a blocked
 * media write surfaces the named guard on both the dry-run plan and the apply
 * path (R15). An empty file-unit set (no media, or external-URL-only media,
 * which never enters `storage.files`) is inert and proceeds with no byte
 * transfer.
 */
const guardMediaWrite = (opts: {
  readonly pageId: string
  readonly storage: NmdStorage | undefined
  readonly operation: MediaWriteOperation
}): Effect.Effect<void, NmdNonBodyWriteBlockedError> => {
  const verdict = classifyMediaWrite({ storage: opts.storage, operation: opts.operation })
  const fileCount = verdict._tag === 'blocked' ? verdict.fileIds.length : 0
  return Effect.gen(function* () {
    if (verdict._tag === 'blocked') {
      return yield* new NmdNonBodyWriteBlockedError({
        page_id: opts.pageId,
        guard: verdict.guard,
        fileIds: verdict.fileIds,
        message: `Page ${opts.pageId} ${verdict.reason}`,
      })
    }
  }).pipe(
    withOperation({
      operation: MediaBoundarySpan,
      attributes: {
        operation: opts.operation,
        fileCount,
        verdict: verdict._tag,
        ...(verdict._tag === 'blocked' ? { guard: verdict.guard } : {}),
      },
    }),
  )
}

/**
 * Comment-write boundary (SM6.2). Compares the comment inventory the write would
 * produce against the current inventory and fails closed with
 * `CommentWriteUnsupported` only when they differ — a mutation (add/remove/edit)
 * implies the comments API, which is not yet implemented in v-next. A body-only
 * `replace_content` write never touches comments, so `produced === current` and
 * the gate is inert; the guard is dormant until a real comment-mutation path is
 * wired.
 *
 * Evaluated before the dry-run early-return at every call site, so a blocked
 * comment write surfaces the named guard on both the dry-run plan and the apply
 * path (R15).
 */
const guardCommentWrite = (opts: {
  readonly pageId: string
  readonly storage: NmdStorage | undefined
  readonly operation: CommentWriteOperation
}): Effect.Effect<void, NmdNonBodyWriteBlockedError> => {
  const verdict = classifyCommentWrite({ current: opts.storage, operation: opts.operation })
  const commentCount = verdict._tag === 'blocked' ? verdict.commentIds.length : 0
  return Effect.gen(function* () {
    if (verdict._tag === 'blocked') {
      return yield* new NmdNonBodyWriteBlockedError({
        page_id: opts.pageId,
        guard: verdict.guard,
        // `fileIds` carries the offending unit ids regardless of unit kind,
        // discriminated by `guard` (here: comment unit ids). See its JSDoc.
        fileIds: verdict.commentIds,
        message: `Page ${opts.pageId} ${verdict.reason}`,
      })
    }
  }).pipe(
    withOperation({
      operation: CommentBoundarySpan,
      attributes: {
        operation: opts.operation,
        commentCount,
        verdict: verdict._tag,
        ...(verdict._tag === 'blocked' ? { guard: verdict.guard } : {}),
      },
    }),
  )
}

const writeFile = (opts: {
  readonly path: string
  readonly frontmatter: NmdFrontmatterV2
  readonly body: string
}) =>
  Effect.gen(function* () {
    const store = yield* NmdStateStore
    yield* store.writeNmdFile({
      path: opts.path,
      content: renderNmdFile({ frontmatter: opts.frontmatter, body: opts.body }),
    })
  })

/** Roughdraft conflict artifact path beside the `.nmd` file. */
const conflictPathFor = (path: string): string => `${path}.conflict.roughdraft.md`

const writeSharedConflict = (opts: {
  readonly path: string
  readonly pageId: string
  readonly outcome: Extract<SharedOutcome, { _tag: 'conflict' }>
}): Effect.Effect<string, NmdError, NmdStateStore> =>
  Effect.gen(function* () {
    const store = yield* NmdStateStore
    const conflictPath = conflictPathFor(opts.path)
    const fence = '`'.repeat(4)
    yield* store
      .writeConflictFile({
        path: conflictPath,
        content: `# notion-md body conflict

Page: ${opts.pageId}

## Base body

${fence}markdown
${opts.outcome.baseBody}
${fence}

## Local body

${fence}markdown
${opts.outcome.localBody}
${fence}

## Remote body

${fence}markdown
${opts.outcome.remoteBody}
${fence}
`,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new NmdConflictError({
              path: opts.path,
              page_id: opts.pageId,
              local_changed: true,
              remote_changed: true,
              conflict_path: conflictPath,
              cause,
              message: `Failed to write Roughdraft conflict file ${conflictPath}`,
            }),
        ),
      )
    return conflictPath
  })

/**
 * Reconcile one self-describing `.nmd` file (R34). Dispatches per file on
 * `source`; always moves toward in-sync. `--force` (single-source: inert;
 * shared: local-wins override) is threaded via `force`.
 */
export const reconcileFile = (
  opts: ReconcileOptions,
): Effect.Effect<
  ReconcileResult,
  NmdError,
  FileSystem.FileSystem | NotionMdGateway | NmdStateStore
> =>
  Effect.gen(function* () {
    yield* rejectTreeManagedMember(opts.path)
    const gateway = yield* NotionMdGateway
    const local = yield* readGatedLocalState(opts.path)
    const rendered = yield* localBody(opts.path)

    // source: local, unbound — create the remote page under `parent`.
    if (local._tag === 'local-unbound') {
      const parentPageId = parentPageIdOf(local.frontmatter.notion_md.parent)
      if (parentPageId === undefined) {
        return yield* new NmdFrontmatterError({
          path: opts.path,
          message:
            'Unbound source: local file needs a page parent to create under (parent must be { _tag: "page", id }).',
        })
      }
      yield* assertReviewMarkupAllowed({
        path: opts.path,
        pageId: 'unbound',
        body: rendered,
        allowReviewMarkup: opts.allowReviewMarkup,
      })
      if (opts.dryRun === true) {
        const objectGc = yield* maybeGcObjects({
          path: opts.path,
          syncStates: [],
          enabled: opts.gcObjects,
          dryRun: true,
        })
        return result(
          withObjectGc({
            result: {
              _tag: 'created',
              path: opts.path,
              pageId: undefined,
              parentPageId,
              dryRun: true,
            },
            objectGc: objectGc,
          }),
        )
      }
      const page = yield* gateway.createPage({
        parentPageId,
        title: local.frontmatter.notion_md.page.title,
        markdown: canonicalizeBlockMarkdown(rendered),
      })
      yield* writeFile({
        path: opts.path,
        frontmatter: boundFrontmatter({ frontmatter: local.frontmatter, page }),
        body: rendered,
      })
      const objectGc = yield* maybeGcObjects({
        path: opts.path,
        syncStates: [],
        enabled: opts.gcObjects,
        dryRun: false,
      })
      return result(
        withObjectGc({
          result: { _tag: 'created', path: opts.path, pageId: page.id },
          objectGc: objectGc,
        }),
      )
    }

    const pageId = local.pageId
    const { pulled, body: remote } = yield* remoteBodyFor(pageId)

    if (local._tag === 'shared-bound') {
      return yield* reconcileSharedFile({
        path: opts.path,
        pageId,
        syncState: local.syncState,
        frontmatter: local.frontmatter,
        rendered,
        remote,
        remoteUnknownBlockIds: pulled.markdown.unknown_block_ids,
        page: pulled.page,
        force: opts.force === true,
        dryRun: opts.dryRun === true,
        allowDeletingUnknownBlocks: opts.allowDeletingUnknownBlocks === true,
        allowReviewMarkup: opts.allowReviewMarkup === true,
        gcObjects: opts.gcObjects === true,
      })
    }

    const decision: ReconcileDecision = decideReconcile({
      local,
      compare: { renderedLocal: rendered, currentRemote: remote },
    })

    switch (decision._tag) {
      case 'noop':
        return result(
          withObjectGc({
            result: {
              _tag: 'noop',
              path: opts.path,
              pageId,
              ...(opts.dryRun === true ? { dryRun: true as const } : {}),
            },
            objectGc: yield* maybeGcObjects({
              path: opts.path,
              syncStates: [],
              enabled: opts.gcObjects,
              dryRun: opts.dryRun === true,
            }),
          }),
        )
      case 'push': {
        yield* guardMediaWrite({
          pageId,
          storage: pulled.storage,
          operation: 'push',
        })
        yield* guardCommentWrite({
          pageId,
          storage: pulled.storage,
          operation: 'push',
        })
        yield* assertReviewMarkupAllowed({
          path: opts.path,
          pageId,
          body: rendered,
          allowReviewMarkup: opts.allowReviewMarkup,
        })
        yield* assertUnknownDeletionAllowed({
          path: opts.path,
          pageId,
          unknownBlockIds: unresolvedUnknownBlockIds({
            remoteUnknownBlockIds: pulled.markdown.unknown_block_ids,
          }),
          allowDeletingUnknownBlocks: opts.allowDeletingUnknownBlocks,
        })
        if (opts.dryRun === true) {
          return result(
            withObjectGc({
              result: { _tag: 'pushed', path: opts.path, pageId, dryRun: true },
              objectGc: yield* maybeGcObjects({
                path: opts.path,
                syncStates: [],
                enabled: opts.gcObjects,
                dryRun: true,
              }),
            }),
          )
        }
        yield* gateway.updateMarkdown({
          pageId,
          command: { _tag: 'replace_content', markdown: canonicalizeBlockMarkdown(rendered) },
          allowDeletingContent: opts.allowDeletingUnknownBlocks === true,
        })
        return result(
          withObjectGc({
            result: { _tag: 'pushed', path: opts.path, pageId },
            objectGc: yield* maybeGcObjects({
              path: opts.path,
              syncStates: [],
              enabled: opts.gcObjects,
              dryRun: false,
            }),
          }),
        )
      }
      case 'pull': {
        yield* guardMediaWrite({
          pageId,
          storage: pulled.storage,
          operation: 'pull',
        })
        yield* guardCommentWrite({
          pageId,
          storage: pulled.storage,
          operation: 'pull',
        })
        if (opts.dryRun === true) {
          return result(
            withObjectGc({
              result: { _tag: 'pulled', path: opts.path, pageId, dryRun: true },
              objectGc: yield* maybeGcObjects({
                path: opts.path,
                syncStates: [],
                enabled: opts.gcObjects,
                dryRun: true,
              }),
            }),
          )
        }
        yield* writeFile({
          path: opts.path,
          frontmatter: remoteFrontmatter({
            source: local.frontmatter.notion_md.source,
            page: pulled.page,
          }),
          body: remote,
        })
        return result(
          withObjectGc({
            result: { _tag: 'pulled', path: opts.path, pageId },
            objectGc: yield* maybeGcObjects({
              path: opts.path,
              syncStates: [],
              enabled: opts.gcObjects,
              dryRun: false,
            }),
          }),
        )
      }
      case 'refuse':
        return yield* new NmdConflictError({
          path: opts.path,
          page_id: pageId,
          local_changed: false,
          remote_changed: true,
          message: decision.reason,
        })
      // `create`/`shared-defer` are handled above; unreachable here.
      case 'create':
      case 'shared-defer':
        return result({
          _tag: 'noop',
          path: opts.path,
          pageId,
          ...(opts.dryRun === true ? { dryRun: true } : {}),
        })
    }
  }).pipe(
    withOperation({ operation: ReconcileFileSpan, attributes: { label: basename(opts.path) } }),
  )

/** Apply the `source: shared` 3-way outcome (the only base/merge path). */
const reconcileSharedFile = (opts: {
  readonly path: string
  readonly pageId: string
  readonly syncState: NmdSyncStateV1
  readonly frontmatter: NmdFrontmatterV2
  readonly rendered: string
  readonly remote: string
  readonly remoteUnknownBlockIds: readonly string[]
  readonly page: RemotePageSnapshot
  readonly force: boolean
  readonly dryRun: boolean
  readonly allowDeletingUnknownBlocks: boolean
  readonly allowReviewMarkup: boolean
  readonly gcObjects: boolean
}): Effect.Effect<ReconcileResult, NmdError, NotionMdGateway | NmdStateStore> =>
  Effect.gen(function* () {
    const gateway = yield* NotionMdGateway
    const base = yield* readBaseSnapshot({ path: opts.path, syncState: opts.syncState })
    yield* guardMediaWrite({
      pageId: opts.pageId,
      storage: opts.syncState.storage,
      operation: 'shared',
    })
    const unknownBlockIds = unresolvedUnknownBlockIds({
      syncState: opts.syncState,
      remoteUnknownBlockIds: opts.remoteUnknownBlockIds,
    })

    // --force overrides a shared divergence with a local-wins replace.
    if (opts.force === true) {
      yield* guardCommentWrite({
        pageId: opts.pageId,
        storage: opts.syncState.storage,
        operation: 'shared',
      })
      yield* assertReviewMarkupAllowed({
        path: opts.path,
        pageId: opts.pageId,
        body: opts.rendered,
        allowReviewMarkup: opts.allowReviewMarkup,
      })
      yield* assertUnknownDeletionAllowed({
        path: opts.path,
        pageId: opts.pageId,
        unknownBlockIds,
        allowDeletingUnknownBlocks: opts.allowDeletingUnknownBlocks,
      })
      if (opts.dryRun === true) {
        return result(
          withObjectGc({
            result: {
              _tag: 'shared-merged',
              path: opts.path,
              pageId: opts.pageId,
              dryRun: true,
            },
            objectGc: yield* maybeGcObjects({
              path: opts.path,
              syncStates: [opts.syncState],
              enabled: opts.gcObjects,
              dryRun: true,
            }),
          }),
        )
      }
      yield* gateway.updateMarkdown({
        pageId: opts.pageId,
        command: { _tag: 'replace_content', markdown: canonicalizeBlockMarkdown(opts.rendered) },
        allowDeletingContent: opts.allowDeletingUnknownBlocks,
      })
      const syncState = yield* settleSharedBase({
        path: opts.path,
        pageId: opts.pageId,
        syncState: opts.syncState,
        body: opts.rendered,
      })
      return result(
        withObjectGc({
          result: { _tag: 'shared-merged', path: opts.path, pageId: opts.pageId },
          objectGc: yield* maybeGcObjects({
            path: opts.path,
            syncStates: [syncState],
            enabled: opts.gcObjects,
            dryRun: false,
          }),
        }),
      )
    }

    const outcome = decideShared({
      baseBody: base.body,
      localBody: opts.rendered,
      remoteBody: opts.remote,
    })

    switch (outcome._tag) {
      case 'noop':
        return result(
          withObjectGc({
            result: {
              _tag: 'noop',
              path: opts.path,
              pageId: opts.pageId,
              ...(opts.dryRun === true ? { dryRun: true as const } : {}),
            },
            objectGc: yield* maybeGcObjects({
              path: opts.path,
              syncStates: [opts.syncState],
              enabled: opts.gcObjects,
              dryRun: opts.dryRun,
            }),
          }),
        )
      case 'merge': {
        yield* guardCommentWrite({
          pageId: opts.pageId,
          storage: opts.syncState.storage,
          operation: 'shared',
        })
        yield* assertReviewMarkupAllowed({
          path: opts.path,
          pageId: opts.pageId,
          body: outcome.merged,
          allowReviewMarkup: opts.allowReviewMarkup,
        })
        yield* assertUnknownDeletionAllowed({
          path: opts.path,
          pageId: opts.pageId,
          unknownBlockIds,
          allowDeletingUnknownBlocks: opts.allowDeletingUnknownBlocks,
        })
        if (opts.dryRun === true) {
          return result(
            withObjectGc({
              result: {
                _tag: 'shared-merged',
                path: opts.path,
                pageId: opts.pageId,
                dryRun: true,
              },
              objectGc: yield* maybeGcObjects({
                path: opts.path,
                syncStates: [opts.syncState],
                enabled: opts.gcObjects,
                dryRun: true,
              }),
            }),
          )
        }
        yield* gateway.updateMarkdown({
          pageId: opts.pageId,
          command: { _tag: 'replace_content', markdown: canonicalizeBlockMarkdown(outcome.merged) },
          allowDeletingContent: opts.allowDeletingUnknownBlocks,
        })
        yield* writeFile({ path: opts.path, frontmatter: opts.frontmatter, body: outcome.merged })
        const syncState = yield* settleSharedBase({
          path: opts.path,
          pageId: opts.pageId,
          syncState: opts.syncState,
          body: outcome.merged,
        })
        return result(
          withObjectGc({
            result: { _tag: 'shared-merged', path: opts.path, pageId: opts.pageId },
            objectGc: yield* maybeGcObjects({
              path: opts.path,
              syncStates: [syncState],
              enabled: opts.gcObjects,
              dryRun: false,
            }),
          }),
        )
      }
      case 'conflict': {
        if (opts.dryRun === true) {
          return result(
            withObjectGc({
              result: {
                _tag: 'shared-conflict',
                path: opts.path,
                pageId: opts.pageId,
                conflictPath: conflictPathFor(opts.path),
                dryRun: true,
              },
              objectGc: yield* maybeGcObjects({
                path: opts.path,
                syncStates: [opts.syncState],
                enabled: opts.gcObjects,
                dryRun: true,
              }),
            }),
          )
        }
        const conflictPath = yield* writeSharedConflict({
          path: opts.path,
          pageId: opts.pageId,
          outcome,
        })
        return result(
          withObjectGc({
            result: {
              _tag: 'shared-conflict',
              path: opts.path,
              pageId: opts.pageId,
              conflictPath,
            },
            objectGc: yield* maybeGcObjects({
              path: opts.path,
              syncStates: [opts.syncState],
              enabled: opts.gcObjects,
              dryRun: false,
            }),
          }),
        )
      }
    }
  })

/**
 * Re-settle a fresh base snapshot after a clean `shared` apply and repoint the
 * sidecar `body.base` ref/hash at it, so the next reconcile 3-way-merges
 * against the newly-converged body — not the stale base.
 */
const settleSharedBase = (opts: {
  readonly path: string
  readonly pageId: string
  readonly syncState: NmdSyncStateV1
  readonly body: string
}) =>
  Effect.gen(function* () {
    const store = yield* NmdStateStore
    const body = normalizeMarkdownLineEndings(opts.body)
    const base = yield* store.writeBaseSnapshot({ path: opts.path, pageId: opts.pageId, body })
    const syncState: NmdSyncStateV1 = {
      ...opts.syncState,
      body: {
        ...opts.syncState.body,
        hash: sha256Digest(body),
        base,
        last_pulled_at: new Date().toISOString(),
      },
    }
    yield* store.writeSyncState({
      path: opts.path,
      syncState,
    })
    return syncState
  })

/** Result of tracking an existing Notion page as a local file. */
export interface TrackResult {
  readonly path: string
  readonly pageId: string
  readonly source: NmdFrontmatterV2['notion_md']['source']
  readonly dryRun?: true
}

/**
 * `track <id|url> [path]` — bootstrap a local `.nmd` file from an existing
 * Notion page (spec). The ONLY operation that takes a page id. Writes
 * self-describing frontmatter with the chosen `source` (default `remote` — you
 * tracked existing Notion state). Fail-closed on a lossy/truncated remote observation: no
 * clean base from a lossy body. For `--as shared` it also establishes the base
 * sidecar so the file is a valid `shared-bound` from the first sync.
 */
export const trackPage = (opts: {
  readonly pageId: string
  readonly outPath: string
  readonly source: NmdFrontmatterV2['notion_md']['source']
  readonly dryRun?: boolean
  /**
   * Writable frontmatter properties to embed in the materialized `.nmd`
   * (visible-name → value). Absent keeps the current empty-`properties` behavior;
   * standalone notion-md never passes this. See `remoteFrontmatter`.
   */
  readonly properties?: Readonly<Record<string, NmdWritablePropertyValue>>
}): Effect.Effect<TrackResult, NmdError, FileSystem.FileSystem | NotionMdGateway | NmdStateStore> =>
  Effect.gen(function* () {
    const gateway = yield* NotionMdGateway
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(opts.outPath).pipe(Effect.orElseSucceed(() => false))
    if (exists === true) {
      // refuse to overwrite a file already bound to a different page
      const store = yield* NmdStateStore
      const existing = yield* store.readNmdFile({ path: opts.outPath }).pipe(Effect.result)
      if (existing._tag === 'Success') {
        const parsed = yield* parseNmdFile({ path: opts.outPath, content: existing.success })
        const boundId = parsed.frontmatter.notion_md.page_id
        if (boundId !== null && boundId !== opts.pageId) {
          return yield* new NmdFrontmatterError({
            path: opts.outPath,
            message: `${opts.outPath} is already bound to a different page (${boundId}); refusing to overwrite with ${opts.pageId}`,
          })
        }
      }
    }

    const pulled = yield* gateway.pullPage({ pageId: opts.pageId })
    const completeness = pulled.markdown.completeness
    if (completeness !== undefined && completeness._tag !== 'complete') {
      return yield* new NmdFrontmatterError({
        path: opts.outPath,
        message: `Refusing to track a lossy remote body for ${opts.pageId} (${completeness.reasons.join(', ')}); no clean base from a truncated observation`,
      })
    }
    const body = normalizeMarkdownLineEndings(pulled.markdown.markdown)
    if (opts.dryRun === true) {
      return { path: opts.outPath, pageId: opts.pageId, source: opts.source, dryRun: true as const }
    }
    yield* writeFile({
      path: opts.outPath,
      frontmatter: remoteFrontmatter({
        source: opts.source,
        page: pulled.page,
        ...(opts.properties === undefined ? {} : { properties: opts.properties }),
      }),
      body,
    })

    if (opts.source === 'shared') {
      const store = yield* NmdStateStore
      const base = yield* store.writeBaseSnapshot({
        path: opts.outPath,
        pageId: opts.pageId,
        body,
      })
      yield* store.writeSyncState({
        path: opts.outPath,
        syncState: {
          version: 1,
          page_id: opts.pageId,
          body: {
            format: 'notion-enhanced-markdown',
            hash: sha256Digest(body),
            base,
            last_pulled_at: new Date().toISOString(),
            remote_last_edited_time: pulled.page.last_edited_time,
            truncated: pulled.markdown.truncated,
            unknown_block_ids: [...pulled.markdown.unknown_block_ids],
          },
          storage: pulled.storage ?? emptyStorage(),
          read_only_properties: {},
          data_source: null,
        },
      })
    }

    return { path: opts.outPath, pageId: opts.pageId, source: opts.source }
  }).pipe(
    withOperation({
      operation: TrackPageSpan,
      attributes: { label: opts.pageId.slice(0, 8), source: opts.source },
    }),
  )

/*
 * Tree orchestration (spec "Internal layering"): discover `.nmd` files,
 * duplicate-`page_id` preflight (reject before any mutation), bounded
 * concurrency, per-file result aggregation. Direction-agnostic — it maps the
 * source-aware per-page core over each file via `runBatch`.
 */

/** Read-only status over a file or a recursive directory of `.nmd` files. */
export const statusTree = (opts: {
  readonly targets: readonly string[]
  readonly recursive?: boolean
  readonly concurrency?: number
}): Effect.Effect<
  BatchResult<ReconcileStatus>,
  NmdCliError,
  FileSystem.FileSystem | Path.Path | NotionMdGateway | NmdStateStore
> =>
  runBatch({
    operation: 'status',
    targets: opts.targets,
    ...(opts.recursive === undefined ? {} : { recursive: opts.recursive }),
    ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
    run: (path) => statusFile({ path }),
  })

/** Reconcile a file or a recursive directory of `.nmd` files toward in-sync. */
export const reconcileTree = (opts: {
  readonly targets: readonly string[]
  readonly recursive?: boolean
  readonly concurrency?: number
  readonly force?: boolean
  readonly dryRun?: boolean
  readonly allowDeletingUnknownBlocks?: boolean
  readonly allowReviewMarkup?: boolean
  readonly gcObjects?: boolean
}): Effect.Effect<
  BatchResult<ReconcileResult>,
  NmdCliError,
  FileSystem.FileSystem | Path.Path | NotionMdGateway | NmdStateStore
> =>
  runBatch({
    operation: 'sync',
    targets: opts.targets,
    ...(opts.recursive === undefined ? {} : { recursive: opts.recursive }),
    ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
    run: (path) =>
      reconcileFile({
        path,
        ...(opts.force === undefined ? {} : { force: opts.force }),
        ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
        ...(opts.allowDeletingUnknownBlocks === undefined
          ? {}
          : { allowDeletingUnknownBlocks: opts.allowDeletingUnknownBlocks }),
        ...(opts.allowReviewMarkup === undefined
          ? {}
          : { allowReviewMarkup: opts.allowReviewMarkup }),
        ...(opts.gcObjects === undefined ? {} : { gcObjects: opts.gcObjects }),
      }),
  })
