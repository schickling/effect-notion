import * as nodePath from 'node:path'

import { Context, Effect, FileSystem, Layer, Schema } from 'effect'

import { SessionCheckpointDecodeError, SessionCheckpointWriteError } from '../errors.ts'
import type { ArtifactDescriptor, IngestionCheckpoint } from '../schema/core.ts'
import { IngestionCheckpointJsonLine } from '../schema/core.ts'

/** Builds an unambiguous composite key for persisted checkpoints. */
export const buildCheckpointKey = (
  descriptor: Pick<ArtifactDescriptor, 'sourceId' | 'artifactId'>,
) => JSON.stringify([descriptor.sourceId, descriptor.artifactId] as const)

/** Service for loading and saving deduped ingestion checkpoints. */
export class CheckpointStore extends Context.Service<
  CheckpointStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<IngestionCheckpoint>, SessionCheckpointDecodeError>
    readonly saveAll: (
      checkpoints: ReadonlyArray<IngestionCheckpoint>,
    ) => Effect.Effect<void, SessionCheckpointWriteError>
  }
>()('AgentSessionIngest/CheckpointStore') {}

/** File-backed checkpoint store for incremental source ingestion. */
export const makeFileCheckpointStore = (options: { path: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const list = Effect.gen(function* () {
      const exists = yield* fs.exists(options.path)
      if (exists !== true) return [] as Array<IngestionCheckpoint>

      const content = yield* fs.readFileString(options.path).pipe(
        Effect.mapError(
          (cause) =>
            new SessionCheckpointDecodeError({
              message: 'Failed to read checkpoint file',
              path: options.path,
              cause,
            }),
        ),
      )

      const lines = content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)

      const checkpoints: Array<IngestionCheckpoint> = []
      for (const line of lines) {
        const decoded = yield* Schema.decodeEffect(IngestionCheckpointJsonLine)(line).pipe(
          Effect.mapError(
            (cause) =>
              new SessionCheckpointDecodeError({
                message: 'Failed to decode checkpoint entry',
                path: options.path,
                cause,
              }),
          ),
        )
        checkpoints.push(decoded)
      }

      return checkpoints
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof SessionCheckpointDecodeError
          ? cause
          : new SessionCheckpointDecodeError({
              message: 'Failed to load checkpoints',
              path: options.path,
              cause,
            }),
      ),
    )

    return {
      list,
      saveAll: (checkpoints: ReadonlyArray<IngestionCheckpoint>) =>
        Effect.gen(function* () {
          const directory = nodePath.dirname(options.path)
          yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.ignore)

          const deduped = new Map<string, IngestionCheckpoint>()
          for (const checkpoint of checkpoints) {
            deduped.set(buildCheckpointKey(checkpoint), checkpoint)
          }

          const encodedLines = yield* Effect.forEach([...deduped.values()], (checkpoint) =>
            Schema.encodeEffect(IngestionCheckpointJsonLine)(checkpoint).pipe(
              Effect.mapError(
                (cause) =>
                  new SessionCheckpointWriteError({
                    message: 'Failed to encode checkpoint entry',
                    path: options.path,
                    cause,
                  }),
              ),
            ),
          )

          yield* fs.writeFileString(options.path, encodedLines.join('\n')).pipe(
            Effect.mapError(
              (cause) =>
                new SessionCheckpointWriteError({
                  message: 'Failed to write checkpoint file',
                  path: options.path,
                  cause,
                }),
            ),
          )
        }),
    }
  })

/** Layer that provides the file-backed checkpoint store service. */
export const FileCheckpointStore = (options: { path: string }) =>
  Layer.effect(CheckpointStore, makeFileCheckpointStore(options))
