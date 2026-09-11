import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buck2StagedRuntimes, stagedModuleName } from './runtime-modules.ts'

/**
 * Every relative specifier in one module, in source order.
 *
 * Matches `import`/`export ... from './x.ts'`, bare `import './x.ts'`, and
 * dynamic `import('./x.ts')`. Buck stages sources verbatim, so the specifier a
 * runner writes is the path Bun resolves inside the action.
 */
const relativeSpecifiers = (source: string): readonly string[] =>
  [...source.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]*)['"]/gu)].map(
    (match) => match[1] ?? '',
  )

const resolveSpecifier = ({
  fromModule,
  specifier,
}: {
  readonly fromModule: string
  readonly specifier: string
}): string => {
  const resolved = posix.normalize(posix.join(dirname(fromModule), specifier))
  if (existsSync(resolved) === false) {
    throw new Error(`${fromModule} imports ${specifier}, which does not resolve to ${resolved}`)
  }
  return resolved
}

/** Every repository source reachable from `entry` through relative imports. */
const importClosure = (entry: string): readonly string[] => {
  const seen = new Set<string>()
  const pending = [entry]
  while (pending.length > 0) {
    const module = pending.pop() ?? ''
    if (seen.has(module) === true) continue
    seen.add(module)
    for (const specifier of relativeSpecifiers(readFileSync(module, 'utf8'))) {
      pending.push(resolveSpecifier({ fromModule: module, specifier }))
    }
  }
  return [...seen].toSorted()
}

const buck2ToolsBuck = readFileSync('packages/@overeng/buck2-tools/BUCK', 'utf8')

describe('staged Buck runtime closure', () => {
  it.each(buck2StagedRuntimes.map((runtime) => [runtime.label, runtime] as const))(
    '%s stages the complete relative-import closure of its entry',
    (_label, runtime) => {
      expect(importClosure(runtime.entry)).toEqual([...runtime.modules].toSorted())
    },
  )

  it.each(
    buck2StagedRuntimes
      .filter((runtime) => runtime.staging === 'export_file')
      .map((runtime) => [runtime.label, runtime] as const),
  )('%s is staged as one file and therefore imports nothing relative', (_label, runtime) => {
    expect(runtime.modules).toEqual([runtime.entry])
    expect(relativeSpecifiers(readFileSync(runtime.entry, 'utf8'))).toEqual([])
    expect(buck2ToolsBuck).toContain(`    src = "src/${stagedModuleName(runtime.entry)}",`)
  })

  it('declares every filegroup-staged module in the buck2-tools package', () => {
    for (const runtime of buck2StagedRuntimes.filter((entry) => entry.staging === 'filegroup')) {
      const name = runtime.label.slice(runtime.label.lastIndexOf(':') + 1)
      const block = buck2ToolsBuck.split(`name = "${name}",`)[1]?.split(')')[0] ?? ''
      expect(block, `no filegroup block for ${runtime.label}`).not.toBe('')
      const declared = [...block.matchAll(/"([^"]+)":\s*"([^"]+)"/gu)].map((match) => ({
        staged: match[1],
        source: `packages/@overeng/buck2-tools/${match[2] ?? ''}`,
      }))
      expect(declared.map(({ source }) => source).toSorted()).toEqual(
        [...runtime.modules].toSorted(),
      )
      // The tree is flat, so the entry passed as `runtime_entry` is a bare name.
      expect(declared.map(({ staged }) => staged).toSorted()).toEqual(
        runtime.modules.map(stagedModuleName).toSorted(),
      )
    }
  })

  it('follows relative imports, so a clean closure is not a vacuous pass', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'buck2-runtime-closure-'))
    try {
      const entry = join(fixture, 'entry.ts')
      writeFileSync(join(fixture, 'helper.ts'), 'export const x = 1\n')
      writeFileSync(join(fixture, 'deep.ts'), "export { x } from './helper.ts'\n")
      writeFileSync(entry, "import { x } from './deep.ts'\nexport const y = x\n")

      expect(importClosure(entry)).toEqual(
        [entry, join(fixture, 'deep.ts'), join(fixture, 'helper.ts')].toSorted(),
      )
      writeFileSync(entry, "import { x } from './missing.ts'\n")
      expect(() => importClosure(entry)).toThrow('does not resolve to')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
