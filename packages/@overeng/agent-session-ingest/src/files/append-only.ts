import { open as openFile } from 'node:fs/promises'

import { Effect, FileSystem, Option, Schema } from 'effect'

import { SessionArtifactReadError } from '../errors.ts'
import type { AppendOnlyReadResult, ContentVersion } from '../schema/core.ts'
import { ContentVersion as ContentVersionSchema } from '../schema/core.ts'

const hashText = (text: string) => {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `fnv1a:${(hash >>> 0).toString(16)}`
}

const stableHeadSampleBytes = 512

const buildContentVersion = (options: {
  sizeBytes: number
  modifiedAtEpochMs: number
  headHash?: string
  tailSample: string
}) =>
  Schema.decodeSync(ContentVersionSchema)({
    sizeBytes: options.sizeBytes,
    modifiedAtEpochMs: options.modifiedAtEpochMs,
    ...(options.headHash !== undefined && { headHash: options.headHash }),
    tailHash: hashText(options.tailSample),
  })

const readByteAt = (options: { path: string; offsetBytes: number }) =>
  Effect.tryPromise({
    try: async () => {
      const handle = await openFile(options.path, 'r')
      try {
        const buffer = Buffer.alloc(1)
        const { bytesRead } = await handle.read(buffer, 0, 1, options.offsetBytes)
        return bytesRead === 0 ? undefined : buffer.toString('utf8', 0, 1)
      } finally {
        await handle.close()
      }
    },
    catch: (cause) =>
      new SessionArtifactReadError({
        message: 'Failed to read append-only artifact boundary byte',
        path: options.path,
        cause,
      }),
  })

/** Reads the unread tail of an append-only text artifact and returns the next stable cursor. */
const isSameContentVersion = (options: {
  readonly previous: ContentVersion | undefined
  readonly next: ContentVersion
}) =>
  options.previous?.sizeBytes === options.next.sizeBytes &&
  options.previous?.modifiedAtEpochMs === options.next.modifiedAtEpochMs &&
  options.previous?.headHash === options.next.headHash &&
  options.previous?.tailHash === options.next.tailHash

/** Splits text into complete non-empty JSONL records, skipping an unterminated trailing fragment. */
export const splitCompleteJsonlRecords = (text: string) => {
  const lines = text.split('\n')
  const completeLines = text.endsWith('\n') === true ? lines : lines.slice(0, -1)
  return completeLines.map((line) => line.trim()).filter((line) => line.length > 0)
}

const sliceStableAppendOnlyText = (options: {
  readonly text: string
  readonly startedFromTail: boolean
  readonly beginsOnLineBoundary: boolean
}) => {
  const leadingDiscardBytes =
    options.startedFromTail === true && options.beginsOnLineBoundary !== true
      ? (() => {
          const firstNewlineIndex = options.text.indexOf('\n')
          return firstNewlineIndex === -1 ? 0 : firstNewlineIndex + 1
        })()
      : 0
  const windowText =
    leadingDiscardBytes === 0 ? options.text : options.text.slice(leadingDiscardBytes)
  const stableWindowBytes =
    windowText.endsWith('\n') === true
      ? windowText.length
      : Math.max(0, windowText.lastIndexOf('\n') + 1)

  return {
    text: windowText.slice(0, stableWindowBytes),
    stableBytesConsumed: leadingDiscardBytes + stableWindowBytes,
  }
}

