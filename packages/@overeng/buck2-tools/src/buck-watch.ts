#!/usr/bin/env -S bun
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Versioned identity of the machine-readable watch status file. */
export const buckWatchStatusSchema = 'effect-utils/buck-watch-status/v1' as const
/** Versioned identity of the per-package editor-view inputs manifest. */
export const editorViewInputsSchema = 'effect-utils/editor-view-inputs/v1' as const

/** One admitted package: watched sources, workspace deps, Buck targets, and editor view. */
export type BuckWatchPackage = {
  readonly sourceFiles?: readonly string[]
  readonly packagePath: string
  readonly sourceRoots: readonly string[]
  readonly workspaceDependencies: readonly string[]
  readonly targets: {
    readonly dist?: string
    readonly additionalTypechecks?: readonly string[]
    readonly packageTree: string
    readonly typecheck?: string
  }
  readonly editor?: {
    readonly cell: string
    readonly consumerCache: string
    readonly inputsManifestTarget: string
    readonly target: string
    readonly viewName: string
  }
}

/** Whole-repository watch topology: reload triggers, global invalidators, and packages. */
export type BuckWatchPlan = {
  readonly reloadPaths?: readonly string[]
  readonly reloadSuffixes?: readonly string[]
  readonly globalPaths: readonly string[]
  readonly packages: readonly BuckWatchPackage[]
}

/** Buck-reported artifact paths that one editor view is published from. */
export type EditorViewInputs = {
  readonly schema: typeof editorViewInputsSchema
  readonly editorInputs: string
  readonly packageTree: string
  readonly readRoots: readonly string[]
}

/** Externally observable watch-loop snapshot, republished on every phase change. */
export type WatchLoopStatus = {
  readonly schema: typeof buckWatchStatusSchema
  readonly pid: number
  readonly phase: 'starting' | 'reconciling' | 'idle' | 'failed' | 'stopped'
  readonly generation: number
  readonly changedPaths: readonly string[]
  readonly affectedPackages: readonly string[]
  readonly buildTargets: readonly string[]
  readonly startedAt: string
  readonly updatedAt: string
  readonly lastSuccessfulAt?: string
  readonly error?: string
}

/** Closable stream of repository-relative changed paths, batched per notification. */
export interface WatchChangeSource extends AsyncIterable<readonly string[]> {
  close(): Promise<void>
}

/** One coalesced reconciliation: affected packages, their changes, and targets to build. */
export type ReconcileRequest = {
  readonly packagePaths: readonly string[]
  readonly changedPaths: readonly string[]
  readonly buildTargets: readonly string[]
}

type RunBuckWatchLoopOptions = {
  readonly plan: BuckWatchPlan
  readonly signal: AbortSignal
  /** Establishes the subscription before startup reconciliation begins. */
  readonly openChanges: () => Promise<WatchChangeSource>
  readonly reconcile: (request: ReconcileRequest) => Promise<void>
  readonly writeStatus: (status: WatchLoopStatus) => Promise<void>
  readonly now?: () => Date
  readonly pid?: number
}

const fail = (message: string): never => {
  throw new Error(`buck watch: ${message}`)
}

const compareBytes = ({ left, right }: { left: string; right: string }): number =>
  Buffer.from(left).compare(Buffer.from(right))

const normalizedRelativePath = (value: string): string => {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
  const unsafeComponent = normalized
    .split('/')
    .some((component) => component === '' || component === '.' || component === '..')
  if (normalized.length === 0 || normalized.startsWith('/') === true || unsafeComponent === true)
    return fail(`path must be normalized and repository-relative: ${value}`)
  return normalized
}

const pathContains = ({ parent, child }: { parent: string; child: string }): boolean =>
  child === parent || child.startsWith(`${parent}/`)

