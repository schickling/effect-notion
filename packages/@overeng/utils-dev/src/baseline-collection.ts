import { Buffer } from 'node:buffer'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Pure decoders and ownership resolution for the Effect 4 baseline-collection gate.
 *
 * The gate itself (`check-baseline-test-collection.ts`) owns the filesystem, Buck, and
 * reporting; everything that can be decided from bytes alone lives here so it is directly
 * testable and cannot drift between the CLI and its proof.
 */

/** Runner of one declared Buck test lane. */
export type TestRunner = 'bun' | 'shell' | 'vitest'

/** One lane of the generated `buck2-test-authority.json` bridge. */
export type TestAuthorityLane = {
  readonly collectionTarget?: string
  readonly excludes: readonly string[]
  readonly packageName: string
  readonly packagePath: string
  readonly runner: TestRunner
  readonly selectedTestFiles: readonly string[]
  readonly sourceOwners: Readonly<Record<string, string>>
  readonly target: string
  readonly taskName: string
  readonly testFiles: readonly string[]
  readonly unboundedAfter: readonly string[]
  readonly unboundedFiles: readonly string[]
  readonly unboundedTaskName?: string
}

/** Who owes evidence for one baseline file. */
export type FileOwnership =
  | {
      readonly kind: 'buck'
      readonly collectionTarget: string
      readonly packageRelative: string
    }
  | { readonly kind: 'source'; readonly taskName: string }
  | { readonly kind: 'unowned'; readonly reason: string }

/** One entry of a Vitest collection artifact. */
export type CollectedTest = { readonly file: string; readonly name: string }

/** Field-wise unknown view of one decoded JSON object; every field stays unproven. */
type RawFields<TShape> = Partial<Record<keyof TShape, unknown>>

/** Stable ordering for validated authority paths and labels without per-comparison allocation. */
// oxlint-disable-next-line overeng/named-args -- Array comparator callback contract
export const compareAuthorityStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

/** Byte ordering for arbitrary Vitest file and test names emitted by the collection runner. */
// oxlint-disable-next-line overeng/named-args -- Array comparator callback contract
export const byteCompare = (left: string, right: string): number =>
  Buffer.from(left).compare(Buffer.from(right))

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')

const isStringRecord = (value: unknown): value is Readonly<Record<string, string>> =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray(value) === false &&
  Object.values(value).every((entry) => typeof entry === 'string')

const isTestRunner = (value: unknown): value is TestRunner =>
  value === 'bun' || value === 'shell' || value === 'vitest'

/**
 * Lower bound on the registry size.
 *
 * A bridge that regenerated with lanes silently dropped would move whole packages back to
 * "no lane, so source-owned" — which is exactly the fail-open the gate exists to prevent. The
 * count is a deliberate edit, not a derived value: shrinking the registry means changing it here.
 */
export const minimumTestAuthorityLanes = 32

/** Exactly the target-name shape the Buck projection accepts; keep in lockstep with it. */
const testTargetNamePattern = /^[a-z][a-z0-9_]*$/

/** Normalized relative path: non-empty, no backslash, no absolute, `.`, `..`, or empty segment. */
const isNormalizedRelativePath = (value: string) =>
  value.length > 0 &&
  value.includes('\\') === false &&
  isAbsolute(value) === false &&
  value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')

