import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { discoverGenieFiles } from './bootstrap-closure-check-cli.ts'
import { checkBootstrapClosure, formatViolationChain } from './bootstrap-closure.ts'

const GENIE_MEMBER_OVERRIDE_MAP_ENV = 'GENIE_MEMBER_OVERRIDE_MAP'

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