const validatePlan = (plan: BuckWatchPlan): void => {
  const packagePaths = new Set<string>()
  for (const entry of plan.packages) {
    const packagePath = normalizedRelativePath(entry.packagePath)
    if (packagePath !== entry.packagePath)
      fail(`package path is not normalized: ${entry.packagePath}`)
    if (packagePaths.has(packagePath) === true) fail(`duplicate package path: ${packagePath}`)
    packagePaths.add(packagePath)
    for (const sourceRoot of entry.sourceRoots) normalizedRelativePath(sourceRoot)
    for (const sourceFile of entry.sourceFiles ?? []) normalizedRelativePath(sourceFile)
  }
  for (const entry of plan.packages)
    for (const dependency of entry.workspaceDependencies)
      if (packagePaths.has(dependency) === false)
        fail(`${entry.packagePath} has unknown workspace dependency ${dependency}`)
  for (const globalPath of plan.globalPaths) normalizedRelativePath(globalPath)
  for (const reloadPath of plan.reloadPaths ?? []) normalizedRelativePath(reloadPath)
  for (const suffix of plan.reloadSuffixes ?? [])
    if (suffix.length === 0 || suffix.includes('/') === true)
      fail(`reload suffix must be a non-empty file-name suffix: ${suffix}`)
}

const sortedUnique = (values: Iterable<string>): string[] =>
  [...new Set(values)].toSorted((left, right) => compareBytes({ left, right }))

/** Detect changes that invalidate the plan itself, which requires a watcher restart. */
export const requiresPlanReload = ({
  plan,
  changedPaths,
}: {
  readonly plan: BuckWatchPlan
  readonly changedPaths: readonly string[]
}): boolean =>
  changedPaths.some((changedPath) => {
    const changed = normalizedRelativePath(changedPath)
    return (
      (plan.reloadPaths ?? []).some((reloadPath) =>
        pathContains({ parent: reloadPath, child: changed }),
      ) || (plan.reloadSuffixes ?? []).some((suffix) => changed.endsWith(suffix))
    )
  })

/** Map source changes to their package and every reverse workspace dependent. */
export const affectedPackagePaths = ({
  plan,
  changedPaths,
}: {
  readonly plan: BuckWatchPlan
  readonly changedPaths: readonly string[]
}): readonly string[] => {
  validatePlan(plan)
  const paths = changedPaths.map(normalizedRelativePath)
  const all = paths.some((changed) =>
    plan.globalPaths.some((globalPath) => pathContains({ parent: globalPath, child: changed })),
  )
  const affected = new Set<string>()
  if (all === true) for (const entry of plan.packages) affected.add(entry.packagePath)
  else {
    for (const entry of plan.packages) {
      const roots = entry.sourceRoots.map((root) => `${entry.packagePath}/${root}`)
      const files = new Set((entry.sourceFiles ?? []).map((file) => `${entry.packagePath}/${file}`))
      const touched = paths.some(
        (changed) =>
          changed === `${entry.packagePath}/package.json` ||
          changed === `${entry.packagePath}/tsconfig.json` ||
          changed === `${entry.packagePath}/BUCK` ||
          changed === `${entry.packagePath}/BUCK.genie.ts` ||
          files.has(changed) ||
          roots.some((root) => pathContains({ parent: root, child: changed })),
      )
      if (touched === true) affected.add(entry.packagePath)
    }
  }
  let changed = true
  while (changed === true) {
    changed = false
    for (const entry of plan.packages) {
      if (
        affected.has(entry.packagePath) === false &&
        entry.workspaceDependencies.some((dependency) => affected.has(dependency)) === true
      ) {
        affected.add(entry.packagePath)
        changed = true
      }
    }
  }
  return sortedUnique(affected)
}

