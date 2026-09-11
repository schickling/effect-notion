import { lstatSync } from 'node:fs'
import * as nodePath from 'node:path'

import { Effect, FileSystem, Option, Schema } from 'effect'

import { SessionSourceDiscoveryError } from '../errors.ts'
import type { SessionSourceAdapter } from '../schema/core.ts'
import { ArtifactDescriptor, SourceId } from '../schema/core.ts'
import { makeAppendOnlyJsonlAdapter } from './jsonl.ts'

const TextPart = Schema.Struct({
  type: Schema.Literals(['input_text', 'output_text']),
  text: Schema.String,
})

const InputImagePart = Schema.Struct({
  type: Schema.Literal('input_image'),
  image_url: Schema.optional(Schema.Unknown),
  file_id: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
})

const MessageResponsePayload = Schema.Struct({
  type: Schema.Literal('message'),
  role: Schema.Literals(['assistant', 'developer', 'system', 'user']),
  content: Schema.Array(Schema.Union([TextPart, InputImagePart])),
})

const ReasoningSummaryPart = Schema.Struct({
  type: Schema.String,
  text: Schema.String,
})

const ReasoningPayload = Schema.Struct({
  type: Schema.Literal('reasoning'),
  summary: Schema.Array(ReasoningSummaryPart),
  content: Schema.NullOr(Schema.Unknown),
  encrypted_content: Schema.optional(Schema.String),
})

const CustomToolCallPayload = Schema.Struct({
  type: Schema.Literal('custom_tool_call'),
  call_id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
  arguments: Schema.optional(Schema.String),
})

const CustomToolCallOutputPayload = Schema.Struct({
  type: Schema.Literal('custom_tool_call_output'),
  call_id: Schema.optional(Schema.String),
  output: Schema.optional(Schema.Unknown),
})

const GhostSnapshotPayload = Schema.Struct({
  type: Schema.Literal('ghost_snapshot'),
})

const WebSearchCallPayload = Schema.Struct({
  type: Schema.Literal('web_search_call'),
})

const FunctionCallPayload = Schema.Struct({
  type: Schema.Literal('function_call'),
  name: Schema.String,
  arguments: Schema.String,
  call_id: Schema.String,
})

const FunctionCallOutputPayload = Schema.Struct({
  type: Schema.Literal('function_call_output'),
  call_id: Schema.String,
  output: Schema.String,
})

const SessionMetaPayload = Schema.Struct({
  id: Schema.String,
  timestamp: Schema.String,
  cwd: Schema.String,
  originator: Schema.optional(Schema.String),
  cli_version: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
})

const LegacySessionMetaRecord = Schema.Struct({
  id: Schema.String,
  timestamp: Schema.DateTimeUtcFromString,
  instructions: Schema.optional(Schema.NullOr(Schema.String)),
  git: Schema.optional(Schema.Unknown),
})

const LegacyStateRecord = Schema.Struct({
  record_type: Schema.String,
})

const LegacyTopLevelRecord = Schema.Struct({
  type: Schema.String,
  timestamp: Schema.optional(Schema.DateTimeUtcFromString),
  id: Schema.optional(Schema.NullOr(Schema.String)),
  role: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Unknown),
  payload: Schema.optional(Schema.Unknown),
})

const TokenCountInfo = Schema.Struct({
  total_token_usage: Schema.optional(Schema.Unknown),
  last_token_usage: Schema.optional(Schema.Unknown),
  model_context_window: Schema.optional(Schema.Finite),
})

/**
 * Source-of-truth record union for Codex rollout/session JSONL artifacts.
 *
 * References:
 * - Native transcript store: `~/.codex-<profile>/sessions/(nested path).jsonl`
 * - Discovery index: `state_5.sqlite` / `threads.rollout_path`
 */
