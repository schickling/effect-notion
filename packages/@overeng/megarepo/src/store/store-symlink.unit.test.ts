/**
 * Regression: a symlinked store root must resolve to its real path before the
 * Store is built. dev3 moved `~/.megarepo` to `/srv/bulk/megarepo` behind a
 * compat symlink; Git registers worktrees under the real path while member
 * identity checks compare paths lexically, so an unresolved symlink root
 * rejected every branch member with GitIdentityConflict ("registered outside
 * canonical P or P/repos/<owned>") and `mr apply` silently materialized
 * nothing (dotfiles#2720 family).
 */

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Context, Effect, Layer } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import { Store, StoreLayer } from './store.ts'

const setStoreEnv = (value: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env['MEGAREPO_STORE']
      process.env['MEGAREPO_STORE'] = value
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) {
          delete process.env['MEGAREPO_STORE']
        } else {
          process.env['MEGAREPO_STORE'] = previous
        }
      }),
  )

describe('store: symlinked store root', () => {
  it.effect(
    'resolves a symlinked MEGAREPO_STORE to its real path',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const tmpRoot = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const realDir = EffectPath.ops.join(tmpRoot, EffectPath.unsafe.relativeDir('real/'))
        const linkDir = EffectPath.ops.join(tmpRoot, EffectPath.unsafe.relativeDir('link/'))
        yield* fs.makeDirectory(realDir)
        // symlink(2) rejects a trailing slash on the link path.
        yield* fs.symlink(realDir, linkDir.slice(0, -1))

        yield* setStoreEnv(linkDir)

        const store = yield* Layer.build(StoreLayer).pipe(Effect.map(Context.get(Store)))
        expect(store.basePath).toBe(realDir)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'keeps a non-existent store path lexical (no realpath failure)',
    Effect.fnUntraced(function* () {
      const missingDir = EffectPath.unsafe.absoluteDir('/nonexistent-megarepo-store-root/')
      yield* setStoreEnv(missingDir)

      const store = yield* Layer.build(StoreLayer).pipe(Effect.map(Context.get(Store)))
      expect(store.basePath).toBe(missingDir)
    }, Effect.provide(NodeServices.layer)),
  )
})