/** Select only targets whose products can change for the affected package closure. */
export const buildTargetsFor = ({
  plan,
  packagePaths,
}: {
  readonly plan: BuckWatchPlan
  readonly packagePaths: readonly string[]
}): readonly string[] => {
  const selected = new Set(packagePaths)
  return sortedUnique(
    plan.packages.flatMap((entry) => {
      if (selected.has(entry.packagePath) === false) return []
      return [
        ...(entry.targets.additionalTypechecks ?? []),
        ...(entry.targets.dist === undefined ? [] : [entry.targets.dist]),
        ...(entry.targets.typecheck === undefined ? [] : [entry.targets.typecheck]),
        entry.editor?.inputsManifestTarget ?? entry.targets.packageTree,
      ]
    }),
  )
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Persistent, coalescing reconciliation state machine. */
export const runBuckWatchLoop = async ({
  plan,
  signal,
  openChanges,
  reconcile,
  writeStatus,
  now = () => new Date(),
  pid = process.pid,
}: RunBuckWatchLoopOptions): Promise<void> => {
  validatePlan(plan)
  const startedAt = now().toISOString()
  let generation = 0
  let lastSuccessfulAt: string | undefined
  let status: WatchLoopStatus = {
    schema: buckWatchStatusSchema,
    pid,
    phase: 'starting',
    generation,
    changedPaths: [],
    affectedPackages: [],
    buildTargets: [],
    startedAt,
    updatedAt: startedAt,
  }
  await writeStatus(status)
  let source: WatchChangeSource
  try {
    source = await openChanges()
  } catch (error) {
    const message = errorMessage(error)
    status = {
      ...status,
      phase: signal.aborted === true ? 'stopped' : 'failed',
      updatedAt: now().toISOString(),
      ...(signal.aborted === true ? {} : { error: message }),
    }
    await writeStatus(status)
    if (signal.aborted === false) throw error
    return
  }
  const pendingPaths = new Set<string>()
  let startupPending = true
  let sourceEnded = false
  let sourceError: unknown
  let wake = Promise.withResolvers<void>()
  const notify = (): void => {
    wake.resolve()
  }
  const abortListener = (): void => notify()
  signal.addEventListener('abort', abortListener, { once: true })
  const pump = (async () => {
    try {
      for await (const batch of source) {
        for (const path of batch) pendingPaths.add(normalizedRelativePath(path))
        notify()
      }
    } catch (error) {
      sourceError = error
    } finally {
      sourceEnded = true
      notify()
    }
  })()
  const publishStatus = async ({
    phase,
    request,
    error,
  }: {
    readonly phase: WatchLoopStatus['phase']
    readonly request: ReconcileRequest
    readonly error?: string
  }): Promise<void> => {
    status = {
      schema: buckWatchStatusSchema,
      pid,
      phase,
      generation,
      changedPaths: request.changedPaths,
      affectedPackages: request.packagePaths,
      buildTargets: request.buildTargets,
      startedAt,
      updatedAt: now().toISOString(),
      ...(lastSuccessfulAt === undefined ? {} : { lastSuccessfulAt }),
      ...(error === undefined ? {} : { error }),
    }
    await writeStatus(status)
  }
  // One tick per reconciliation attempt: the first is startup, and every later one is a wake
  // raised by the pump, the abort listener, or source end. Draining this stream with
  // `for await` keeps reconciliation strictly sequential while the pump keeps accumulating
  // incoming paths, which is what coalesces a burst into a single pass.
  let startupTick = true
  const ticks: AsyncIterable<void> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<void>> => {
        if (startupTick === true) startupTick = false
        else {
          await wake.promise
          wake = Promise.withResolvers<void>()
        }
        return { done: false, value: undefined }
      },
    }),
  }
  try {
    for await (const _tick of ticks) {
      const running = signal.aborted === false && sourceEnded === false
      if (running === false) break
      const changedPaths = startupPending === true ? [] : sortedUnique(pendingPaths)
      pendingPaths.clear()
      if (changedPaths.length > 0 && requiresPlanReload({ plan, changedPaths }) === true) {
        const error = new Error(
          `watch topology changed (${changedPaths.join(', ')}); regenerate and restart the watcher`,
        )
        const request = { packagePaths: [], changedPaths, buildTargets: [] }
        await publishStatus({ phase: 'failed', request, error: error.message })
        throw error
      }
      const packagePaths =
        startupPending === true
          ? sortedUnique(plan.packages.map((entry) => entry.packagePath))
          : affectedPackagePaths({ plan, changedPaths })
      startupPending = false
      if (packagePaths.length === 0) continue
      const request = {
        packagePaths,
        changedPaths,
        buildTargets: buildTargetsFor({ plan, packagePaths }),
      }
      await publishStatus({ phase: 'reconciling', request })
      try {
        await reconcile(request)
        generation++
        lastSuccessfulAt = now().toISOString()
        await publishStatus({ phase: 'idle', request })
      } catch (error) {
        await publishStatus({ phase: 'failed', request, error: errorMessage(error) })
      }
    }
    // The stream only stops on abort or source end, so a non-aborted exit means the
    // subscription died underneath the watcher.
    if (sourceError === undefined && signal.aborted === false)
      sourceError = new Error('watch subscription ended unexpectedly')
    if (sourceError !== undefined && signal.aborted === false) {
      const request = {
        packagePaths: status.affectedPackages,
        changedPaths: status.changedPaths,
        buildTargets: status.buildTargets,
      }
      await publishStatus({ phase: 'failed', request, error: errorMessage(sourceError) })
      throw sourceError
    }
  } finally {
    signal.removeEventListener('abort', abortListener)
    await source.close()
    await pump
    if (signal.aborted === true)
      await publishStatus({
        phase: 'stopped',
        request: {
          packagePaths: status.affectedPackages,
          changedPaths: status.changedPaths,
          buildTargets: status.buildTargets,
        },
      })
  }
}

