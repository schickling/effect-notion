/**
 * Atomic file writes for store state.
 *
 * State files under `$STORE/.state/` (liveness records, gc ledger) must never
 * be observed half-written by a concurrent reader. `writeFileAtomic` writes to
 * a sibling temp file and `rename`s it into place — on POSIX filesystems
 * `rename` over an existing path is atomic, so a reader sees either the old or
 * the new content, never a truncated mix.
 */

import { randomBytes } from 'node:crypto'

import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { type PlatformError } from 'effect/PlatformError'

import { EffectPath, type AbsoluteFilePath } from '@overeng/effect-path'

import * as Observability from '../core/observability.ts'

/**
 * Derives a sibling temp path that is UNIQUE per write — the per-target name
 * alone would be shared by two concurrent writers of the same target (e.g. two
 * `mr` processes refreshing the same workspace registry record), letting one
 * clobber or rename the other's temp before its own `rename`. A pid + random
 * suffix makes each in-flight temp distinct; the trailing `.tmp-` marks it for
 * cleanup. Called once per write inside the Effect, so the randomness is fresh.
 */
const tempPathFor = (path: AbsoluteFilePath): AbsoluteFilePath =>
  EffectPath.unsafe.absoluteFile(`${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`)

/**
 * Atomically write `content` to `path` via write-temp-then-rename.
 *
 * The temp file lives in the same directory as the target (required for
 * `rename` to stay on one filesystem). On any failure the temp file is removed
 * so it never lingers as garbage.
 */
export const writeFileAtomic = ({
  path,
  content,
}: {
  path: AbsoluteFilePath
  content: string
}): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const tempPath = tempPathFor(path)
    yield* fs
      .writeFileString(tempPath, content)
      .pipe(Effect.tapError(() => fs.remove(tempPath).pipe(Effect.ignore)))
    yield* fs
      .rename(tempPath, path)
      .pipe(Effect.tapError(() => fs.remove(tempPath).pipe(Effect.ignore)))
  }).pipe(
    Observability.withLabelSpan({
      name: 'megarepo/store/fs/write-atomic',
      labelValue: 'write-atomic',
    }),
  )
