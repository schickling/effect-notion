import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { discoverGenieFiles } from './bootstrap-closure-check-cli.ts'
import {
  canonicalResolvedPath,
  checkBootstrapClosure,
  formatViolationChain,
} from './bootstrap-closure.ts'

const GENIE_MEMBER_OVERRIDE_MAP_ENV = 'GENIE_MEMBER_OVERRIDE_MAP'
const GENIE_TYPESCRIPT_API_SERVER_ENV = 'GENIE_TYPESCRIPT_API_SERVER'

const createdDirs: string[] = []

/** Fresh, symlink-resolved temp dir so on-disk paths match TypeScript's resolved (realpath'd) file names. */
const makeDir = (): string => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'genie-bootstrap-closure-')))
  createdDirs.push(dir)
  return dir
}

const write = (dir: string, relativePath: string, content: string): string => {
  const filePath = path.join(dir, relativePath)
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf8')
  return filePath
}

afterEach(() => {
  delete process.env[GENIE_MEMBER_OVERRIDE_MAP_ENV]
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('checkBootstrapClosure', () => {
  it('FAILs on a wide barrel with the correct importer chain (source -> barrel -> runtime -> effect)', async () => {
    const dir = makeDir()
    write(dir, 'runtime.ts', `import { Effect } from 'effect'\nexport const value = Effect`)
    // A wide barrel that `export *`s a module reaching a bare runtime-only package.
    write(dir, 'barrel.ts', `export * from './runtime.ts'`)
    const source = write(
      dir,
      'source.genie.ts',
      `import { value } from './barrel.ts'\nexport default value`,
    )

    const { violations } = await checkBootstrapClosure({ genieFiles: [source] })

    expect(violations).toHaveLength(1)
    expect(violations[0]!.specifier).toBe('effect')
    expect(violations[0]!.chain).toEqual([
      source,
      path.join(dir, 'barrel.ts'),
      path.join(dir, 'runtime.ts'),
    ])
    expect(formatViolationChain({ violation: violations[0]!, repoRoot: dir })).toBe(
      'source.genie.ts\n    -> barrel.ts\n    -> runtime.ts\n    -> effect',
    )
  })

  it('PASSes a narrow direct import that never reaches a bare package', async () => {
    const dir = makeDir()
    write(
      dir,
      'safe.ts',
      `import { readFileSync } from 'node:fs'\nexport const helper = readFileSync`,
    )
    const source = write(
      dir,
      'narrow.genie.ts',
      `import { helper } from './safe.ts'\nexport default helper`,
    )

    const { violations } = await checkBootstrapClosure({ genieFiles: [source] })

    expect(violations).toHaveLength(0)
  })

  it('drains a wide duplicate graph without recursing once per duplicate edge', async () => {
    const dir = makeDir()
    write(
      dir,
      'safe.ts',
      `import { readFileSync } from 'node:fs'\nexport const helper = readFileSync`,
    )
    const source = write(
      dir,
      'wide.genie.ts',
      Array.from(
        { length: 20_000 },
        (_, index) => `export { helper as helper${index} } from './safe.ts'`,
      ).join('\n'),
    )

    const { violations } = await checkBootstrapClosure({ genieFiles: [source] })

    expect(violations).toHaveLength(0)
  })

  it('follows a lock-pinned `#mr` member edge: FAILs when the member reaches a bare package, PASSes a safe member import', async () => {
    const dir = makeDir()
    const memberDir = path.join(dir, 'member-x')
    write(memberDir, 'reaches-bare.ts', `import { Effect } from 'effect'\nexport const a = Effect`)
    write(
      memberDir,
      'safe.ts',
      `import { readFileSync } from 'node:fs'\nexport const b = readFileSync`,
    )

    // Resolve `#mr/member-x/...` to the on-disk fixture member exactly as genie's own resolver does.
    process.env[GENIE_MEMBER_OVERRIDE_MAP_ENV] = JSON.stringify({ 'member-x': memberDir })

    const failRoot = write(
      dir,
      'mr-fail.genie.ts',
      `import { a } from '#mr/member-x/reaches-bare.ts'\nexport default a`,
    )
    const safeRoot = write(
      dir,
      'mr-safe.genie.ts',
      `import { b } from '#mr/member-x/safe.ts'\nexport default b`,
    )

    const { violations } = await checkBootstrapClosure({ genieFiles: [failRoot, safeRoot] })

    const failViolation = violations.find((violation) => violation.source === failRoot)
    expect(failViolation).toBeDefined()
    expect(failViolation!.specifier).toBe('effect')
    expect(failViolation!.chain).toEqual([failRoot, path.join(memberDir, 'reaches-bare.ts')])

    expect(violations.find((violation) => violation.source === safeRoot)).toBeUndefined()
  })

  it('excludes type-only edges (import type, export { type }, import type * as) even when the target reaches a bare package', async () => {
    const dir = makeDir()
    write(
      dir,
      'rt.ts',
      `import { Effect } from 'effect'\nexport type Thing = number\nexport const runtimeValue = Effect`,
    )
    const source = write(
      dir,
      'type-only.genie.ts',
      [
        `import type { Thing } from './rt.ts'`,
        `export { type Thing as Alias } from './rt.ts'`,
        `import type * as Namespace from './rt.ts'`,
        `export const marker: Thing = 1`,
        `export type Reexported = Namespace.Thing`,
      ].join('\n'),
    )

    const { violations } = await checkBootstrapClosure({ genieFiles: [source] })

    expect(violations).toHaveLength(0)
  })

  it('follows an import with a value default even when its named bindings are all inline-`type`', async () => {
    const dir = makeDir()
    // `helper.ts` reaches a bare runtime-only package; the source imports it with a value default
    // plus only inline-`type` named bindings — the default is a runtime edge and must be followed.
    write(
      dir,
      'helper.ts',
      `import { Effect } from 'effect'\nexport default Effect\nexport type Options = number`,
    )
    const source = write(
      dir,
      'default-plus-type.genie.ts',
      `import helper, { type Options } from './helper.ts'\nexport default helper as unknown as Options`,
    )

    const { violations } = await checkBootstrapClosure({ genieFiles: [source] })

    expect(violations).toHaveLength(1)
    expect(violations[0]!.specifier).toBe('effect')
    expect(violations[0]!.chain).toEqual([source, path.join(dir, 'helper.ts')])
  })

  it('detects a dynamic `import(...)` with a string-literal bare specifier as a violation', async () => {
    const dir = makeDir()
    const source = write(
      dir,
      'dynamic.genie.ts',
      `export const load = async () => import('effect')`,
    )

    const { violations } = await checkBootstrapClosure({ genieFiles: [source] })

    expect(violations).toHaveLength(1)
    expect(violations[0]!.specifier).toBe('effect')
    expect(violations[0]!.chain).toEqual([source])
  })

  it('does NOT flag node builtins (bare `crypto` and `node:`-prefixed)', async () => {
    const dir = makeDir()
    const source = write(
      dir,
      'builtins.genie.ts',
      `import 'crypto'\nimport 'node:fs'\nexport const ok = true`,
    )

    const { violations } = await checkBootstrapClosure({ genieFiles: [source] })

    expect(violations).toHaveLength(0)
  })

  it('flags a bare first-party scoped package (not resolvable pre-install) as a violation', async () => {
    const dir = makeDir()
    const source = write(dir, 'firstparty.genie.ts', `import '@scope/pkg'\nexport const ok = true`)

    const { violations } = await checkBootstrapClosure({ genieFiles: [source] })

    expect(violations).toHaveLength(1)
    expect(violations[0]!.specifier).toBe('@scope/pkg')
    expect(violations[0]!.chain).toEqual([source])
  })

  // Regression: chain links used to be whatever the compiler resolved, which is NOT the file's on-disk
  // identity — TypeScript canonicalizes resolutions for the filesystem it thinks it is on (lower-casing
  // them on macOS, where it produced `...-gfbwy6/barrel.ts` for a chain rooted at `...-gfbwY6/`). A
  // symlinked entry is the case-sensitive expression of the same defect: every returned path, root
  // included, must be the real file.
  it('reports the filesystem-canonical path for every chain link reached through a symlink', async () => {
    const dir = makeDir()
    write(dir, 'real/runtime.ts', `import { Effect } from 'effect'\nexport const value = Effect`)
    write(dir, 'real/barrel.ts', `export * from './runtime.ts'`)
    write(dir, 'real/source.genie.ts', `import { value } from './barrel.ts'\nexport default value`)
    symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'), 'dir')

    const { violations, checkedSources } = await checkBootstrapClosure({
      genieFiles: [path.join(dir, 'link', 'source.genie.ts')],
    })

    expect(violations).toHaveLength(1)
    expect(violations[0]!.chain).toEqual([
      path.join(dir, 'real', 'source.genie.ts'),
      path.join(dir, 'real', 'barrel.ts'),
      path.join(dir, 'real', 'runtime.ts'),
    ])
    expect(violations[0]!.source).toBe(path.join(dir, 'real', 'source.genie.ts'))
    expect(checkedSources).toEqual([path.join(dir, 'real', 'source.genie.ts')])
    for (const file of violations[0]!.chain) expect(file).toBe(realpathSync.native(file))
  })

  // Regression: the API client's protocol is versioned with its compiler binary, so the session must
  // use the `typescript` package's OWN matching platform executable. A `tsgo` on `PATH` (the dev shell
  // exposes the Effect-TS fork, a different revision) must never be picked up: older forks answer
  // `updateSnapshot` with zero projects, which would silently turn every closure into "no violations".
  it('ignores a foreign `tsgo` on PATH and analyzes with the bundled matching API server', async () => {
    const dir = makeDir()
    const foreignBinDir = path.join(dir, 'foreign-bin')
    mkdirSync(foreignBinDir, { recursive: true })
    const foreignServer = path.join(foreignBinDir, 'tsgo')
    writeFileSync(foreignServer, '#!/bin/sh\nexit 1\n', { encoding: 'utf8', mode: 0o755 })
    const source = write(dir, 'path-foreign.genie.ts', `import 'effect'\nexport const ok = true`)

    const previousPath = process.env.PATH
    const previousServer = process.env[GENIE_TYPESCRIPT_API_SERVER_ENV]
    process.env.PATH = `${foreignBinDir}${path.delimiter}${previousPath ?? ''}`
    delete process.env[GENIE_TYPESCRIPT_API_SERVER_ENV]
    try {
      const { violations } = await checkBootstrapClosure({ genieFiles: [source] })

      expect(violations).toHaveLength(1)
      expect(violations[0]!.specifier).toBe('effect')
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousServer !== undefined)
        process.env[GENIE_TYPESCRIPT_API_SERVER_ENV] = previousServer
    }
  })
})

// The macOS half of the same defect, driven directly so it runs on a case-sensitive filesystem: the
// compiler hands back a case-folded resolution for a file whose real spelling is mixed-case.
describe('canonicalResolvedPath', () => {
  it('restores the importer spelling for the folded components it shares', () => {
    const dir = makeDir()
    const importer = write(dir, 'Fixture-AbC/source.genie.ts', `export default {}`)
    write(dir, 'Fixture-AbC/barrel.ts', `export default {}`)

    const folded = path.join(dir, 'fixture-abc', 'barrel.ts')

    expect(canonicalResolvedPath({ file: folded, importer, listings: new Map() })).toBe(
      path.join(dir, 'Fixture-AbC', 'barrel.ts'),
    )
  })

  it('reads the real spelling back from disk for components below the importer', () => {
    const dir = makeDir()
    const importer = write(dir, 'Fixture-AbC/source.genie.ts', `export default {}`)
    write(dir, 'Fixture-AbC/Nested-Dir/Leaf.ts', `export default {}`)

    const folded = path.join(dir, 'fixture-abc', 'nested-dir', 'leaf.ts')

    expect(canonicalResolvedPath({ file: folded, importer, listings: new Map() })).toBe(
      path.join(dir, 'Fixture-AbC', 'Nested-Dir', 'Leaf.ts'),
    )
  })

  it('keeps an exact on-disk spelling when a case-sensitive filesystem holds both', () => {
    const dir = makeDir()
    const importer = write(dir, 'pkg/source.genie.ts', `export default {}`)
    write(dir, 'pkg/Leaf.ts', `export default {}`)
    write(dir, 'pkg/leaf.ts', `export default {}`)

    const exact = path.join(dir, 'pkg', 'leaf.ts')

    expect(canonicalResolvedPath({ file: exact, importer, listings: new Map() })).toBe(exact)
  })
})

describe('discoverGenieFiles', () => {
  it('walks source-tree genie files without requiring git and skips dependency/build directories', () => {
    const dir = makeDir()
    const rootSource = write(dir, 'root.genie.ts', `export default {}`)
    const nestedSource = write(dir, 'nested/member.genie.ts', `export default {}`)
    write(dir, 'node_modules/pkg/ignored.genie.ts', `export default {}`)
    write(dir, '.git/hooks/ignored.genie.ts', `export default {}`)
    write(dir, 'dist/ignored.genie.ts', `export default {}`)

    expect(discoverGenieFiles(dir)).toEqual([nestedSource, rootSource])
  })
})
