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

const rootBuck = readFileSync('BUCK', 'utf8')
const buck2ToolsBuck = readFileSync('packages/@overeng/buck2-tools/BUCK', 'utf8')

/**
 * Package-relative sources `packages/@overeng/buck2-tools` declares as
 * materialization inputs, whatever rendering the projection uses for them.
 *
 * One declared input is one single-file Buck target named after the path, which
 * is what a root alias for a one-file runtime resolves to. Asserting the
 * declaration rather than a particular `export_file(...)` spelling keeps this
 * test about the staging contract instead of the generator's text.
 */
const buck2ToolsMaterializationInputs = [
  ...(/export_materialization_inputs\(\[([\s\S]*?)\]\)/u.exec(buck2ToolsBuck)?.[1] ?? '').matchAll(
    /"([^"]+)"/gu,
  ),
].map((match) => match[1] ?? '')

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
    expect(rootBuck).toContain(
      `    actual = "//packages/@overeng/buck2-tools:${runtime.entry.slice('packages/@overeng/buck2-tools/'.length)}",`,
    )
    expect(buck2ToolsMaterializationInputs).toContain(
      runtime.entry.slice('packages/@overeng/buck2-tools/'.length),
    )
  })

  it('declares every filegroup-staged module in the buck2-tools package', () => {
    for (const runtime of buck2StagedRuntimes.filter((entry) => entry.staging === 'filegroup')) {
      const name = runtime.label.slice('//:'.length)
      const rootAlias = rootBuck.split(`name = "${name}",`)[1]?.split(')')[0] ?? ''
      expect(rootAlias).toContain(
        'actual = "//packages/@overeng/buck2-tools:package_tree_runtime"',
      )
      const block = buck2ToolsBuck.split(`name = "${name}",`)[1]?.split(')')[0] ?? ''
      expect(block, `no filegroup block for ${runtime.label}`).not.toBe('')
      const declared = [...block.matchAll(/"([^"]+)":\s*"([^"]+)"/gu)].map((match) => ({
        staged: match[1],
        source: `packages/@overeng/buck2-tools/${match[2]}`,
      }))
      expect(declared.map(({ source }) => source).toSorted()).toEqual(
        [...runtime.modules].toSorted(),
      )
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
