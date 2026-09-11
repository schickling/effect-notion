import type { FileSystem } from 'effect'
import { Effect, Schema } from 'effect'

import type { SessionSourceDiscoveryError } from '../errors.ts'
import { SessionArtifactDecodeError, SessionCheckpointDecodeError } from '../errors.ts'
import { readAppendOnlyTextFileSince, splitCompleteJsonlRecords } from '../files/append-only.ts'
import type {
  ArtifactDescriptor,
  IngestionCheckpoint,
  SessionSourceAdapter,
  SourceId,
} from '../schema/core.ts'
import { IngestionCheckpoint as IngestionCheckpointSchema } from '../schema/core.ts'

/** Discovered JSONL transcript artifact plus optional read tuning hints. */
export interface JsonlArtifactDiscovery {
  readonly artifact: ArtifactDescriptor
  readonly initialReadMaxBytes?: number
}

/** Configuration for a shared append-only JSONL session adapter. */
export interface JsonlAdapterOptions<A, I> {
  readonly sourceId: SourceId
  readonly discoverArtifacts: Effect.Effect<
    ReadonlyArray<JsonlArtifactDiscovery>,
    SessionSourceDiscoveryError,
    FileSystem.FileSystem
  >
  readonly recordSchema: Schema.Codec<A, I>
  readonly decodeErrorMessage: string
  readonly checkpointErrorMessage: string
}

/** Shared adapter constructor for append-only JSONL transcript sources. */
export const makeAppendOnlyJsonlAdapter = <A, I>(
  options: JsonlAdapterOptions<A, I>,
): SessionSourceAdapter<A> => {
  let cachedDiscovery: ReadonlyArray<JsonlArtifactDiscovery> | undefined

  const discoverWithCache = options.discoverArtifacts.pipe(
    Effect.tap((artifacts) => Effect.sync(() => (cachedDiscovery = artifacts))),
  )

  return {
    sourceId: options.sourceId,
    discoverArtifacts: discoverWithCache.pipe(
      Effect.map((artifacts) => artifacts.map((entry) => entry.artifact)),
    ),
    ingestArtifact: ({ artifact, checkpoint }) =>
      Effect.gen(function* () {
        const discovered = cachedDiscovery?.find(
          (entry) =>
            entry.artifact.sourceId === artifact.sourceId &&
            entry.artifact.artifactId === artifact.artifactId &&
            entry.artifact.path === artifact.path,
        )

        const read = yield* readAppendOnlyTextFileSince({
          path: artifact.path,
          offsetBytes:
            checkpoint?.cursor._tag === 'AppendOnlyCursor' ? checkpoint.cursor.offsetBytes : 0,
          ...(checkpoint?.cursor._tag === 'AppendOnlyCursor' && {
            previousContentVersion: checkpoint.cursor.contentVersion,
          }),
          ...(discovered?.initialReadMaxBytes !== undefined && {
            initialReadMaxBytes: discovered.initialReadMaxBytes,
          }),
        })

        const records = yield* Effect.forEach(splitCompleteJsonlRecords(read.text), (line) =>
          Schema.decodeEffect(Schema.fromJsonString(options.recordSchema))(line).pipe(
            Effect.mapError(
              (cause) =>
                new SessionArtifactDecodeError({
                  message: options.decodeErrorMessage,
                  sourceId: artifact.sourceId,
                  artifactId: artifact.artifactId,
                  rawRecord: line,
                  cause,
                }),
            ),
          ),
        )

        return {
          artifact,
          records,
          checkpoint: yield* Schema.decodeEffect(IngestionCheckpointSchema)({
            sourceId: artifact.sourceId,
            artifactId: artifact.artifactId,
            path: artifact.path,
            status: artifact.status,
            cursor: {
              _tag: 'AppendOnlyCursor',
              offsetBytes: read.nextOffsetBytes,
              contentVersion: read.contentVersion,
            },
            updatedAtEpochMs: Date.now(),
          }).pipe(
            Effect.mapError(
              (cause) =>
                new SessionCheckpointDecodeError({
                  message: options.checkpointErrorMessage,
                  path: artifact.path,
                  cause,
                }),
            ),
          ),
        } satisfies {
          readonly artifact: ArtifactDescriptor
          readonly records: ReadonlyArray<A>
          readonly checkpoint: IngestionCheckpoint
        }
      }),
  }
}
