import { lstatSync } from 'node:fs'
import * as nodePath from 'node:path'

import { Effect, FileSystem, Option, Schema } from 'effect'

import { SessionSourceDiscoveryError } from '../errors.ts'
import type { SessionSourceAdapter } from '../schema/core.ts'
import { ArtifactDescriptor, SourceId } from '../schema/core.ts'
import { makeAppendOnlyJsonlAdapter } from './jsonl.ts'

const QueueOperationRecord = Schema.Struct({
  type: Schema.Literal('queue-operation'),
  operation: Schema.Literals(['enqueue', 'dequeue']),
  timestamp: Schema.DateTimeUtcFromString,
  sessionId: Schema.String,
  content: Schema.optional(Schema.String),
}).annotate({ identifier: 'AgentSessionIngest.ClaudeQueueOperationRecord' })

const HookProgressData = Schema.Struct({
  type: Schema.String,
  hookEvent: Schema.optional(Schema.String),
  hookName: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
}).annotate({ identifier: 'AgentSessionIngest.ClaudeHookProgressData' })

const ProgressRecord = Schema.Struct({
  type: Schema.Literal('progress'),
  parentUuid: Schema.NullOr(Schema.String),
  isSidechain: Schema.Boolean,
  userType: Schema.String,
  cwd: Schema.String,
  sessionId: Schema.String,
  version: Schema.String,
  gitBranch: Schema.optional(Schema.String),
  agentId: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  parentToolUseID: Schema.optional(Schema.String),
  toolUseID: Schema.optional(Schema.String),
  uuid: Schema.String,
  timestamp: Schema.DateTimeUtcFromString,
  data: HookProgressData,
}).annotate({ identifier: 'AgentSessionIngest.ClaudeProgressRecord' })

const ClaudeTextBlock = Schema.Struct({
  type: Schema.Literal('text'),
  text: Schema.String,
})

const ClaudeThinkingBlock = Schema.Struct({
  type: Schema.Literal('thinking'),
  thinking: Schema.String,
})

const ClaudeToolUseBlock = Schema.Struct({
  type: Schema.Literal('tool_use'),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
})

const ClaudeToolResultBlock = Schema.Struct({
  type: Schema.Literal('tool_result'),
  tool_use_id: Schema.String,
  content: Schema.Unknown,
  is_error: Schema.optional(Schema.Boolean),
})

const ClaudeServerToolUseBlock = Schema.Struct({
  type: Schema.Literal('server_tool_use'),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
})

const ClaudeServerToolResultBlock = Schema.Struct({
  type: Schema.Literal('server_tool_result'),
  tool_use_id: Schema.String,
  content: Schema.Unknown,
})

const ClaudeGenericContentBlock = Schema.Struct({
  type: Schema.String,
})

/** Content block types in Claude assistant message responses. */
export const ClaudeAssistantContentBlock = Schema.Union([
  ClaudeTextBlock,
  ClaudeThinkingBlock,
  ClaudeToolUseBlock,
  ClaudeToolResultBlock,
  ClaudeServerToolUseBlock,
  ClaudeServerToolResultBlock,
  ClaudeGenericContentBlock,
]).annotate({ identifier: 'AgentSessionIngest.ClaudeAssistantContentBlock' })
export type ClaudeAssistantContentBlock = typeof ClaudeAssistantContentBlock.Type

/** Content block types in Claude user messages (tool results and text). */
export const ClaudeUserContentBlock = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('tool_result'),
    tool_use_id: Schema.String,
    content: Schema.Unknown,
    is_error: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal('text'),
    text: Schema.String,
  }),
  ClaudeGenericContentBlock,
]).annotate({ identifier: 'AgentSessionIngest.ClaudeUserContentBlock' })

const MessageEnvelope = Schema.Struct({
  role: Schema.String,
  content: Schema.Unknown,
}).annotate({ identifier: 'AgentSessionIngest.ClaudeMessageEnvelope' })

const UserRecord = Schema.Struct({
  type: Schema.Literal('user'),
  parentUuid: Schema.NullOr(Schema.String),
  isSidechain: Schema.Boolean,
  userType: Schema.String,
  cwd: Schema.String,
  sessionId: Schema.String,
  version: Schema.String,
  gitBranch: Schema.optional(Schema.String),
  agentId: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  uuid: Schema.String,
  timestamp: Schema.DateTimeUtcFromString,
  permissionMode: Schema.optional(Schema.String),
  sourceToolAssistantUUID: Schema.optional(Schema.String),
  toolUseResult: Schema.optional(Schema.Unknown),
  message: MessageEnvelope,
}).annotate({ identifier: 'AgentSessionIngest.ClaudeUserRecord' })

const AssistantMessagePayload = Schema.Struct({
  model: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  role: Schema.Literal('assistant'),
  content: Schema.Array(ClaudeAssistantContentBlock),
  stop_reason: Schema.optional(Schema.NullOr(Schema.String)),
  stop_sequence: Schema.optional(Schema.NullOr(Schema.String)),
  usage: Schema.optional(Schema.Unknown),
}).annotate({ identifier: 'AgentSessionIngest.ClaudeAssistantMessagePayload' })