/** Contract violations of one decoded lane, in declaration order. */
const laneConformanceIssues = (lane: TestAuthorityLane): readonly string[] => {
  const labelPrefix = `effect_utils//${lane.packagePath}:`
  const targetName =
    lane.target.startsWith(labelPrefix) === true ? lane.target.slice(labelPrefix.length) : undefined
  const expectedTaskName =
    targetName === undefined || targetName === 'test'
      ? `test:${lane.packageName}`
      : `test:${lane.packageName}:${targetName}`
  const issues: string[] = []
  if (isNormalizedRelativePath(lane.packagePath) === false) {
    issues.push(`packagePath ${JSON.stringify(lane.packagePath)} is not a normalized relative path`)
  }
  if (lane.packageName !== lane.packagePath.split('/').at(-1)) {
    issues.push(
      `packageName ${JSON.stringify(lane.packageName)} is not the last segment of ${lane.packagePath}`,
    )
  }
  if (targetName === undefined || testTargetNamePattern.test(targetName) === false) {
    issues.push(
      `target ${lane.target} is not \`${labelPrefix}<name>\` with a ${String(testTargetNamePattern)} name`,
    )
  }
  if (lane.taskName !== expectedTaskName) {
    issues.push(`taskName ${lane.taskName} is not the derived ${expectedTaskName}`)
  }
  const lists = [
    ['testFiles', lane.testFiles],
    ['selectedTestFiles', lane.selectedTestFiles],
    ['excludes', lane.excludes],
    ['unboundedFiles', lane.unboundedFiles],
  ] as const
  for (const [name, files] of lists) {
    for (const file of files) {
      if (isNormalizedRelativePath(file) === false) {
        issues.push(`${name} contains non-normalized path ${JSON.stringify(file)}`)
      }
    }
    if (new Set(files).size !== files.length) issues.push(`${name} contains a duplicate`)
    if (
      files.toSorted(compareAuthorityStrings).some((file, index) => file !== files[index]) === true
    ) {
      issues.push(`${name} is not byte-sorted`)
    }
  }
  if (lane.testFiles.length === 0) issues.push('testFiles is empty')
  if (lane.selectedTestFiles.length === 0) issues.push('selectedTestFiles is empty')
  const testFiles = new Set(lane.testFiles)
  if (lane.selectedTestFiles.some((file) => testFiles.has(file) === false) === true) {
    issues.push('selectedTestFiles contains a file outside testFiles')
  }
  const selected = new Set(lane.selectedTestFiles)
  if (lane.excludes.some((file) => selected.has(file) === false) === true) {
    issues.push('excludes contains a file outside selectedTestFiles')
  }
  const excluded = new Set(lane.excludes)
  const sourceFiles = lane.testFiles.filter(
    (file) => selected.has(file) === false || excluded.has(file) === true,
  )
  const sourceFileSet = new Set(sourceFiles)
  for (const [file, owner] of Object.entries(lane.sourceOwners)) {
    if (isNormalizedRelativePath(file) === false || sourceFileSet.has(file) === false) {
      issues.push(`sourceOwners key ${JSON.stringify(file)} is not a source-owned test file`)
    }
    if (/^[a-z0-9][a-z0-9:-]*$/.test(owner) === false) {
      issues.push(`sourceOwners task ${JSON.stringify(owner)} is unsafe`)
    }
  }
  const expectedUnboundedFiles = sourceFiles.filter((file) => lane.sourceOwners[file] === undefined)
  if (
    expectedUnboundedFiles.length !== lane.unboundedFiles.length ||
    expectedUnboundedFiles.some((file, index) => file !== lane.unboundedFiles[index]) === true
  ) {
    issues.push('unboundedFiles is not the source census minus explicit sourceOwners')
  }
  if ((lane.unboundedTaskName !== undefined) !== lane.unboundedFiles.length > 0) {
    issues.push('unboundedTaskName must be declared exactly when unboundedFiles is non-empty')
  }
  if (new Set(lane.unboundedAfter).size !== lane.unboundedAfter.length) {
    issues.push('unboundedAfter contains a duplicate')
  }
  if (lane.unboundedAfter.some((task) => /^[a-z0-9][a-z0-9:-]*$/.test(task) === false) === true) {
    issues.push('unboundedAfter contains an unsafe task name')
  }
  if (lane.unboundedFiles.length === 0 && lane.unboundedAfter.length > 0) {
    issues.push('unboundedAfter is non-empty without an unbounded complement')
  }
  if (
    lane.unboundedTaskName !== undefined &&
    lane.unboundedTaskName !== `${lane.taskName}:unbounded`
  ) {
    issues.push(`unboundedTaskName ${lane.unboundedTaskName} is not ${lane.taskName}:unbounded`)
  }
  if (lane.runner === 'vitest' && lane.collectionTarget !== `${lane.target}_collect`) {
    issues.push(
      `vitest lane must declare collectionTarget ${lane.target}_collect, not ${String(lane.collectionTarget)}`,
    )
  }
  if (lane.runner !== 'vitest' && lane.collectionTarget !== undefined) {
    issues.push(`${lane.runner} lane must not declare a collectionTarget`)
  }
  return issues
}

/**
 * Decodes the generated bridge, throwing on anything the contract does not allow.
 *
 * Beyond field types this enforces the derivations the generator promises — label, task and
 * collection-target shape, exclusion/complement duality, registry ordering and uniqueness, and
 * the lane-count floor — so a bridge that regenerated wrong fails here instead of quietly
 * moving suites out of Buck's ownership.
 *
 * `sourceLabel` only names the file in error messages; decoding never reads it.
 */
