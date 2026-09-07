#!/usr/bin/env bun

import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  type BaselineFile,
  decodeBuildOutputManifest,
  decodeTaskRegistry,
  evaluateBaselineCollection,
} from './src/baseline-test-collection.ts'

const argumentValue = (name: string) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const root = resolve(argumentValue('--root') ?? process.cwd())
// Buck reports declared outputs relative to the project root, which is the composed workspace
// above this cell, not this repository.
const workspaceRoot = resolve(root, argumentValue('--workspace-root') ?? '../..')
const taskRegistryPath = argumentValue('--task-registry')
if (taskRegistryPath === undefined) {
  throw new Error('--task-registry is required')
}
const buildManifestPath = argumentValue('--build-manifest')
if (buildManifestPath === undefined) {
  throw new Error('--build-manifest is required')
}

const taskRegistry =
  decodeTaskRegistry(await Bun.file(taskRegistryPath).json()) ??
  (() => {
    throw new Error(`${taskRegistryPath} is not a valid baseline test task registry`)
  })()
const manifest =
  decodeBuildOutputManifest(await Bun.file(buildManifestPath).json()) ??
  (() => {
    throw new Error(`${buildManifestPath} is not a valid buck2 --show-json-output manifest`)
  })()

const testGlobs = [
  'packages/@overeng/**/*.test.ts',
  'packages/@overeng/**/*.test.tsx',
  'packages/@overeng/**/*.spec.ts',
  'packages/@overeng/**/*.spec.tsx',
] as const

const baselineDescribePattern =
  /(?:^|[^\w$])(?:[A-Za-z_$][\w$]*\.)?describe(?:\.\w+)*\s*\(\s*(['"`])((?:(?!\1)[\s\S])*?)\1/g

const testFiles = (
  await Promise.all(
    testGlobs.map(async (pattern) => Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root }))),
  )
)
  .flat()
  .toSorted()

const testFileSources = await Promise.all(
  testFiles.map(async (file) => [file, await Bun.file(resolve(root, file)).text()] as const),
)

const baselineFiles = testFileSources
  .filter(([, source]) =>
    Array.from(source.matchAll(baselineDescribePattern)).some((match) =>
      /(?:baseline|cross-major)/i.test(match[2] ?? ''),
    ),
  )
  .map(
    ([file]): BaselineFile => ({
      file,
      registration: taskRegistry
        .filter(({ packagePath }) => file.startsWith(`${packagePath}/`))
        .toSorted((left, right) => right.packagePath.length - left.packagePath.length)[0],
    }),
  )
  .toSorted((left, right) => left.file.localeCompare(right.file))

const results = await evaluateBaselineCollection({ baselineFiles, manifest, workspaceRoot })
const failed = results.filter((result) => 'error' in result)

for (const result of results) {
  if ('error' in result) {
    console.error(`FAIL ${result.file}: ${result.error}`)
  } else {
    console.log(`PASS ${result.file}: collectedTests=${result.collectedTests} (${result.evidence})`)
  }
}

const markdownCell = (value: string) =>
  value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', ' ')

const stepSummary = process.env.GITHUB_STEP_SUMMARY
if (stepSummary !== undefined && stepSummary.length > 0) {
  const rows = results.map((result) => {
    const collectedTests =
      typeof result.collectedTests === 'number' ? String(result.collectedTests) : '-'
    const evidence = 'error' in result ? `FAIL: ${result.error}` : `PASS: ${result.evidence}`
    return `| ${markdownCell(result.file)} | ${markdownCell(result.taskName ?? '-')} | ${collectedTests} | ${markdownCell(evidence)} |`
  })
  const table = [
    '## Effect 4 baseline test collection',
    '',
    '| Baseline file | Managed task | Collected tests | Evidence |',
    '| --- | --- | ---: | --- |',
    ...rows,
    '',
  ].join('\n')

  try {
    await appendFile(stepSummary, table)
  } catch (cause) {
    console.warn(
      `WARN: could not append Effect 4 baseline file counts to GITHUB_STEP_SUMMARY; gate enforcement is unchanged: ${String(cause)}`,
    )
  }
}

if (failed.length === 0) {
  console.log(
    `PASS: ${baselineFiles.length} baseline files each contributed at least one collected test.`,
  )
} else {
  console.error(
    `FAIL: ${failed.length}/${baselineFiles.length} baseline files lack proof of collected tests.`,
  )
  process.exitCode = 1
}
