import { readdirSync, readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

// NOTE: this test lives in `@overeng/otel-contract`, which cannot import `@overeng/genie` (genie
// depends on it — a project-reference cycle). It therefore reads both sides from the filesystem
// rather than importing the aggregator/composition modules. The reusable `orphanSeamPaths`
// helper itself is unit-tested (pure, with a planted orphan) inside genie's composition tests.

const SKIP_DIRS = new Set(['node_modules', 'dist', 'tmp', '.git', '.devenv', 'repos', 'result'])

/** Every telemetry seam file (`*.contract.ts`) in the repo, repo-relative (fs walk — robust to git state). */
const seamFilesOnDisk = (dir: string = repoRoot): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() === true) {
      if (SKIP_DIRS.has(entry.name) === true) continue
      out.push(...seamFilesOnDisk(`${dir}/${entry.name}`))
    } else if (entry.name.endsWith('.contract.ts') === true) {
      out.push(relative(repoRoot, `${dir}/${entry.name}`))
    }
  }
  return out
}

/** Parse the aggregator's `memberSeamPaths = [...]` string-literal list from source. */
const importedSeamPaths = (): string[] => {
  const src = readFileSync(
    new URL('../../../../genie/weaver-registry/registry.ts', import.meta.url),
    'utf8',
  )
  const block = /memberSeamPaths\s*=\s*\[([\s\S]*?)\]/.exec(src)
  if (block === null) throw new Error('could not locate memberSeamPaths in the aggregator')
  return [...block[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!)
}

const orphans = (onDisk: readonly string[], imported: readonly string[]): string[] => {
  const set = new Set(imported)
  return onDisk.filter((p) => set.has(p) === false).toSorted((a, b) => a.localeCompare(b))
}

describe('no-orphan-seam check (decision 0005)', () => {
  it('every seam file on disk is imported by the root aggregator (no orphans)', () => {
    const onDisk = seamFilesOnDisk()
    expect(onDisk.length).toBeGreaterThan(0) // guard: the glob must actually find seam files
    expect(orphans(onDisk, importedSeamPaths())).toEqual([])
  })

  it('FAILS (reports the orphan) when a seam file on disk is NOT imported by the aggregator', () => {
    const plantedOrphan = 'packages/@overeng/some-pkg/src/orphan.contract.ts'
    expect(orphans([...seamFilesOnDisk(), plantedOrphan], importedSeamPaths())).toContain(
      plantedOrphan,
    )
  })
})

describe('tree-shaking: ./registry projector stays out of the `.` runtime bundle (decision 0006)', () => {
  const modSource = readFileSync(new URL('./mod.ts', import.meta.url), 'utf8')

  it('the `.` entry (mod.ts) does not import the `./registry` design-time module', () => {
    // Static import-graph guarantee: registry.ts imports mod.ts (one direction); mod.ts has no
    // local imports at all. A stronger bundle-grep for the weaver annotation symbol runs in the
    // weaver tree-shake verification step.
    expect(modSource).not.toMatch(/from ['"]\.\/registry(-demo\.contract)?\.ts['"]/)
    expect(modSource).not.toContain('@overeng/genie/weaver/Attr')
  })
})