export const decodeTestAuthority = ({
  decoded,
  sourceLabel,
}: {
  readonly decoded: unknown
  readonly sourceLabel: string
}): readonly TestAuthorityLane[] => {
  const { lanes: rawLanes, schemaVersion } = (decoded ?? {}) as RawFields<{
    lanes: unknown
    schemaVersion: unknown
  }>
  if (schemaVersion !== 2) {
    throw new Error(`${sourceLabel} is not a schemaVersion 2 test authority`)
  }
  if (Array.isArray(rawLanes) === false) {
    throw new Error(`${sourceLabel} has no lanes array`)
  }
  const lanes = rawLanes.map((value: unknown, index: number): TestAuthorityLane => {
    if (typeof value !== 'object' || value === null || Array.isArray(value) === true) {
      throw new Error(`${sourceLabel}: lanes[${index}] is not an object`)
    }
    const {
      collectionTarget,
      excludes,
      packageName,
      packagePath,
      runner,
      selectedTestFiles,
      sourceOwners,
      target,
      taskName,
      testFiles,
      unboundedAfter,
      unboundedFiles,
      unboundedTaskName,
    } = value as RawFields<TestAuthorityLane>
    if (
      typeof packageName !== 'string' ||
      typeof packagePath !== 'string' ||
      typeof target !== 'string' ||
      typeof taskName !== 'string' ||
      isTestRunner(runner) === false ||
      isStringArray(excludes) === false ||
      isStringArray(selectedTestFiles) === false ||
      isStringRecord(sourceOwners) === false ||
      isStringArray(testFiles) === false ||
      isStringArray(unboundedAfter) === false ||
      isStringArray(unboundedFiles) === false ||
      (collectionTarget !== undefined && typeof collectionTarget !== 'string') ||
      (unboundedTaskName !== undefined && typeof unboundedTaskName !== 'string')
    ) {
      throw new Error(`${sourceLabel}: lanes[${index}] does not match the test-authority schema`)
    }
    return Object.assign(
      {
        excludes,
        packageName,
        packagePath,
        runner,
        selectedTestFiles,
        sourceOwners,
        target,
        taskName,
        testFiles,
        unboundedAfter,
        unboundedFiles,
      },
      collectionTarget === undefined ? {} : { collectionTarget },
      unboundedTaskName === undefined ? {} : { unboundedTaskName },
    )
  })

  const issues = lanes.flatMap((lane, index) =>
    laneConformanceIssues(lane).map((issue) => `lanes[${index}] (${lane.target}): ${issue}`),
  )
  if (lanes.length < minimumTestAuthorityLanes) {
    issues.push(
      `registry declares ${lanes.length} lanes, fewer than the ${minimumTestAuthorityLanes} it must carry`,
    )
  }
  const targets = lanes.map(({ target }) => target)
  if (
    targets.some(
      (target, index) => index > 0 && compareAuthorityStrings(targets[index - 1]!, target) >= 0,
    ) === true
  ) {
    issues.push('lanes are not byte-sorted by target, or declare a duplicate target')
  }
  const packagePaths = lanes.map(({ packagePath }) => packagePath)
  if (new Set(packagePaths).size !== packagePaths.length) {
    issues.push('more than one lane per package is not supported')
  }
  for (const parent of lanes) {
    const child = lanes.find(
      (candidate) =>
        candidate !== parent && candidate.packagePath.startsWith(`${parent.packagePath}/`),
    )
    if (child !== undefined) {
      issues.push(
        `nested lane packages are not supported: ${parent.packagePath} contains ${child.packagePath}`,
      )
      break
    }
  }
  const taskNames = lanes.flatMap(({ taskName, unboundedTaskName }) =>
    unboundedTaskName === undefined ? [taskName] : [taskName, unboundedTaskName],
  )
  if (new Set(taskNames).size !== taskNames.length) {
    issues.push('lanes declare a duplicate task name')
  }
  const collectionTargets = lanes.flatMap(({ collectionTarget }) =>
    collectionTarget === undefined ? [] : [collectionTarget],
  )
  if (new Set(collectionTargets).size !== collectionTargets.length) {
    issues.push('lanes declare a duplicate collection target')
  }
  if (issues.length > 0) {
    throw new Error(`${sourceLabel} is not a conformant test authority:\n  ${issues.join('\n  ')}`)
  }
  return lanes
}

/**
 * Resolves which evidence owes proof for one repository-relative test file.
 *
 * Every admitted lane records its complete test census, exact bounded selection,
 * exceptional source owners, and derived source complement. The decoder rejects duplicate
 * and nested lane paths, so the result has one possible owner.
 */
