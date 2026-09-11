#!/usr/bin/env bun

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, readFile, readdir } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import {
  compareAuthorityStrings,
  countCollectedTests,
  decodeCollectionArtifact,
  decodeTestAuthority,
  ownershipForFile,
  parseShowOutput,
  repoPathFromReportName,
  taskFileStem,
  type FileOwnership,
} from './baseline-collection.ts'

/**
 * Effect 4 baseline-collection gate.
 *
 * Every package test file must have exactly one recorded owner, and every bounded Vitest lane's
 * collection artifact must cover its recorded selection exactly. Baseline and cross-major files
 * additionally must contribute at least one collected test to their owner's evidence:
 *
 *   - a selected file not listed in `excludes` is BOUND by the lane's collection artifact;
 *   - an unselected or excluded file is SOURCE-owned by either its explicit `sourceOwners`
 *     record or the lane's exact derived complement task;
 *   - a file in a package with no lane is SOURCE-owned by the conventional package test task.
 *
 * Every step fails closed: filesystem/registry drift, config selection drift, an unbuildable
 * target, malformed collection output, and missing source reports all fail the gate.
 */

type BaselineFile = {
  readonly file: string
  readonly ownership: FileOwnership
}

type FileResult =
  | {
      readonly collectedTests: number
      readonly evidence: string
      readonly file: string
    }
  | {
      readonly collectedTests?: number
      readonly error: string
      readonly file: string
    }

type VitestFileResult = {
  readonly assertionResults?: unknown
  readonly name?: unknown
}

const argumentValue = (name: string) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'))

const testFilePattern = /\.(?:test|spec)\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/
const discoverTestFiles = async ({
  directory,
  prefix,
}: {
  readonly directory: string
  readonly prefix: string
}): Promise<readonly string[]> =>
  (
    await Promise.all(
      (
        await readdir(directory, { withFileTypes: true })
      ).map((entry) => {
        const relativePath = `${prefix}/${entry.name}`
        if (entry.isDirectory() === true) {
          return discoverTestFiles({
            directory: resolve(directory, entry.name),
            prefix: relativePath,
          })
        }
        return entry.isFile() === true && testFilePattern.test(entry.name) === true
          ? [relativePath]
          : []
      }),
    )
  ).flat()

const root = resolve(argumentValue('--root') ?? process.cwd())
const reportDirectory = resolve(root, argumentValue('--report-dir') ?? 'tmp/otel-scrape/summaries')
const authorityPath = resolve(root, argumentValue('--authority') ?? 'buck2-test-authority.json')
const buck2Bin = argumentValue('--buck2')
if (buck2Bin === undefined) {
  throw new Error('--buck2 is required (pass the pinned workspace Buck binary)')
}
// Buck runs from the composed workspace root and reports project-relative artifact paths.
const buck2Cwd = resolve(argumentValue('--buck2-cwd') ?? resolve(root, '..', '..'))
const targetPlatform = 'effect_utils//buck2/platforms:host_platform'

if (existsSync(authorityPath) === false) {
  throw new Error(`${authorityPath} is missing; run \`devenv tasks run genie:run\``)
}
const lanes = decodeTestAuthority({
  decoded: await readJson(authorityPath),
  sourceLabel: authorityPath,
})

const testFiles = [
  ...(await discoverTestFiles({
    directory: resolve(root, 'packages/@overeng'),
    prefix: 'packages/@overeng',
  })),
]
testFiles.sort(compareAuthorityStrings)

const authorityCensusErrors = lanes.flatMap((lane) => {
  const prefix = `${lane.packagePath}/`
  const filesystem = testFiles
    .filter((file) => file.startsWith(prefix))
    .map((file) => file.slice(prefix.length))
  const recorded = new Set(lane.testFiles)
  const discovered = new Set(filesystem)
  return [
    ...filesystem
      .filter((file) => recorded.has(file) === false)
      .map((file) => `${lane.target} does not record discovered test file ${file}`),
    ...lane.testFiles
      .filter((file) => discovered.has(file) === false)
      .map((file) => `${lane.target} records missing test file ${file}`),
  ]
})

const testFileSources = await Promise.all(
  testFiles.map(async (file) => [file, await readFile(resolve(root, file), 'utf8')] as const),
)

