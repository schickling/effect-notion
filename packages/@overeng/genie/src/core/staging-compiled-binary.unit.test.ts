import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { NodeContext } from '@effect/platform-node'
import { Effect } from 'effect'
import { afterEach, expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import {
  removeStagedCompiledBinaryImportGraph,
  stageCompiledBinaryImportGraph,
} from './generation.ts'

/**
 * Compiled-binary staging must let a `.genie.ts` reach a bare workspace-package subpath
 * (`@scope/contract/registry`) whose own closure reaches a bare runtime package (`effect`). The fix
 * symlinks the importer's real `node_modules` into the staged tmp root so those bare imports resolve
 * against the real on-disk install — the bundled copies in a `bun --compile` binary are not visible
 * to externally-loaded staged files, and staging to `os.tmpdir()` otherwise strips node_modules reach.
 *
 * These fixtures are built with `node:fs` (no install state) so the test is hermetic and does not
 * depend on effect-utils' own live node_modules.
 */

const TestLayer = NodeContext.layer

const createdDirs: string[] = []

/** Symlink-resolved temp dir so staged mirror paths match realpath'd on-disk names. */
const makeDir = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)))
  createdDirs.push(dir)
  return dir
}

const write = (dir: string, relativePath: string, content: string): string => {
  const filePath = path.join(dir, relativePath)
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf8')
  return filePath
}

/**
 * Build a hermetic repo fixture:
 *   node_modules/effect            — a bare runtime package (the transitive edge)
 *   node_modules/@scope/contract   — a bare workspace package exposing a `./registry` SUBPATH that
 *                                    itself imports `effect`
 *   packages/foo/<entry>.genie.ts  — imports the bare subpath and re-exports it as a GenieOutput
 */
const makeRepoFixture = ({ importSpecifier }: { importSpecifier: string }): string => {
  const repoRoot = makeDir('genie-staging-repo-')

  write(
    repoRoot,
    'node_modules/effect/package.json',
    JSON.stringify({ name: 'effect', type: 'module', exports: { '.': './index.js' } }),
  )
  write(
    repoRoot,
    'node_modules/effect/index.js',
    `export const Effect = { succeed: (value) => value }\n`,
  )

  write(
    repoRoot,
    'node_modules/@scope/contract/package.json',
    JSON.stringify({
      name: '@scope/contract',
      type: 'module',
      exports: { './registry': './registry.ts' },
    }),
  )
  write(
    repoRoot,
    'node_modules/@scope/contract/registry.ts',
    `import { Effect } from 'effect'\nexport const registry = { kind: Effect.succeed('semconv'), count: 2 }\n`,
  )

  write(
    repoRoot,
    'packages/foo/data.json.genie.ts',
    [
      `import { registry } from '${importSpecifier}'`,
      `export default { data: registry, stringify: () => JSON.stringify(registry) }`,
    ].join('\n'),
  )

  return path.join(repoRoot, 'packages/foo/data.json.genie.ts')
}

/** Stage the genie graph as the compiled-binary path does, dynamically import the staged entry, and return its default export. */
const stageAndImport = (entryPath: string) =>
  Effect.gen(function* () {
    const staged = yield* stageCompiledBinaryImportGraph({ entryPath })
    const importUrl = `${pathToFileURL(staged.stagePath).href}?import=${createdDirs.length}`
    const module = yield* Effect.tryPromise(
      // oxlint-disable-next-line eslint-plugin-import/no-dynamic-require -- staged path is dynamic by design
      () => import(importUrl) as Promise<{ default: { data: unknown } }>,
    ).pipe(Effect.ensuring(removeStagedCompiledBinaryImportGraph(staged)))
    return { module, tempRoot: staged.tempRoot }
  })

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

Vitest.describe('stageCompiledBinaryImportGraph', () => {
  Vitest.it.effect(
    'resolves a bare workspace-package subpath (and its transitive `effect`) via the staged node_modules symlink',
    () =>
      Effect.gen(function* () {
        const entryPath = makeRepoFixture({ importSpecifier: '@scope/contract/registry' })
        const { module } = yield* stageAndImport(entryPath)
        // The registry data (built from the bare `effect` edge) flows through generation.
        expect(module.default.data).toEqual({ kind: 'semconv', count: 2 })
      }).pipe(Effect.provide(TestLayer)),
  )

  Vitest.it.effect(
    'does NOT delete the real node_modules when the staged graph is cleaned up',
    () =>
      Effect.gen(function* () {
        const entryPath = makeRepoFixture({ importSpecifier: '@scope/contract/registry' })
        const realNodeModules = path.join(path.dirname(entryPath), '../../node_modules')
        const sentinel = path.join(realNodeModules, 'effect/index.js')
        yield* stageAndImport(entryPath) // stages, imports, then removes the temp root
        expect(existsSync(realNodeModules)).toBe(true)
        expect(existsSync(sentinel)).toBe(true)
      }).pipe(Effect.provide(TestLayer)),
  )

  Vitest.it.effect(
    'still stages a pure-relative graph when no node_modules exists (cold bootstrap unaffected)',
    () =>
      Effect.gen(function* () {
        const repoRoot = makeDir('genie-staging-cold-')
        write(repoRoot, 'packages/foo/helper.ts', `export const value = { ok: true }\n`)
        const entryPath = write(
          repoRoot,
          'packages/foo/data.json.genie.ts',
          [
            `import { value } from './helper.ts'`,
            `export default { data: value, stringify: () => JSON.stringify(value) }`,
          ].join('\n'),
        )
        // No node_modules anywhere up the tree — staging must still succeed and not create a symlink.
        const staged = yield* stageCompiledBinaryImportGraph({ entryPath })
        expect(existsSync(path.join(staged.tempRoot, 'node_modules'))).toBe(false)
        const importUrl = `${pathToFileURL(staged.stagePath).href}?import=cold`
        const module = yield* Effect.tryPromise(
          // oxlint-disable-next-line eslint-plugin-import/no-dynamic-require -- staged path is dynamic by design
          () => import(importUrl) as Promise<{ default: { data: unknown } }>,
        ).pipe(Effect.ensuring(removeStagedCompiledBinaryImportGraph(staged)))
        expect(module.default.data).toEqual({ ok: true })
      }).pipe(Effect.provide(TestLayer)),
  )
})