export const ownershipForFile = ({
  file,
  lanes,
}: {
  readonly file: string
  readonly lanes: readonly TestAuthorityLane[]
}): FileOwnership => {
  const lane = lanes.find(({ packagePath }) => file.startsWith(`${packagePath}/`))
  if (lane === undefined) {
    // A package the Buck registry does not carry keeps its conventional source task.
    const packageDirectory = /^packages\/@overeng\/([^/]+)\//.exec(file)?.[1]
    return packageDirectory === undefined
      ? { kind: 'unowned', reason: 'this baseline file is outside the packages/@overeng layout' }
      : { kind: 'source', taskName: `test:${packageDirectory}` }
  }
  const packageRelative = file.slice(lane.packagePath.length + 1)
  if (lane.testFiles.includes(packageRelative) === false) {
    return {
      kind: 'unowned',
      reason: `lane ${lane.target} does not record this file in its test census`,
    }
  }
  if (
    lane.selectedTestFiles.includes(packageRelative) === true &&
    lane.excludes.includes(packageRelative) === false
  ) {
    if (lane.runner !== 'vitest' || lane.collectionTarget === undefined) {
      return {
        kind: 'unowned',
        reason: `lane ${lane.target} is a bounded ${lane.runner} lane with no collection target, so this baseline file has no collection evidence`,
      }
    }
    return { kind: 'buck', collectionTarget: lane.collectionTarget, packageRelative }
  }
  const sourceOwner = lane.sourceOwners[packageRelative]
  if (sourceOwner !== undefined) return { kind: 'source', taskName: sourceOwner }
  return lane.unboundedTaskName === undefined
    ? {
        kind: 'unowned',
        reason: `lane ${lane.target} records this file as source-owned but declares no owner`,
      }
    : { kind: 'source', taskName: lane.unboundedTaskName }
}

/**
 * Parses `buck2 build --show-output` into label -> project-relative artifact path.
 *
 * A line that is not exactly `<label> <path>` means the target produced no single default
 * output, so it is an error rather than a silently skipped label.
 */
export const parseShowOutput = (
  stdout: string,
): { readonly artifacts: ReadonlyMap<string, string> } | { readonly error: string } => {
  const artifacts = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const fields = trimmed.split(/\s+/)
    if (fields.length !== 2) {
      return { error: `buck2 --show-output line is not "<label> <path>": ${trimmed}` }
    }
    const [label, artifact] = fields as [string, string]
    if (artifacts.has(label) === true) {
      return { error: `buck2 --show-output reported ${label} twice` }
    }
    artifacts.set(label, artifact)
  }
  return { artifacts }
}

/** Decodes one versioned Vitest collection artifact, rejecting malformed or unsorted bytes. */
export const decodeCollectionArtifact = ({
  artifactPath,
  decoded,
}: {
  readonly artifactPath: string
  readonly decoded: unknown
}): { readonly tests: readonly CollectedTest[] } | { readonly error: string } => {
  const { schemaVersion, tests: rawTests } = (decoded ?? {}) as RawFields<{
    schemaVersion: unknown
    tests: unknown
  }>
  if (schemaVersion !== 1) {
    return { error: `${artifactPath} is not a schemaVersion 1 collection artifact` }
  }
  if (Array.isArray(rawTests) === false) {
    return { error: `${artifactPath} has no tests array` }
  }
  const tests: CollectedTest[] = []
  for (const [index, entry] of rawTests.entries()) {
    const { file, name } = (entry ?? {}) as RawFields<CollectedTest>
    if (typeof file !== 'string' || typeof name !== 'string') {
      return { error: `${artifactPath}: tests[${index}] is not a { file, name } record` }
    }
    if (isNormalizedRelativePath(file) === false) {
      return {
        error: `${artifactPath}: tests[${index}].file ${JSON.stringify(file)} is not a normalized package-relative path`,
      }
    }
    const previous = tests.at(-1)
    if (previous !== undefined) {
      const fileOrder = byteCompare(previous.file, file)
      if (fileOrder > 0 || (fileOrder === 0 && byteCompare(previous.name, name) > 0)) {
        return {
          error: `${artifactPath}: tests are not byte-sorted by file then name at index ${index}`,
        }
      }
    }
    tests.push({ file, name })
  }
  return { tests }
}

/** Counts collected tests per package-relative file. */
export const countCollectedTests = (
  tests: readonly CollectedTest[],
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>()
  for (const test of tests) counts.set(test.file, (counts.get(test.file) ?? 0) + 1)
  return counts
}

/** Devenv's retained-report filename stem for a task name. */
export const taskFileStem = (taskName: string): string =>
  taskName.replaceAll(':', '-').replaceAll('/', '-').replaceAll(' ', '-').replaceAll('.', '_')

/** Maps a Vitest report's file name back to a repository-relative path, or `undefined`. */
export const repoPathFromReportName = ({
  name,
  root,
}: {
  readonly name: string
  readonly root: string
}): string | undefined => {
  const normalizedName = name.replaceAll('\\', '/')
  const absolute =
    isAbsolute(name) === true
      ? name
      : normalizedName.startsWith('packages/') === true
        ? resolve(root, normalizedName)
        : undefined
  if (absolute === undefined) return undefined
  const repoPath = relative(root, absolute).split(sep).join('/')
  return repoPath.startsWith('../') === true ? undefined : repoPath
}