/** Captured stdout and stderr of a completed child process. */
export type CommandResult = { readonly stdout: string; readonly stderr: string }
/** Spawns a child process and resolves its captured output, rejecting on non-zero exit. */
export type RunCommand = (options: {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly detached?: boolean
  readonly signal?: AbortSignal
}) => Promise<CommandResult>

/** Default {@link RunCommand}: buffers output and fails closed on a non-zero exit. */
export const runCommand: RunCommand = ({ command, args, cwd, signal, detached }) => {
  const settled = Promise.withResolvers<CommandResult>()
  const child = spawn(command, args, {
    cwd,
    signal,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  child.once('error', settled.reject)
  child.once('close', (code, childSignal) => {
    if (code === 0) settled.resolve({ stdout, stderr })
    else
      settled.reject(
        new Error(
          `${command} exited ${code ?? `from ${childSignal ?? 'unknown signal'}`}\n${stderr || stdout}`.trim(),
        ),
      )
  })
  return settled.promise
}

const parseBuildOutputs = (stdout: string): ReadonlyMap<string, string> => {
  const outputs = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const separator = line.indexOf(' ')
    if (separator <= 0) continue
    outputs.set(line.slice(0, separator), line.slice(separator + 1).trim())
  }
  return outputs
}

const outputForTarget = ({
  outputs,
  target,
}: {
  outputs: ReadonlyMap<string, string>
  target: string
}): string => {
  const direct = outputs.get(target)
  if (direct !== undefined) return direct
  const withoutCell = target.replace(/^\/\//, '')
  const candidate = [...outputs].find(([label]) => label.endsWith(`//${withoutCell}`))
  return candidate?.[1] ?? fail(`Buck did not report an output for ${target}`)
}

const readEditorInputs = async ({
  path,
  workspaceRoot,
}: {
  path: string
  workspaceRoot: string
}): Promise<EditorViewInputs> => {
  const manifestPath = isAbsolute(path) === true ? path : join(workspaceRoot, path)
  const raw: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('schema' in raw) ||
    raw.schema !== editorViewInputsSchema ||
    !('editorInputs' in raw) ||
    typeof raw.editorInputs !== 'string' ||
    !('packageTree' in raw) ||
    typeof raw.packageTree !== 'string' ||
    !('readRoots' in raw) ||
    Array.isArray(raw.readRoots) === false ||
    raw.readRoots.every((root) => typeof root === 'string') === false
  )
    return fail(`editor inputs manifest is invalid: ${path}`)
  return {
    editorInputs: raw.editorInputs,
    schema: editorViewInputsSchema,
    packageTree: raw.packageTree,
    readRoots: raw.readRoots,
  }
}

/** Static configuration shared by every reconciliation pass of one watch plan. */
export type BuckReconcilerOptions = {
  readonly plan: BuckWatchPlan
  readonly mode: 'publish' | 'check'
  readonly repoRoot: string
  readonly workspaceRoot: string
  readonly buck2: string
  readonly editorViewProgram: string
  readonly workspaceAuthority: string
  readonly cp: string
  readonly mv: string
  readonly snapshotRetention: number
  readonly run?: RunCommand
  readonly signal?: AbortSignal
}

/** Build the affected product set, then publish each affected editor view from provider roots. */
export const reconcileBuckViews = async ({
  request,
  options,
}: {
  readonly request: ReconcileRequest
  readonly options: BuckReconcilerOptions
}): Promise<void> => {
  const execute = options.run ?? runCommand
  const built = await execute({
    command: options.buck2,
    args: ['build', ...request.buildTargets, '--show-full-output'],
    cwd: options.workspaceRoot,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const outputs = parseBuildOutputs(built.stdout)
  const selected = new Set(request.packagePaths)
  const absoluteArtifact = (path: string): string =>
    isAbsolute(path) === true ? path : resolve(options.workspaceRoot, path)
  // Publication stays strictly ordered and never overlaps: the editor-view program takes a
  // publication lock, and each manifest is read immediately before its own publication, so a
  // failure leaves every earlier view published and every later view untouched. The promise
  // chain expresses that sequence without a lexical await loop.
  await options.plan.packages.reduce(async (previous, entry) => {
    await previous
    if (selected.has(entry.packagePath) === false || entry.editor === undefined) return
    const manifestOutput = outputForTarget({
      outputs,
      target: entry.editor.inputsManifestTarget,
    })
    const manifest = await readEditorInputs({
      path: manifestOutput,
      workspaceRoot: options.workspaceRoot,
    })
    await execute({
      command: options.editorViewProgram,
      args: [
        options.mode,
        '--repo-root',
        options.repoRoot,
        '--package',
        entry.packagePath,
        '--view-name',
        entry.editor.viewName,
        '--cell',
        entry.editor.cell,
        '--target',
        entry.editor.target,
        '--editor-inputs',
        absoluteArtifact(manifest.editorInputs),
        '--node-modules',
        absoluteArtifact(manifest.editorInputs),
        ...manifest.readRoots.flatMap((root) => ['--backing-root', absoluteArtifact(root)]),
        '--cp',
        options.cp,
        '--mv',
        options.mv,
        '--workspace-authority',
        options.workspaceAuthority,
        '--consumer-cache',
        resolve(options.repoRoot, entry.editor.consumerCache),
        '--snapshot-retention',
        String(options.snapshotRetention),
      ],
      detached: true,
      cwd: options.repoRoot,
    })
  }, Promise.resolve())
}

/** Atomically replace a machine-readable status file. */
export const writeWatchStatus = async ({
  path,
  status,
}: {
  readonly path: string
  readonly status: WatchLoopStatus
}): Promise<void> => {
  const output = resolve(path)
  await mkdir(dirname(output), { recursive: true })
  const candidate = `${output}.candidate-${process.pid}`
  await writeFile(candidate, `${JSON.stringify(status)}\n`, { mode: 0o600 })
  await rename(candidate, output)
}