/** Reads the unread suffix of a JSONL-like append-only artifact and returns the next stable cursor. */
export const readAppendOnlyTextFileSince = Effect.fn(
  'AgentSessionIngest.readAppendOnlyTextFileSince',
)(
  (options: {
    path: string
    offsetBytes: number
    initialReadMaxBytes?: number
    previousContentVersion?: ContentVersion
  }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const info = yield* fs.stat(options.path).pipe(
        Effect.mapError(
          (cause) =>
            new SessionArtifactReadError({
              message: 'Failed to stat append-only artifact',
              path: options.path,
              cause,
            }),
        ),
      )

      const sizeBytes = Number(info.size)
      const normalizedOffsetBytes = sizeBytes < options.offsetBytes ? 0 : options.offsetBytes
      const boundedInitialOffsetBytes =
        normalizedOffsetBytes === 0 &&
        options.offsetBytes === 0 &&
        options.initialReadMaxBytes !== undefined &&
        sizeBytes > options.initialReadMaxBytes
          ? sizeBytes - options.initialReadMaxBytes
          : normalizedOffsetBytes

      const [headSample, tailSample] = yield* Effect.all([
        Effect.tryPromise({
          try: async () => {
            if (sizeBytes < stableHeadSampleBytes) return undefined

            const length = stableHeadSampleBytes

            const handle = await openFile(options.path, 'r')
            try {
              const buffer = Buffer.alloc(length)
              const { bytesRead } = await handle.read(buffer, 0, length, 0)
              return buffer.subarray(0, bytesRead).toString('utf8')
            } finally {
              await handle.close()
            }
          },
          catch: (cause) =>
            new SessionArtifactReadError({
              message: 'Failed to read append-only artifact head sample',
              path: options.path,
              cause,
            }),
        }),
        Effect.tryPromise({
          try: async () => {
            const length = Math.min(512, sizeBytes)
            if (length === 0) return ''

            const handle = await openFile(options.path, 'r')
            try {
              const buffer = Buffer.alloc(length)
              const { bytesRead } = await handle.read(buffer, 0, length, sizeBytes - length)
              return buffer.subarray(0, bytesRead).toString('utf8')
            } finally {
              await handle.close()
            }
          },
          catch: (cause) =>
            new SessionArtifactReadError({
              message: 'Failed to read append-only artifact tail sample',
              path: options.path,
              cause,
            }),
        }),
      ])

      const contentVersion = buildContentVersion({
        sizeBytes,
        modifiedAtEpochMs: Option.getOrUndefined(info.mtime)?.getTime() ?? 0,
        ...(headSample !== undefined && { headHash: hashText(headSample) }),
        tailSample,
      })

      const resetToStartBecauseRewrite =
        options.offsetBytes > 0 &&
        options.previousContentVersion !== undefined &&
        isSameContentVersion({
          previous: options.previousContentVersion,
          next: contentVersion,
        }) !== true &&
        options.previousContentVersion.headHash !== undefined &&
        options.previousContentVersion.headHash !== contentVersion.headHash
      const effectiveOffsetBytes =
        resetToStartBecauseRewrite === true ? 0 : boundedInitialOffsetBytes
      const readText = yield* Effect.tryPromise({
        try: async () => {
          const length = Math.max(0, sizeBytes - effectiveOffsetBytes)
          if (length === 0) return ''

          const handle = await openFile(options.path, 'r')
          try {
            const buffer = Buffer.alloc(length)
            const { bytesRead } = await handle.read(buffer, 0, length, effectiveOffsetBytes)
            return buffer.subarray(0, bytesRead).toString('utf8')
          } finally {
            await handle.close()
          }
        },
        catch: (cause) =>
          new SessionArtifactReadError({
            message: 'Failed to read append-only artifact',
            path: options.path,
            cause,
          }),
      })
      const startedFromTail = effectiveOffsetBytes > 0 && options.offsetBytes === 0
      const beginsOnLineBoundary =
        startedFromTail !== true
          ? false
          : effectiveOffsetBytes === 0
            ? true
            : (yield* readByteAt({
                path: options.path,
                offsetBytes: effectiveOffsetBytes - 1,
              })) === '\n'
      const { text: nextText, stableBytesConsumed } = sliceStableAppendOnlyText({
        text: readText,
        startedFromTail,
        beginsOnLineBoundary,
      })

      return {
        text: nextText,
        nextOffsetBytes: effectiveOffsetBytes + stableBytesConsumed,
        resetToStart:
          (normalizedOffsetBytes === 0 && options.offsetBytes > 0) ||
          resetToStartBecauseRewrite === true,
        contentVersion,
      } satisfies AppendOnlyReadResult
    }),
)
