import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { parseGeneratorPhase } from '../../core/phase.ts'
import { checkBootstrapClosure, formatViolationChain } from './bootstrap-closure.ts'

const usage = `Usage:
  genie-bootstrap-closure-check [--root <repo-root>]

Checks source-tree // @genie-bootstrap .genie.ts files for runtime-only package imports.`

const ignoredDiscoveryDirs = new Set([
  '.devenv',
  '.direnv',
  '.git',
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
  'result',
  'target',
])

const parseArgs = ({
  argv,
  defaultRepoRoot,
}: {
  argv: readonly string[]
  defaultRepoRoot: string
}): { readonly repoRoot: string; readonly help: boolean } => {
  let repoRoot = defaultRepoRoot
  let help = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }
    if (arg === '--root') {
      const value = argv[index + 1]
      if (value === undefined || value.length === 0) {
        throw new Error('--root requires a non-empty path')
      }
      repoRoot = path.resolve(value)
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }

  return { repoRoot, help }
}

/** Discover source-tree `.genie.ts` files without requiring Git or package-manager install state. */
export const discoverGenieFiles = (repoRoot: string): readonly string[] => {
  const files: string[] = []

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() === true) continue

      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory() === true) {
        if (ignoredDiscoveryDirs.has(entry.name) === false) visit(entryPath)
        continue
      }

      if (entry.isFile() === true && entry.name.endsWith('.genie.ts') === true) {
        files.push(entryPath)
      }
    }
  }

  visit(repoRoot)
  return files.toSorted()
}

/**
 * Runs the standalone bootstrap import-closure checker CLI.
 */
export const bootstrapClosureCheckMain = async ({
  argv,
  defaultRepoRoot,
}: {
  argv: readonly string[]
  defaultRepoRoot: string
}): Promise<void> => {
  try {
    const { repoRoot, help } = parseArgs({ argv, defaultRepoRoot })
    if (help === true) {
      console.log(usage)
      return
    }

    const allGenieFiles = discoverGenieFiles(repoRoot)
    const bootstrapFiles = allGenieFiles.filter(
      (file) => parseGeneratorPhase(readFileSync(file, 'utf8')) === 'bootstrap',
    )

    const { violations, checkedSources } = await checkBootstrapClosure({
      genieFiles: bootstrapFiles,
    })

    if (violations.length > 0) {
      console.error(
        `✗ bootstrap-closure: ${violations.length} bootstrap-phase generator(s) reach a runtime-only package:\n`,
      )
      for (const violation of violations) {
        console.error(`  ${formatViolationChain({ violation, repoRoot })}\n`)
      }
      console.error(
        'A `bootstrap`-phase `.genie.ts` must be importable from a fresh checkout BEFORE install. ' +
          'Narrow the import (avoid wide barrels that reach runtime-only packages), or — if the ' +
          'generator genuinely needs the runtime graph — remove its `// @genie-bootstrap` pragma ' +
          'so it runs post-install as a design-time generator (and ensure no install step depends on its output).',
      )
      process.exit(1)
    }

    console.log(
      `bootstrap-closure: OK — ${checkedSources.length} bootstrap-phase .genie.ts checked, no violations ` +
        `(${allGenieFiles.length - bootstrapFiles.length} design-time generator(s) out of scope by declaration)`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`bootstrap-closure: ${message}`)
    process.exit(1)
  }
}