const AssistantRecord = Schema.Struct({
  type: Schema.Literal('assistant'),
  parentUuid: Schema.NullOr(Schema.String),
  isSidechain: Schema.Boolean,
  userType: Schema.String,
  cwd: Schema.String,
  sessionId: Schema.String,
  version: Schema.String,
  gitBranch: Schema.optional(Schema.String),
  agentId: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.String),
  uuid: Schema.String,
  timestamp: Schema.DateTimeUtcFromString,
  message: AssistantMessagePayload,
}).annotate({ identifier: 'AgentSessionIngest.ClaudeAssistantRecord' })

const SystemRecord = Schema.Struct({
  type: Schema.Literal('system'),
  parentUuid: Schema.NullOr(Schema.String),
  isSidechain: Schema.Boolean,
  userType: Schema.optional(Schema.String),
  cwd: Schema.String,
  sessionId: Schema.String,
  version: Schema.String,
  uuid: Schema.String,
  timestamp: Schema.DateTimeUtcFromString,
  content: Schema.Unknown,
}).annotate({ identifier: 'AgentSessionIngest.ClaudeSystemRecord' })

const GenericClaudeRecord = Schema.Struct({
  type: Schema.String,
  sessionId: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.DateTimeUtcFromString),
}).annotate({ identifier: 'AgentSessionIngest.ClaudeGenericRecord' })

/**
 * Source-of-truth record union for Claude project/subagent transcript JSONL artifacts.
 *
 * References:
 * - Native transcript store: `~/.claude/projects/(nested path).jsonl`
 * - Common shared-store target: `~/.claude-shared/projects/(nested path).jsonl`
 */
export const ClaudeSessionRecord = Schema.Union([
  QueueOperationRecord,
  ProgressRecord,
  UserRecord,
  AssistantRecord,
  SystemRecord,
  GenericClaudeRecord,
]).annotate({ identifier: 'AgentSessionIngest.ClaudeSessionRecord' })
export type ClaudeSessionRecord = typeof ClaudeSessionRecord.Type

const listClaudeJsonlFiles = Effect.fn('AgentSessionIngest.Claude.listClaudeJsonlFiles')(
  (options: { root: string; discoverySinceEpochMs?: number }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const exists = yield* fs.exists(options.root)
      if (exists !== true) return [] as Array<string>

      const directories = [options.root]
      const files: Array<string> = []

      while (directories.length > 0) {
        const currentDir = directories.pop()
        if (currentDir === undefined) continue

        const entries = yield* fs.readDirectory(currentDir)
        for (const entry of entries) {
          const path = nodePath.join(currentDir, entry)
          if (lstatSync(path).isSymbolicLink() === true) continue
          const info = yield* fs.stat(path)
          if (info.type === 'Directory') {
            directories.push(path)
            continue
          }

          const modifiedAtEpochMs = Option.getOrUndefined(info.mtime)?.getTime()
          const isRecentEnough =
            options.discoverySinceEpochMs === undefined ||
            modifiedAtEpochMs === undefined ||
            modifiedAtEpochMs >= options.discoverySinceEpochMs

          if (
            info.type === 'File' &&
            entry.endsWith('.jsonl') === true &&
            isRecentEnough === true
          ) {
            files.push(path)
          }
        }
      }

      return files.toSorted()
    }),
)

const toClaudeArtifactId = (options: { readonly projectsRoot: string; readonly path: string }) =>
  nodePath.relative(options.projectsRoot, options.path).replaceAll(nodePath.sep, '/')

/**
 * Adapter for incremental ingestion of Claude project transcript JSONL artifacts.
 *
 * References:
 * - Canonical transcript root: `~/.claude/projects`
 * - Shared transcript root: `~/.claude-shared/projects`
 */
export const makeClaudeAdapter = (options: {
  readonly projectsRoot: string
  readonly sourceId?: string
  readonly discoverySinceEpochMs?: number
  readonly initialReadMaxBytes?: number
}): SessionSourceAdapter<ClaudeSessionRecord> =>
  makeAppendOnlyJsonlAdapter({
    sourceId: Schema.decodeSync(SourceId)(options.sourceId ?? 'claude'),
    discoverArtifacts: listClaudeJsonlFiles({
      root: options.projectsRoot,
      ...(options.discoverySinceEpochMs !== undefined && {
        discoverySinceEpochMs: options.discoverySinceEpochMs,
      }),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SessionSourceDiscoveryError({
            message: 'Failed to discover Claude project transcripts',
            sourceId: options.sourceId ?? 'claude',
            cause,
          }),
      ),
      Effect.map((paths) =>
        paths.map((path) => ({
          artifact: Schema.decodeSync(ArtifactDescriptor)({
            sourceId: options.sourceId ?? 'claude',
            artifactId: toClaudeArtifactId({ projectsRoot: options.projectsRoot, path }),
            path,
            status:
              path.includes(`${nodePath.sep}subagents${nodePath.sep}`) === true ? 'open' : 'stable',
          }),
          ...(options.initialReadMaxBytes !== undefined && {
            initialReadMaxBytes: options.initialReadMaxBytes,
          }),
        })),
      ),
    ),
    recordSchema: ClaudeSessionRecord,
    decodeErrorMessage: 'Failed to decode Claude session record',
    checkpointErrorMessage: 'Failed to decode Claude ingestion checkpoint',
  })
