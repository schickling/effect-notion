import { open as openFile } from 'node:fs/promises'

import { Effect, FileSystem } from 'effect'

import { SessionArtifactReadError } from '../errors.ts'
import type { ContentVersion, ContentVersionCursor, MutableReadResult } from '../schema/core.ts'
import { buildContentVersionFromText } from './content-version.ts'

const isSameContentVersion = (options: {
  previous: ContentVersionCursor['contentVersion'] | undefined
  next: ContentVersion
}) =>
  options.previous?.sizeBytes === options.next.sizeBytes &&
  options.previous?.modifiedAtEpochMs === options.next.modifiedAtEpochMs &&
  options.previous?.headHash === options.next.headHash &&
  options.previous?.tailHash === options.next.tailHash

/** Reads a mutable artifact only when its content version changed since the last checkpoint. */
export const readMutableTextFileIfChanged = Effect.fn(
  'AgentSessionIngest.readMutableTextFileIfChanged',
)((options: { path: string; previous: ContentVersionCursor | undefined }) =>
  Effect.gen(function* () {
    yield* FileSystem.FileSystem

    const { content, contentVersion } = yield* Effect.tryPromise({
      try: async () => {
        const readStableSnapshot = async (
          attempt: number,
        ): Promise<{
          readonly content: string
          readonly contentVersion: ContentVersion
        }> => {
          if (attempt >= 3) {
            throw new Error('Mutable artifact changed while reading')
          }

          const handle = await openFile(options.path, 'r')
          try {
            const before = await handle.stat()
            const sizeBytes = before.size
            const buffer = Buffer.alloc(sizeBytes)
            const { bytesRead } = await handle.read(buffer, 0, sizeBytes, 0)
            const after = await handle.stat()

            if (
              after.size !== sizeBytes ||
              Math.trunc(after.mtimeMs) !== Math.trunc(before.mtimeMs)
            ) {
              return readStableSnapshot(attempt + 1)
            }

            const text = buffer.subarray(0, bytesRead).toString('utf8')
            return {
              content: text,
              contentVersion: buildContentVersionFromText({
                content: text,
                modifiedAtEpochMs: Math.trunc(after.mtimeMs),
              }),
            }
          } finally {
            await handle.close()
          }
        }
        return readStableSnapshot(0)
      },
      catch: (cause) =>
        new SessionArtifactReadError({
          message: 'Failed to read stable mutable artifact snapshot',
          path: options.path,
          cause,
        }),
    })

    return {
      content,
      contentVersion,
      changed:
        isSameContentVersion({
          previous: options.previous?.contentVersion,
          next: contentVersion,
        }) !== true,
    } satisfies MutableReadResult
  }),
)
