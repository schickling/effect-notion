#!/usr/bin/env -S bun
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'

import typescriptAuthorityManifest from '../genie/buck2/typescript-authority-manifest.json' with { type: 'json' }
import {
  buildTargetsFor,
  reconcileBuckViews,
  runBuckWatchLoop,
  runCommand,
  writeWatchStatus,
  type BuckWatchPackage,
  type BuckWatchPlan,
  type ReconcileRequest,
  type WatchChangeSource,
} from '../packages/@overeng/buck2-tools/src/buck-watch.ts'

/** Whole-repository watch plan: every admitted package publishes an editor view. */
export const watchPlan = (buckCell: string): BuckWatchPlan => ({
  reloadPaths: [
    'genie/buck2',
    'packages/@overeng/buck2-tools/src/buck-watch.ts',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'scripts/buck-watch.ts',
    'scripts/editor-view-authority.ts',
  ],
  reloadSuffixes: ['BUCK.genie.ts'],
  globalPaths: [
    '.buckconfig',
    'BUCK',
    'buck2',
    'genie/buck2',
    'package.json',
    'packages/@overeng/buck2-tools/src/package-tree.ts',
    'packages/@overeng/buck2-tools/src/editor-view.ts',
    'packages/@overeng/buck2-tools/src/real-path.ts',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
  ],
  packages: typescriptAuthorityManifest.watchPackages.map((admission): BuckWatchPackage => {
    const viewName = admission.packageName.replace(/^@[^/]+\//, '')
    return {
      packagePath: admission.packagePath,
      sourceFiles: [
        ...admission.sourceFiles,
        ...admission.additionalTypecheckProjects.map((project) => project.projectFile),
      ],
      sourceRoots: admission.sourceRoots,
      workspaceDependencies: admission.workspaceDependencies,
      targets: {
        additionalTypechecks: admission.additionalTypecheckProjects.map(
          (project) => `${buckCell}//${admission.packagePath}:${project.targetName}`,
        ),
        packageTree: `${buckCell}//${admission.packagePath}:package_tree`,
        typecheck: `${buckCell}//${admission.packagePath}:typecheck`,
        ...(admission.hasDist === true
          ? { dist: `${buckCell}//${admission.packagePath}:dist` }
          : {}),
      },
      editor: {
        cell: viewName,
        consumerCache: `.devenv/vite-cache/${viewName}`,
        inputsManifestTarget: `${buckCell}//${admission.packagePath}:editor_view_inputs`,
        target: `//${admission.packagePath}:editor_inputs`,
        viewName,
      },
    }
  }),
})

const fail = (message: string): never => {
  throw new Error(`buck watch: ${message}`)
}

const valueArgs = (args: readonly string[]): ReadonlyMap<string, string> => {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? fail('missing option')
    const value = args[index + 1] ?? fail(`missing value for ${flag}`)
    if (flag.startsWith('--') === false || values.has(flag) === true)
      fail(`unexpected or duplicate option: ${flag}`)
    values.set(flag, value)
  }
  return values
}

type WatchmanSubscription = {
  readonly subscribe?: string
  readonly files?: readonly { readonly name?: unknown }[]
  readonly error?: string
}

type WatchProject = {
  readonly watch?: unknown
  readonly relative_path?: unknown
  readonly error?: unknown
}