const baselineDescribePattern =
  /(?:^|[^\w$])(?:[A-Za-z_$][\w$]*\.)?describe(?:\.\w+)*\s*\(\s*(['"`])((?:(?!\1)[\s\S])*?)\1/g

const baselineFiles: readonly BaselineFile[] = testFileSources
  .filter(([, source]) =>
    Array.from(source.matchAll(baselineDescribePattern)).some((match) =>
      /(?:baseline|cross-major)/i.test(match[2] ?? ''),
    ),
  )
  .map(([file]): BaselineFile => ({ file, ownership: ownershipForFile({ file, lanes }) }))
  .toSorted((left, right) => compareAuthorityStrings(left.file, right.file))

// --- Buck-owned evidence -----------------------------------------------------------------

const buckFiles = baselineFiles.filter(
  (
    entry,
  ): entry is BaselineFile & { readonly ownership: Extract<FileOwnership, { kind: 'buck' }> } =>
    entry.ownership.kind === 'buck',
)
// EVERY declared collection target, not just the ones a baseline file happens to need: a lane
// whose inventory stopped building or started emitting garbage is a hole in the bounded
// evidence even while no baseline file sits in it today.
const collectionTargets = [
  ...new Set(
    lanes.flatMap(({ collectionTarget }) =>
      collectionTarget === undefined ? [] : [collectionTarget],
    ),
  ),
].toSorted(compareAuthorityStrings)

/** Builds every needed collection target in ONE Buck invocation. */
const buildCollectionArtifacts = async (): Promise<
  { readonly artifacts: ReadonlyMap<string, string> } | { readonly error: string }
> => {
  const proc = spawn(
    buck2Bin,
    [
      'build',
      '--show-output',
      '--target-platforms',
      targetPlatform,
      '--local-only',
      ...collectionTargets,
    ],
    { cwd: buck2Cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  proc.stdout.on('data', (chunk: string) => {
    stdout += chunk
  })
  proc.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    proc.once('error', reject)
    proc.once('close', (code) => resolveExit(code ?? 1))
  })
  if (exitCode !== 0) {
    const tail = stderr.trimEnd().split('\n').slice(-20).join(' | ')
    return { error: `buck2 build exited ${exitCode}: ${tail}` }
  }
  return parseShowOutput(stdout)
}

/** Per collection target: the per-file counts, or the reason there are none. */
const countsByTarget = new Map<string, ReadonlyMap<string, number> | string>()
const collectionBuildError = await (async () => {
  if (collectionTargets.length === 0) return undefined
  const built = await buildCollectionArtifacts()
  if ('error' in built) return built.error

  await Promise.all(
    collectionTargets.map(async (target) => {
      const projectRelative = built.artifacts.get(target)
      if (projectRelative === undefined) {
        countsByTarget.set(target, `buck2 --show-output reported no artifact for ${target}`)
        return
      }
      const artifactPath = resolve(buck2Cwd, projectRelative)
      if (existsSync(artifactPath) === false) {
        countsByTarget.set(target, `${target} collection artifact ${artifactPath} does not exist`)
        return
      }
      let decoded: unknown
      try {
        decoded = await readJson(artifactPath)
      } catch (cause) {
        countsByTarget.set(target, `${artifactPath} is not valid JSON: ${String(cause)}`)
        return
      }
      const artifact = decodeCollectionArtifact({ artifactPath, decoded })
      countsByTarget.set(
        target,
        'error' in artifact ? artifact.error : countCollectedTests(artifact.tests),
      )
    }),
  )
  return undefined
})()

/** Collection targets with no usable or selection-complete inventory. */
const collectionArtifactErrors: readonly string[] =
  collectionBuildError === undefined
    ? collectionTargets.flatMap((target) => {
        const counts = countsByTarget.get(target)
        return typeof counts === 'string' ? [counts] : []
      })
    : [collectionBuildError]
const collectionCoverageErrors = lanes.flatMap((lane) => {
  if (lane.collectionTarget === undefined) return []
  const counts = countsByTarget.get(lane.collectionTarget)
  if (counts === undefined || typeof counts === 'string') return []
  const expected = lane.selectedTestFiles.filter((file) => lane.excludes.includes(file) === false)
  const actual = [...counts.keys()].toSorted(compareAuthorityStrings)
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  return expected
    .filter((file) => actualSet.has(file) === false)
    .map((file) => `${lane.collectionTarget} did not collect bounded test file ${file}`)
    .concat(
      actual
        .filter((file) => expectedSet.has(file) === false)
        .map((file) => `${lane.collectionTarget} collected unowned test file ${file}`),
    )
})
const collectionErrors: readonly string[] = [
  ...authorityCensusErrors,
  ...collectionArtifactErrors,
  ...collectionCoverageErrors,
]

const buckResults: readonly FileResult[] = buckFiles.map(({ file, ownership }): FileResult => {
  if (collectionBuildError !== undefined) return { error: collectionBuildError, file }
  const counts = countsByTarget.get(ownership.collectionTarget)
  if (counts === undefined || typeof counts === 'string') {
    return { error: counts ?? `no collection result for ${ownership.collectionTarget}`, file }
  }
  const collectedTests = counts.get(ownership.packageRelative)
  const targetTests = [...counts.values()].reduce((sum, count) => sum + count, 0)
  if (collectedTests === undefined) {
    return {
      error: `${ownership.collectionTarget} collected no tests from this baseline file (${targetTests} collected from other files)`,
      file,
    }
  }
  if (collectedTests === 0) {
    return {
      collectedTests,
      error: `${ownership.collectionTarget} reports zero collected tests for this baseline file (${targetTests} collected across the lane)`,
      file,
    }
  }
  return { collectedTests, evidence: ownership.collectionTarget, file }
})

// --- Source-owned evidence ---------------------------------------------------------------

const readTaskResults = async ({
  files,
  taskName,
}: {
  readonly files: readonly string[]
  readonly taskName: string
}): Promise<readonly FileResult[]> => {
  const report = resolve(reportDirectory, `${taskFileStem(taskName)}.vitest.json`)
  if (existsSync(report) === false) {
    return files.map((file) => ({
      error: `missing exact report ${basename(report)} for source-owned task ${taskName}`,
      file,
    }))
  }

  let decoded: { readonly testResults?: unknown }
  try {
    decoded = (await readJson(report)) as { readonly testResults?: unknown }
  } catch (cause) {
    return files.map((file) => ({
      error: `${basename(report)} is not valid JSON: ${String(cause)}`,
      file,
    }))
  }

  const testResults =
    Array.isArray(decoded.testResults) === true
      ? (decoded.testResults as readonly VitestFileResult[])
      : undefined
  if (testResults === undefined) {
    return files.map((file) => ({
      error: `${basename(report)} has no testResults array`,
      file,
    }))
  }

  const collectedByFile = new Map<string, number>()
  for (const testResult of testResults) {
    if (
      typeof testResult.name !== 'string' ||
      Array.isArray(testResult.assertionResults) === false
    ) {
      continue
    }
    const file = repoPathFromReportName({ name: testResult.name, root })
    if (file === undefined) continue
    collectedByFile.set(file, (collectedByFile.get(file) ?? 0) + testResult.assertionResults.length)
  }
  const reportTests = [...collectedByFile.values()].reduce((sum, count) => sum + count, 0)

  return files.map((file): FileResult => {
    const collectedTests = collectedByFile.get(file)
    if (collectedTests === undefined) {
      return {
        error: `${basename(report)} does not contain this baseline file (${reportTests} tests collected from other files)`,
        file,
      }
    }
    if (collectedTests === 0) {
      return {
        collectedTests,
        error: `${basename(report)} reports zero collected tests for this baseline file (${reportTests} tests collected across the source task)`,
        file,
      }
    }
    return { collectedTests, evidence: basename(report), file }
  })
}

const unownedResults: readonly FileResult[] = baselineFiles
  .filter((entry) => entry.ownership.kind === 'unowned')
  .map(({ file, ownership }) => ({
    error: ownership.kind === 'unowned' ? ownership.reason : 'unowned',
    file,
  }))

const filesByTask = Map.groupBy(
  baselineFiles.filter(
    (
      entry,
    ): entry is BaselineFile & { readonly ownership: Extract<FileOwnership, { kind: 'source' }> } =>
      entry.ownership.kind === 'source',
  ),
  ({ ownership }) => ownership.taskName,
)
const sourceResults = (
  await Promise.all(
    [...filesByTask].map(([taskName, entries]) =>
      readTaskResults({ files: entries.map(({ file }) => file), taskName }),
    ),
  )
).flat()

const results = [...unownedResults, ...sourceResults, ...buckResults].toSorted((left, right) =>
  left.file.localeCompare(right.file),
)
const failed = results.filter((result) => 'error' in result)

for (const result of results) {
  if ('error' in result) {
    console.error(`FAIL ${result.file}: ${result.error}`)
  } else {
    console.log(`PASS ${result.file}: collectedTests=${result.collectedTests} (${result.evidence})`)
  }
}

for (const error of collectionErrors) {
  console.error(`FAIL collection: ${error}`)
}

const markdownCell = (value: string) =>
  value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', ' ')

const appendGitHubStepSummary = async () => {
  const stepSummary = process.env.GITHUB_STEP_SUMMARY
  if (stepSummary === undefined || stepSummary.length === 0) return

  const rows = results.map((result) => {
    const collectedTests =
      typeof result.collectedTests === 'number' ? String(result.collectedTests) : '-'
    const evidence = 'error' in result ? `FAIL: ${result.error}` : `PASS: ${result.evidence}`
    return `| ${markdownCell(result.file)} | ${collectedTests} | ${markdownCell(evidence)} |`
  })
  const table = [
    '## Effect 4 baseline test collection',
    '',
    '| Baseline file | Collected tests | Evidence |',
    '| --- | ---: | --- |',
    ...rows,
    '',
    ...collectionErrors.flatMap((error) => [`- FAIL collection: ${markdownCell(error)}`, '']),
  ].join('\n')

  try {
    await appendFile(stepSummary, table)
  } catch (cause) {
    console.warn(
      `WARN: could not append Effect 4 baseline file counts to GITHUB_STEP_SUMMARY; gate enforcement is unchanged: ${String(cause)}`,
    )
  }
}

await appendGitHubStepSummary()

if (failed.length === 0 && collectionErrors.length === 0) {
  console.log(
    `PASS: all ${testFiles.length} package test files have recorded ownership, all ${collectionTargets.length} Buck collection targets exactly cover their bounded selection, and ${baselineFiles.length} baseline files each contributed at least one collected test (${buckFiles.length} bounded).`,
  )
} else {
  if (failed.length > 0) {
    console.error(
      `FAIL: ${failed.length}/${baselineFiles.length} baseline files lack proof of collected tests.`,
    )
  }
  if (collectionErrors.length > 0) {
    console.error(
      `FAIL: ${collectionErrors.length} test-authority or collection-inventory contract violations.`,
    )
  }
  process.exitCode = 1
}
