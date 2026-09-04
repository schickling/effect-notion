/**
 * Effect 4 baseline-collection proof over declared Buck build outputs.
 *
 * Buck owns test execution, and a cached test execution does not run: nothing observable is
 * produced by a cache hit, so collection proof can never be a side effect of running the suite.
 * Each managed Vitest target therefore has a companion `vitest_collect` build target whose
 * declared output is a `vitest list --json` artifact. `buck2 build --show-json-output` names the
 * exact output path per target, and that manifest plus the task registry are the only inputs of
 * this gate: an artifact materializes on a cache hit exactly as it does on a cold runner.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/** One managed Buck Vitest task, the package it owns, and its companion collection target. */
export type TestTaskRegistration = {
  readonly packagePath: string
  readonly taskName: string
  readonly collectionTarget: string
}

/** `buck2 build --show-json-output`: target label -> project-relative declared output path. */
export type BuildOutputManifest = Readonly<Record<string, string>>

/** One entry of a `vitest list --json` artifact: a test name and its absolute source file. */
export type CollectionEntry = {
  readonly name: string
  readonly file: string
}

/** A discovered baseline test file and the managed task that owns it, when one does. */
export type BaselineFile = {
  readonly file: string
  readonly registration: TestTaskRegistration | undefined
}

/** Verdict for one baseline file: the collection evidence, or why the proof failed. */
export type FileResult =
  | {
      readonly collectedTests: number
      readonly evidence: string
      readonly file: string
      readonly taskName: string
    }
  | {
      readonly collectedTests?: number
      readonly error: string
      readonly file: string
      readonly taskName?: string
    }

/** Decodes one registry entry, or `undefined` when it does not name the complete linkage. */
export const decodeTaskRegistration = (value: unknown): TestTaskRegistration | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const packagePath = 'packagePath' in value ? value.packagePath : undefined
  const taskName = 'taskName' in value ? value.taskName : undefined
  const collectionTarget = 'collectionTarget' in value ? value.collectionTarget : undefined
  if (
    typeof packagePath !== 'string' ||
    typeof taskName !== 'string' ||
    typeof collectionTarget !== 'string' ||
    packagePath.length === 0 ||
    taskName.length === 0 ||
    collectionTarget.length === 0
  ) {
    return undefined
  }
  return { collectionTarget, packagePath, taskName }
}

/** Decodes the whole registry, or `undefined` when any entry is incomplete. */
export const decodeTaskRegistry = (value: unknown): readonly TestTaskRegistration[] | undefined => {
  if (Array.isArray(value) === false) return undefined
  const decoded = value.map((entry: unknown) => decodeTaskRegistration(entry))
  const complete = decoded.filter((entry): entry is TestTaskRegistration => entry !== undefined)
  return complete.length === decoded.length ? complete : undefined
}

/** Decodes `buck2 build --show-json-output`, or `undefined` when it is not a label->path map. */
export const decodeBuildOutputManifest = (value: unknown): BuildOutputManifest | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value) === true) return undefined
  const entries = Object.entries(value)
  return entries.every(([, output]) => typeof output === 'string' && output.length > 0) === true
    ? (Object.fromEntries(entries) as BuildOutputManifest)
    : undefined
}

const decodeCollectionEntries = (value: unknown): readonly CollectionEntry[] | undefined => {
  if (Array.isArray(value) === false) return undefined
  const decoded = value.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return undefined
    const name = 'name' in entry ? entry.name : undefined
    const file = 'file' in entry ? entry.file : undefined
    return typeof name === 'string' && typeof file === 'string'
      ? ({ file, name } satisfies CollectionEntry)
      : undefined
  })
  const complete = decoded.filter((entry): entry is CollectionEntry => entry !== undefined)
  return complete.length === decoded.length ? complete : undefined
}

type TaskArtifact =
  | { readonly entries: readonly CollectionEntry[]; readonly output: string }
  | { readonly error: string }