const openWatchmanChanges = async ({
  watchman,
  repoRoot,
  signal,
}: {
  watchman: string
  repoRoot: string
  signal: AbortSignal
}): Promise<WatchChangeSource> => {
  const watched = await runCommand({
    command: watchman,
    args: ['watch-project', repoRoot],
    cwd: repoRoot,
    signal,
  })
  let watchProject: WatchProject
  try {
    watchProject = JSON.parse(watched.stdout) as WatchProject
  } catch (error) {
    return fail(
      `invalid watch-project response: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (typeof watchProject.error === 'string')
    return fail(`watch-project failed: ${watchProject.error}`)
  if (typeof watchProject.watch !== 'string')
    return fail('watch-project did not return a watch root')
  if (watchProject.relative_path !== undefined && typeof watchProject.relative_path !== 'string')
    return fail('watch-project returned an invalid relative_path')
  const child = spawn(watchman, ['-j', '--persistent'], {
    cwd: repoRoot,
    signal,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const subscription = `effect-utils-buck-watch-${process.pid}`
  const ready = Promise.withResolvers<void>()
  const batches: string[][] = []
  const waiters: Array<{
    readonly resolve: (result: IteratorResult<readonly string[]>) => void
    readonly reject: (error: unknown) => void
  }> = []
  let ended = false
  let closing = false
  let terminalError: Error | undefined
  let stderr = ''
  const end = (error?: Error): void => {
    if (ended === true) return
    ended = true
    terminalError = error
    if (error !== undefined) ready.reject(error)
    else ready.resolve()
    for (const waiter of waiters.splice(0)) {
      if (error === undefined) waiter.resolve({ done: true, value: undefined })
      else waiter.reject(error)
    }
  }
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
    process.stderr.write(chunk)
  })
  child.once('error', (error) => end(error))
  child.once('close', (code, childSignal) => {
    if (closing === true || signal.aborted === true) end()
    else
      end(
        new Error(
          `watchman subscription ended ${code ?? `from ${childSignal ?? 'unknown signal'}`}: ${stderr}`,
        ),
      )
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    let response: WatchmanSubscription
    try {
      response = JSON.parse(line) as WatchmanSubscription
    } catch (error) {
      end(
        new Error(
          `invalid Watchman response: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      child.kill('SIGTERM')
      return
    }
    if (response.error !== undefined) {
      end(new Error(`Watchman subscription failed: ${response.error}`))
      child.kill('SIGTERM')
      return
    }
    if (response.subscribe === subscription) ready.resolve()
    if (response.files === undefined) return
    const paths = response.files.flatMap(({ name }) => (typeof name === 'string' ? [name] : []))
    if (paths.length === 0) return
    const waiter = waiters.shift()
    if (waiter === undefined) batches.push(paths)
    else waiter.resolve({ done: false, value: paths })
  })
  child.stdin.write(
    `${JSON.stringify([
      'subscribe',
      watchProject.watch,
      subscription,
      {
        defer_vcs: true,
        ...(watchProject.relative_path === undefined
          ? {}
          : { relative_root: watchProject.relative_path }),
        expression: ['type', 'f'],
        fields: ['name'],
      },
    ])}\n`,
  )
  await ready.promise
  return {
    close: async () => {
      closing = true
      if (ended === false) child.kill('SIGTERM')
      if (ended === false) {
        const closed = Promise.withResolvers<void>()
        child.once('close', () => closed.resolve())
        await closed.promise
      }
      end()
    },
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const batch = batches.shift()
        if (batch !== undefined) return Promise.resolve({ done: false, value: batch })
        if (terminalError !== undefined) return Promise.reject(terminalError)
        if (ended === true) return Promise.resolve({ done: true, value: undefined })
        const result = Promise.withResolvers<IteratorResult<readonly string[]>>()
        waiters.push(result)
        return result.promise
      },
    }),
  }
}

const main = async (): Promise<void> => {
  const command = process.argv[2]
  const values = valueArgs(process.argv.slice(3))
  const get = (flag: string): string => values.get(flag) ?? fail(`missing required option ${flag}`)
  if (command === 'status') {
    process.stdout.write(await readFile(get('--status-file'), 'utf8'))
    return
  }
  if (command !== 'publish' && command !== 'check' && command !== 'watch')
    return fail('expected command: publish, check, watch, or status')
  const repoRoot = get('--repo-root')
  const workspaceRoot = get('--workspace-root')
  const plan = watchPlan(get('--buck-cell'))
  const abort = new AbortController()
  const stop = (): void => abort.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const reconciler = (request: ReconcileRequest): Promise<void> =>
    reconcileBuckViews({
      request,
      options: {
        plan,
        mode: command === 'check' ? 'check' : 'publish',
        repoRoot,
        workspaceRoot,
        buck2: get('--buck2'),
        cp: get('--cp'),
        editorViewProgram: get('--editor-view'),
        workspaceAuthority: get('--workspace-authority'),
        mv: get('--mv'),
        snapshotRetention: Number(values.get('--snapshot-retention') ?? '3'),
        signal: abort.signal,
      },
    })
  try {
    if (command === 'publish' || command === 'check') {
      const packagePaths = plan.packages.map(({ packagePath }) => packagePath)
      await reconciler({
        packagePaths,
        changedPaths: [],
        buildTargets: buildTargetsFor({ plan, packagePaths }),
      })
      return
    }
    const statusFile = get('--status-file')
    let announcedReady = false
    process.stdout.write('[buck-watch] starting\n')
    await runBuckWatchLoop({
      plan,
      signal: abort.signal,
      openChanges: () =>
        openWatchmanChanges({ watchman: get('--watchman'), repoRoot, signal: abort.signal }),
      reconcile: reconciler,
      writeStatus: async (status) => {
        await writeWatchStatus({ path: statusFile, status })
        if (status.phase === 'idle' && announcedReady === false) {
          announcedReady = true
          process.stdout.write('[buck-watch] ready\n')
        }
        if (status.phase === 'failed')
          process.stderr.write(`${status.error ?? 'reconciliation failed'}\n`)
      },
    })
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}

if (import.meta.main === true) await main()