export const CodexSessionRecord = Schema.Union([
  Schema.Struct({
    timestamp: Schema.DateTimeUtcFromString,
    type: Schema.Literal('session_meta'),
    payload: SessionMetaPayload,
  }),
  Schema.Struct({
    timestamp: Schema.DateTimeUtcFromString,
    type: Schema.Literal('response_item'),
    payload: Schema.Union([
      MessageResponsePayload,
      FunctionCallPayload,
      FunctionCallOutputPayload,
      ReasoningPayload,
      CustomToolCallPayload,
      CustomToolCallOutputPayload,
      GhostSnapshotPayload,
      WebSearchCallPayload,
    ]),
  }),
  Schema.Struct({
    timestamp: Schema.DateTimeUtcFromString,
    type: Schema.Literal('event_msg'),
    payload: Schema.Struct({
      type: Schema.String,
      info: Schema.optional(TokenCountInfo),
      rate_limits: Schema.optional(Schema.Unknown),
    }),
  }),
  Schema.Struct({
    timestamp: Schema.DateTimeUtcFromString,
    type: Schema.Literal('turn_context'),
    payload: Schema.Struct({
      cwd: Schema.String,
      approval_policy: Schema.optional(Schema.String),
      sandbox_policy: Schema.optional(Schema.Unknown),
      model: Schema.optional(Schema.String),
      effort: Schema.optional(Schema.String),
      summary: Schema.optional(Schema.String),
    }),
  }),
  LegacySessionMetaRecord,
  LegacyStateRecord,
  LegacyTopLevelRecord,
]).annotate({ identifier: 'AgentSessionIngest.CodexSessionRecord' })
export type CodexSessionRecord = typeof CodexSessionRecord.Type

/**
 * Source-of-truth entry from the Codex session discovery index.
 *
 * References:
 * - SQLite table: `threads`
 * - Column used for transcript lookup: `rollout_path`
 */
export const CodexSessionIndexEntry = Schema.Struct({
  id: Schema.String,
  thread_name: Schema.String,
  updated_at: Schema.String,
}).annotate({ identifier: 'AgentSessionIngest.CodexSessionIndexEntry' })
export type CodexSessionIndexEntry = typeof CodexSessionIndexEntry.Type

const listJsonlFiles = Effect.fn('AgentSessionIngest.Codex.listJsonlFiles')(
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

const toCodexArtifactId = (options: { readonly sessionsRoot: string; readonly path: string }) =>
  nodePath
    .relative(options.sessionsRoot, options.path)
    .replaceAll(nodePath.sep, '/')
    .replace(/\.jsonl$/u, '')

/**
 * Adapter for incremental ingestion of Codex rollout JSONL transcripts.
 *
 * References:
 * - Transcript artifact: `~/.codex-<profile>/sessions/(nested path).jsonl`
 * - Optional discovery helper: `~/.codex-<profile>/state_5.sqlite`
 */
export const makeCodexAdapter = (options: {
  readonly sessionsRoot: string
  readonly sourceId?: string
  readonly discoverySinceEpochMs?: number
  readonly initialReadMaxBytes?: number
}): SessionSourceAdapter<CodexSessionRecord> =>
  makeAppendOnlyJsonlAdapter({
    sourceId: Schema.decodeSync(SourceId)(options.sourceId ?? 'codex'),
    discoverArtifacts: listJsonlFiles({
      root: options.sessionsRoot,
      ...(options.discoverySinceEpochMs !== undefined && {
        discoverySinceEpochMs: options.discoverySinceEpochMs,
      }),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SessionSourceDiscoveryError({
            message: 'Failed to discover Codex sessions',
            sourceId: options.sourceId ?? 'codex',
            cause,
          }),
      ),
      Effect.map((paths) =>
        paths.map((path: string) => ({
          artifact: Schema.decodeSync(ArtifactDescriptor)({
            sourceId: options.sourceId ?? 'codex',
            artifactId: toCodexArtifactId({ sessionsRoot: options.sessionsRoot, path }),
            path,
            status: 'stable',
          }),
          ...(options.initialReadMaxBytes !== undefined && {
            initialReadMaxBytes: options.initialReadMaxBytes,
          }),
        })),
      ),
    ),
    recordSchema: CodexSessionRecord,
    decodeErrorMessage: 'Failed to decode Codex session record',
    checkpointErrorMessage: 'Failed to decode Codex ingestion checkpoint',
  })
