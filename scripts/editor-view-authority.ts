#!/usr/bin/env -S bun
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { pnpmWorkspaceMemberPaths } from '../genie/packages.ts'
import { reconcileBuckViews } from '../packages/@overeng/buck2-tools/src/buck-watch.ts'
import type { BuckWatchPlan } from '../packages/@overeng/buck2-tools/src/buck-watch.ts'
import { writeEditorViewAuthority } from '../packages/@overeng/buck2-tools/src/editor-view-authority.ts'
import { defaultEditorViewName } from '../packages/@overeng/buck2-tools/src/editor-view.ts'
/** Complete source-authoritative editor consumer registry, including the repository root. */
export const editorViewPackagePaths = ['.', ...pnpmWorkspaceMemberPaths].toSorted((left, right) =>
  left === right ? 0 : left < right ? -1 : 1,
)

/** Whole-workspace publication plan derived from an explicit package registry. */
export const editorViewPlan = ({
  cell,
  packagePaths = editorViewPackagePaths,
}: {
  readonly cell: string
  readonly packagePaths?: readonly string[]
}): BuckWatchPlan => ({
  globalPaths: [],
  packages: packagePaths
    .map((packagePath) => {
      const root = packagePath === '.'
      const viewName = defaultEditorViewName(packagePath)
      const targetPrefix = root === true ? '' : packagePath
      return {
        packagePath,
        sourceRoots: [],
        workspaceDependencies: [],
        targets: {
          packageTree:
            root === true
              ? `${cell}//:root_editor_package_tree`
              : `${cell}//${packagePath}:package_tree`,
        },
        editor: {
          cell,
          consumerCache: `.devenv/vite-cache/${viewName}`,
          inputsManifestTarget: `${cell}//${targetPrefix}:editor_view_inputs`,
          target: root === true ? '//:editor_inputs' : `//${packagePath}:editor_inputs`,
          viewName,
        },
      }
    })
    .toSorted((left, right) =>
      left.packagePath === right.packagePath ? 0 : left.packagePath < right.packagePath ? -1 : 1,
    ),
})

type Command = 'authority' | 'bootstrap' | 'check' | 'publish'

const fail = (message: string): never => {
  throw new Error(`editor view authority: ${message}`)
}

const commands = new Set<Command>(['authority', 'bootstrap', 'check', 'publish'])

const bootstrapPackagePaths = (repoRoot: string): readonly string[] => {
  const value: unknown = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))
  if (
    typeof value !== 'object' ||
    value === null ||
    !('workspaces' in value) ||
    Array.isArray(value.workspaces) === false ||
    value.workspaces.every((entry) => typeof entry === 'string') === false
  )
    fail('generated root package.json must declare string workspace paths')
  return ['.', ...value.workspaces].toSorted((left, right) =>
    left === right ? 0 : left < right ? -1 : 1,
  )
}

const parseCli = (args: readonly string[]) => {
  const command = args[0]
  if (commands.has(command as Command) === false)
    fail('expected command: authority, bootstrap, check, or publish')
  const values = new Map<string, string>()
  for (let index = 1; index < args.length; index += 2) {
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
    '--publisher',
    '--cp',
    '--mv',
    '--snapshot-retention',
  ])
  for (const flag of values.keys())
    if (allowed.has(flag) === false) fail(`unexpected option: ${flag}`)
  const get = (flag: string): string => values.get(flag) ?? fail(`missing required option ${flag}`)
  const admitting = command !== 'authority'
  return {
    command: command as Command,
    repoRoot: get('--repo-root'),
    workspaceRoot: get('--workspace-root'),
    cell: get('--cell'),
    buck2: get('--buck2'),
    git: get('--git'),
    output: get('--output'),
    publisher: admitting === true ? get('--publisher') : '',
    cp: admitting === true ? get('--cp') : '',
    mv: admitting === true ? get('--mv') : '',
    snapshotRetention: admitting === true ? Number(get('--snapshot-retention')) : 3,
  }
}

const main = async (): Promise<void> => {
  const options = parseCli(process.argv.slice(2))
  if (
    Number.isInteger(options.snapshotRetention) === false ||
    options.snapshotRetention < 2 ||
    options.snapshotRetention > 32
  )
    fail('--snapshot-retention must be an integer from 2 through 32')
  const packagePaths =
    options.command === 'bootstrap'
      ? bootstrapPackagePaths(options.repoRoot)
      : editorViewPackagePaths
  const authority = await writeEditorViewAuthority({
    ...options,
    requiredPackages: packagePaths,
  })
  if (options.command === 'authority') {
    process.stdout.write(
      `wrote editor dependency authority for ${authority.ownedPackages.length} workspace consumers\n`,
    )
    return
  }
  const plan = editorViewPlan({ cell: options.cell, packagePaths })
  await reconcileBuckViews({
    request: {
      packagePaths: plan.packages.map(({ packagePath }) => packagePath),
      changedPaths: [],
      buildTargets: plan.packages.flatMap(({ editor }) =>
        editor === undefined ? [] : [editor.inputsManifestTarget],
      ),
    },
    options: {
      plan,
      mode: options.command === 'check' ? 'check' : 'publish',
      repoRoot: options.repoRoot,
      workspaceRoot: options.workspaceRoot,
      buck2: options.buck2,
      editorViewCommand: [process.execPath, options.publisher],
      workspaceAuthority: options.output,
      cp: options.cp,
      mv: options.mv,
      snapshotRetention: options.snapshotRetention,
    },
  })
  const action =
    options.command === 'bootstrap'
      ? 'bootstrapped'
      : options.command === 'publish'
        ? 'published'
        : 'checked'
  process.stdout.write(`${action} ${plan.packages.length} editor views\n`)
}

if (import.meta.main === true)
  try {
    await main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