const readTaskArtifact = async ({
  registration,
  manifest,
  workspaceRoot,
}: {
  readonly registration: TestTaskRegistration
  readonly manifest: BuildOutputManifest
  readonly workspaceRoot: string
}): Promise<TaskArtifact> => {
  const output = manifest[registration.collectionTarget]
  if (output === undefined) {
    return {
      error: `the Buck build manifest declares no output for ${registration.collectionTarget} (task ${registration.taskName}); ${Object.keys(manifest).length} targets were built`,
    }
  }
  let text: string
  try {
    text = await readFile(resolve(workspaceRoot, output), 'utf8')
  } catch (cause) {
    return {
      error: `the declared output ${output} of ${registration.collectionTarget} is not readable: ${String(cause)}`,
    }
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(text)
  } catch (cause) {
    return { error: `${output} is not valid JSON: ${String(cause)}` }
  }
  const entries = decodeCollectionEntries(decoded)
  if (entries === undefined) {
    return { error: `${output} is not a vitest list --json array of {name, file} entries` }
  }
  return { entries, output }
}

const evaluateTask = async ({
  files,
  manifest,
  registration,
  workspaceRoot,
}: {
  readonly files: readonly string[]
  readonly manifest: BuildOutputManifest
  readonly registration: TestTaskRegistration
  readonly workspaceRoot: string
}): Promise<readonly FileResult[]> => {
  const artifact = await readTaskArtifact({ manifest, registration, workspaceRoot })
  if ('error' in artifact) {
    return files.map((file) => ({ error: artifact.error, file, taskName: registration.taskName }))
  }
  const { entries, output } = artifact
  if (entries.length === 0) {
    return files.map((file) => ({
      collectedTests: 0,
      error: `${output} reports zero collected tests for task ${registration.taskName}`,
      file,
      taskName: registration.taskName,
    }))
  }
  return files.map((file): FileResult => {
    // The artifact is written from inside the Buck package view, so its paths are absolute under
    // a materialized tree whose root is not knowable here. The package-relative remainder is, and
    // it is unique inside a package view, so the entry path is matched by that exact suffix.
    const suffix = `/${file.slice(registration.packagePath.length + 1)}`
    const collectedTests = entries.filter(
      (entry) => entry.file.replaceAll('\\', '/').endsWith(suffix) === true,
    ).length
    if (collectedTests === 0) {
      return {
        collectedTests,
        error: `${output} does not contain this baseline file (${entries.length} tests collected across task ${registration.taskName})`,
        file,
        taskName: registration.taskName,
      }
    }
    return {
      collectedTests,
      evidence: `${registration.collectionTarget} -> ${output}`,
      file,
      taskName: registration.taskName,
    }
  })
}

/** Proves every baseline file was collected by its registered task's declared Buck output. */
export const evaluateBaselineCollection = async ({
  baselineFiles,
  manifest,
  workspaceRoot,
}: {
  readonly baselineFiles: readonly BaselineFile[]
  readonly manifest: BuildOutputManifest
  readonly workspaceRoot: string
}): Promise<readonly FileResult[]> => {
  const unregistered: readonly FileResult[] = baselineFiles
    .filter(({ registration }) => registration === undefined)
    .map(({ file }) => ({
      error: 'no registered managed test task owns this baseline file',
      file,
    }))
  const registeredFiles = baselineFiles.filter(
    (baseline): baseline is BaselineFile & { readonly registration: TestTaskRegistration } =>
      baseline.registration !== undefined,
  )
  const registered = (
    await Promise.all(
      [...Map.groupBy(registeredFiles, ({ registration }) => registration.taskName).values()].map(
        (group) =>
          evaluateTask({
            files: group.map(({ file }) => file),
            manifest,
            registration: group[0]!.registration,
            workspaceRoot,
          }),
      ),
    )
  ).flat()
  return [...unregistered, ...registered].toSorted((left, right) =>
    left.file.localeCompare(right.file),
  )
}
