import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  decodeBuildOutputManifest,
  decodeTaskRegistration,
  evaluateBaselineCollection,
  type TestTaskRegistration,
} from './baseline-test-collection.ts'

const registration = {
  packageName: '@overeng/effect-path',
  packagePath: 'packages/@overeng/effect-path',
  taskName: 'test:effect-path',
  collectionTarget: 'effect_utils//packages/@overeng/effect-path:test_collect',
} as const satisfies TestTaskRegistration

const baselineFile = 'packages/@overeng/effect-path/src/baseline.unit.test.ts'

/** One stable collection entry, rooted at the package registered for its owning task. */
const listEntry = (relativePath: string, name: string) => ({
  name,
  file: relativePath,
})

let workspaceRoot = ''

const writeArtifact = async (name: string, contents: string): Promise<string> => {
  await writeFile(join(workspaceRoot, name), contents)
  return name
}

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'baseline-collection-'))
})

afterAll(async () => {
  await rm(workspaceRoot, { recursive: true, force: true })
})

describe('evaluateBaselineCollection', () => {
  it('accepts a declared Buck collection artifact that lists the baseline file', async () => {
    const output = await writeArtifact(
      'collect-pass.json',
      JSON.stringify([
        listEntry('src/baseline.unit.test.ts', 'effect-path baselines > pins encoded bytes'),
        listEntry('src/baseline.unit.test.ts', 'effect-path baselines > pins failures'),
        listEntry('src/other.unit.test.ts', 'other > unrelated'),
      ]),
    )

    expect(
      await evaluateBaselineCollection({
        baselineFiles: [{ file: baselineFile, registration }],
        manifest: { [registration.collectionTarget]: output },
        workspaceRoot,
      }),
    ).toEqual([
      {
        collectedTests: 2,
        evidence: `${registration.collectionTarget} -> ${output}`,
        file: baselineFile,
        taskName: registration.taskName,
      },
    ])
  })

  // The whole point of the cutover: proof is a declared build output, so an orphaned collection
  // target that never reached the build manifest must fail rather than pass silently.
  it('fails when the build manifest declares no output for the collection target', async () => {
    const results = await evaluateBaselineCollection({
      baselineFiles: [{ file: baselineFile, registration }],
      manifest: {},
      workspaceRoot,
    })

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ file: baselineFile, taskName: registration.taskName })
    expect(results[0]).toHaveProperty(
      'error',
      `the Buck build manifest declares no output for ${registration.collectionTarget} (task ${registration.taskName}); 0 targets were built`,
    )
  })

  it('fails when the declared output is missing from disk', async () => {
    const results = await evaluateBaselineCollection({
      baselineFiles: [{ file: baselineFile, registration }],
      manifest: { [registration.collectionTarget]: 'collect-absent.json' },
      workspaceRoot,
    })

    expect(results[0]).toHaveProperty('error', expect.stringContaining('is not readable'))
    expect(results[0]).toHaveProperty(
      'error',
      expect.stringContaining(registration.collectionTarget),
    )
  })

  it('fails when the collection artifact is not a vitest list array', async () => {
    const output = await writeArtifact('collect-shape.json', JSON.stringify({ tests: [] }))

    expect(
      await evaluateBaselineCollection({
        baselineFiles: [{ file: baselineFile, registration }],
        manifest: { [registration.collectionTarget]: output },
        workspaceRoot,
      }),
    ).toEqual([
      {
        error: `${output} is not a collection array of {name, file} entries with package-relative POSIX file paths`,
        file: baselineFile,
        taskName: registration.taskName,
      },
    ])
  })

  it('fails when the registered task collected zero tests at all', async () => {
    const output = await writeArtifact('collect-empty.json', '[]')

    expect(
      await evaluateBaselineCollection({
        baselineFiles: [{ file: baselineFile, registration }],
        manifest: { [registration.collectionTarget]: output },
        workspaceRoot,
      }),
    ).toEqual([
      {
        collectedTests: 0,
        error: `${output} reports zero collected tests for task ${registration.taskName}`,
        file: baselineFile,
        taskName: registration.taskName,
      },
    ])
  })

  it('fails when the artifact collects other files but not this baseline file', async () => {
    const output = await writeArtifact(
      'collect-other.json',
      JSON.stringify([listEntry('src/other.unit.test.ts', 'other > unrelated')]),
    )

    expect(
      await evaluateBaselineCollection({
        baselineFiles: [{ file: baselineFile, registration }],
        manifest: { [registration.collectionTarget]: output },
        workspaceRoot,
      }),
    ).toEqual([
      {
        collectedTests: 0,
        error: `${output} does not contain this baseline file (1 tests collected across task ${registration.taskName})`,
        file: baselineFile,
        taskName: registration.taskName,
      },
    ])
  })

  it('compares package-relative paths exactly rather than accepting a matching suffix', async () => {
    const output = await writeArtifact(
      'collect-suffix.json',
      JSON.stringify([
        listEntry(
          'nested/src/baseline.unit.test.ts',
          'effect-path baselines > unrelated matching suffix',
        ),
      ]),
    )

    const results = await evaluateBaselineCollection({
      baselineFiles: [{ file: baselineFile, registration }],
      manifest: { [registration.collectionTarget]: output },
      workspaceRoot,
    })

    expect(results[0]).toMatchObject({
      collectedTests: 0,
      error: expect.stringContaining('does not contain this baseline file'),
    })
  })

  it('rejects collection artifacts whose file escapes the package root', async () => {
    const output = await writeArtifact(
      'collect-escape.json',
      JSON.stringify([listEntry('../src/baseline.unit.test.ts', 'escaped > test')]),
    )

    expect(
      await evaluateBaselineCollection({
        baselineFiles: [{ file: baselineFile, registration }],
        manifest: { [registration.collectionTarget]: output },
        workspaceRoot,
      }),
    ).toEqual([
      {
        error: `${output} is not a collection array of {name, file} entries with package-relative POSIX file paths`,
        file: baselineFile,
        taskName: registration.taskName,
      },
    ])
  })

  it('rejects a baseline file outside its registered package root', async () => {
    const output = await writeArtifact(
      'collect-wrong-package.json',
      JSON.stringify([listEntry('src/baseline.unit.test.ts', 'effect-path baselines > test')]),
    )
    const file = 'packages/@overeng/effect-path-other/src/baseline.unit.test.ts'

    expect(
      await evaluateBaselineCollection({
        baselineFiles: [{ file, registration }],
        manifest: { [registration.collectionTarget]: output },
        workspaceRoot,
      }),
    ).toEqual([
      {
        error: `baseline file is outside registered package ${registration.packageName} root ${registration.packagePath}`,
        file,
        taskName: registration.taskName,
      },
    ])
  })

  it('fails a baseline file that no managed Buck test task owns', async () => {
    expect(
      await evaluateBaselineCollection({
        baselineFiles: [
          { file: 'packages/@overeng/orphan/src/a.test.ts', registration: undefined },
        ],
        manifest: {},
        workspaceRoot,
      }),
    ).toEqual([
      {
        error: 'no registered managed test task owns this baseline file',
        file: 'packages/@overeng/orphan/src/a.test.ts',
      },
    ])
  })
})

describe('registry and manifest decoding', () => {
  it('requires every registration to name its package, root, task, and collection target', () => {
    expect(decodeTaskRegistration(registration)).toEqual(registration)
    expect(decodeTaskRegistration({ ...registration, packageName: undefined })).toBeUndefined()
    expect(decodeTaskRegistration({ ...registration, packagePath: '../effect-path' })).toBeUndefined()
    expect(decodeTaskRegistration({ ...registration, collectionTarget: undefined })).toBeUndefined()
    expect(decodeTaskRegistration({ packagePath: 'p', taskName: 't' })).toBeUndefined()
    expect(decodeTaskRegistration('nope')).toBeUndefined()
  })

  it('decodes the buck2 --show-json-output label-to-output mapping', () => {
    expect(
      decodeBuildOutputManifest({
        'effect_utils//a:test_collect': 'buck-out/v2/gen/a/test_collect.json',
      }),
    ).toEqual({ 'effect_utils//a:test_collect': 'buck-out/v2/gen/a/test_collect.json' })
    expect(decodeBuildOutputManifest([])).toBeUndefined()
    expect(decodeBuildOutputManifest({ 'effect_utils//a:test_collect': 3 })).toBeUndefined()
  })
})
