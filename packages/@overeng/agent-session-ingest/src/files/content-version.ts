import { open as openFile } from 'node:fs/promises'

import { Effect, FileSystem, Option, Schema } from 'effect'

import { SessionArtifactReadError } from '../errors.ts'
import type { ContentVersion } from '../schema/core.ts'
import { ContentVersion as ContentVersionSchema } from '../schema/core.ts'

const hashBytes = (buffer: Buffer) => {
  let hash = 2166136261
  for (const value of buffer.values()) {
    hash ^= value
    hash = Math.imul(hash, 16777619)
  }
  return `fnv1a:${(hash >>> 0).toString(16)}`
}

const stableHeadSampleBytes = 512

/** Builds a validated content-version value from precomputed file metadata. */
export const buildContentVersion = (options: {
  readonly sizeBytes: number
  readonly modifiedAtEpochMs: number
  readonly headHash?: string
  readonly tailHash: string
}) =>
  Schema.decodeSync(ContentVersionSchema)({
    sizeBytes: options.sizeBytes,
    modifiedAtEpochMs: options.modifiedAtEpochMs,
    ...(options.headHash !== undefined && { headHash: options.headHash }),
    tailHash: options.tailHash,
  })

/** Builds a stable content version from an in-memory text snapshot. */
export const buildContentVersionFromText = (options: {
  readonly content: string
  readonly modifiedAtEpochMs: number
}) => {
  const buffer = Buffer.from(options.content)
  const sizeBytes = buffer.byteLength
  const headHash =
    sizeBytes < stableHeadSampleBytes
      ? undefined
      : hashBytes(buffer.subarray(0, stableHeadSampleBytes))
  const tailStart = Math.max(0, sizeBytes - stableHeadSampleBytes)

  return buildContentVersion({
    sizeBytes,
    modifiedAtEpochMs: options.modifiedAtEpochMs,
    ...(headHash !== undefined && { headHash }),
    tailHash: hashBytes(buffer.subarray(tailStart)),
  }) satisfies ContentVersion
}

/** Computes a stable content version for any file by hashing its trailing bytes plus stat metadata. */
export const readFileContentVersion = Effect.fn('AgentSessionIngest.readFileContentVersion')(
  (path: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const info = yield* fs.stat(path).pipe(
        Effect.mapError(
          (cause) =>
            new SessionArtifactReadError({
              message: 'Failed to stat artifact for content version',
              path,
              cause,
            }),
        ),
      )

      const sizeBytes = Number(info.size)
      const [headHash, tailHash] = yield* Effect.all([
        Effect.tryPromise({
          try: async () => {
            if (sizeBytes < stableHeadSampleBytes) return undefined

            const length = stableHeadSampleBytes

            const handle = await openFile(path, 'r')
            try {
              const buffer = Buffer.alloc(length)
              const { bytesRead } = await handle.read(buffer, 0, length, 0)
              return hashBytes(buffer.subarray(0, bytesRead))
            } finally {
              await handle.close()
            }
          },
          catch: (cause) =>
            new SessionArtifactReadError({
              message: 'Failed to read artifact head sample',
              path,
              cause,
            }),
        }),
        Effect.tryPromise({
          try: async () => {
            const length = Math.min(stableHeadSampleBytes, sizeBytes)
            if (length === 0) return hashBytes(Buffer.alloc(0))

            const handle = await openFile(path, 'r')
            try {
              const buffer = Buffer.alloc(length)
              const { bytesRead } = await handle.read(buffer, 0, length, sizeBytes - length)
              return hashBytes(buffer.subarray(0, bytesRead))
            } finally {
              await handle.close()
            }
          },
          catch: (cause) =>
            new SessionArtifactReadError({
              message: 'Failed to read artifact tail sample',
              path,
              cause,
            }),
        }),
      ])

      return buildContentVersion({
        sizeBytes,
        modifiedAtEpochMs: Option.getOrUndefined(info.mtime)?.getTime() ?? 0,
        ...(headHash !== undefined && { headHash }),
        tailHash,
      }) satisfies ContentVersion
    }),
)
