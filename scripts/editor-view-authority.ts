#!/usr/bin/env -S bun
import process from 'node:process'

import typescriptAuthorityManifest from '../genie/buck2/typescript-authority-manifest.json' with { type: 'json' }
import { writeEditorViewAuthority } from '../packages/@overeng/buck2-tools/src/editor-view-authority.ts'

const fail = (message: string): never => {
  throw new Error(`editor view authority: ${message}`)
}

const parseCli = (args: readonly string[]) => {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? fail('missing option')
    const value = args[index + 1] ?? fail(`missing value for ${flag}`)
    if (flag.startsWith('--') === false || values.has(flag) === true)
      fail(`unexpected or duplicate option: ${flag}`)
    values.set(flag, value)
  }
  const allowed = new Set([
    '--repo-root',
    '--workspace-root',
    '--cell',
    '--buck2',
    '--git',
    '--output',
  ])
  for (const flag of values.keys())
    if (allowed.has(flag) === false) fail(`unexpected option: ${flag}`)
  const get = (flag: string): string => values.get(flag) ?? fail(`missing required option ${flag}`)
  return {
    repoRoot: get('--repo-root'),
    workspaceRoot: get('--workspace-root'),
    cell: get('--cell'),
    buck2: get('--buck2'),
    git: get('--git'),
    output: get('--output'),
  }
}

try {
  const options = parseCli(process.argv.slice(2))
  const authority = await writeEditorViewAuthority({
    ...options,
    requiredPackages: typescriptAuthorityManifest.editorViewConsumerPackagePaths,
  })
  process.stdout.write(
    `wrote editor dependency authority for ${authority.ownedPackages.length} workspace packages\n`,
  )
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
