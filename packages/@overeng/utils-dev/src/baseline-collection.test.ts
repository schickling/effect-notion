import { describe, expect, it } from 'vitest'

import {
  decodeCollectionArtifact,
  decodeTestAuthority,
  minimumTestAuthorityLanes,
  ownershipForFile,
  parseShowOutput,
  repoPathFromReportName,
  taskFileStem,
  type TestAuthorityLane,
} from './baseline-collection.ts'

const lane = (overrides: Partial<TestAuthorityLane> = {}): TestAuthorityLane => ({
  collectionTarget: 'effect_utils//packages/@overeng/alpha:test_collect',
  excludes: [],
  packageName: 'alpha',
  packagePath: 'packages/@overeng/alpha',
  runner: 'vitest',
  selectedTestFiles: ['src/a.test.ts'],
  sourceOwners: {},
  target: 'effect_utils//packages/@overeng/alpha:test',
  taskName: 'test:alpha',
  testFiles: ['src/a.test.ts'],
  unboundedAfter: [],
  unboundedFiles: [],
  ...overrides,
})

/** Conformant registry of the contracted minimum size, byte-sorted by target. */
const conformantLanes = (): readonly TestAuthorityLane[] =>
  Array.from({ length: minimumTestAuthorityLanes }, (_, index) => {
    const packageName = `pkg-${String(index).padStart(2, '0')}`
    const packagePath = `packages/@overeng/${packageName}`
    const target = `effect_utils//${packagePath}:test`
    return {
      collectionTarget: `${target}_collect`,
      excludes: [],
      packageName,
      packagePath,
      runner: 'vitest',
      selectedTestFiles: ['src/a.test.ts'],
      sourceOwners: {},
      target,
      taskName: `test:${packageName}`,
      testFiles: ['src/a.test.ts'],
      unboundedAfter: [],
      unboundedFiles: [],
    } satisfies TestAuthorityLane
  })

/** The conformant registry with one lane replaced by `overrides`. */
const registryWith = (overrides: Partial<TestAuthorityLane>) =>
  conformantLanes().map((entry, index) =>
    index === 0 ? Object.assign({}, entry, overrides) : entry,
  )

const decode = (lanes: readonly unknown[]) =>
  decodeTestAuthority({ decoded: { schemaVersion: 2, lanes }, sourceLabel: 'bridge.json' })

describe('decodeTestAuthority', () => {
  it('decodes a conformant schemaVersion 2 bridge', () => {
    expect(decode(conformantLanes())).toEqual(conformantLanes())
  })

  it('accepts a non-default target name and its derived task name', () => {
    const target = 'effect_utils//packages/@overeng/pkg-00:unit'
    expect(() =>
      decode(
        registryWith({
          collectionTarget: `${target}_collect`,
          target,
          taskName: 'test:pkg-00:unit',
        }),
      ),
    ).not.toThrow()
  })

  it('rejects a non-2 schema version', () => {
    expect(() =>
      decodeTestAuthority({ decoded: { schemaVersion: 1, lanes: [] }, sourceLabel: 'bridge.json' }),
    ).toThrow(/schemaVersion 2/)
  })

  it('rejects a bridge without lanes', () => {
    expect(() =>
      decodeTestAuthority({ decoded: { schemaVersion: 2 }, sourceLabel: 'bridge.json' }),
    ).toThrow(/no lanes array/)
  })

  it('rejects a lane missing contracted fields', () => {
    expect(() => decode([{ packagePath: 'packages/@overeng/alpha' }])).toThrow(
      /does not match the test-authority schema/,
    )
  })

  it('rejects a registry that lost lanes, which would hand packages back to source Vitest', () => {
    expect(() => decode(conformantLanes().slice(1))).toThrow(
      new RegExp(`fewer than the ${minimumTestAuthorityLanes} it must carry`),
    )
  })

  it('rejects lanes that are not byte-sorted by target', () => {
    expect(() => decode(conformantLanes().toReversed())).toThrow(/not byte-sorted by target/)
  })

  it('rejects a duplicate target', () => {
    const lanes = conformantLanes()
    expect(() => decode([lanes[0]!, ...lanes.slice(0, -1)])).toThrow(
      /not byte-sorted by target, or declare a duplicate target/,
    )
  })

  it('rejects multiple lanes for one package until lane membership is unambiguous', () => {
    const lanes = conformantLanes()
    const packagePath = lanes[0]!.packagePath
    const target = `effect_utils//${packagePath}:unit`
    const duplicatePackage = {
      ...lanes[1]!,
      collectionTarget: `${target}_collect`,
      packageName: lanes[0]!.packageName,
      packagePath,
      target,
      taskName: `test:${lanes[0]!.packageName}:unit`,
    }
    expect(() => decode([lanes[0]!, duplicatePackage, ...lanes.slice(2)])).toThrow(
      /more than one lane per package is not supported/,
    )
  })

  it('rejects a duplicate task name across otherwise distinct lanes', () => {
    expect(() => decode(registryWith({ taskName: 'test:pkg-01' }))).toThrow(/is not the derived/)
  })

  it('rejects a packageName that is not the last package-path segment', () => {
    expect(() => decode(registryWith({ packageName: 'other' }))).toThrow(
      /is not the last segment of/,
    )
  })

  it('rejects an unnormalized package path', () => {
    expect(() => decode(registryWith({ packagePath: 'packages/@overeng/../escape' }))).toThrow(
      /is not a normalized relative path/,
    )
  })

  it('rejects a target that is not the fully qualified package label', () => {
    expect(() => decode(registryWith({ target: 'effect_utils//elsewhere:test' }))).toThrow(
      /is not `effect_utils\/\/packages\/@overeng\/pkg-00:<name>`/,
    )
  })

  it.each([
    ['uppercase', 'Test'],
    ['a dot', 'test.unit'],
    ['whitespace', 'test unit'],
    ['a dash', 'test-unit'],
    ['a leading digit', '2test'],
    ['a leading underscore', '_test'],
    ['an empty name', ''],
  ])('rejects a target name with %s, which the projection would never render', (_label, name) => {
    const target = `effect_utils//packages/@overeng/pkg-00:${name}`
    expect(() =>
      decode(
        registryWith({
          collectionTarget: `${target}_collect`,
          target,
          taskName: `test:pkg-00:${name}`,
        }),
      ),
    ).toThrow(/with a \/\^\[a-z\]\[a-z0-9_\]\*\$\/ name/)
  })

  it('rejects a task name that is not derived from the package and target names', () => {
    expect(() => decode(registryWith({ taskName: 'test:something-else' }))).toThrow(
      /is not the derived test:pkg-00/,
    )
  })

  it('rejects an unnormalized exclude', () => {
    expect(() =>
      decode(
        registryWith({
          excludes: ['../outside.test.ts'],
          selectedTestFiles: ['../outside.test.ts'],
          testFiles: ['../outside.test.ts'],
          unboundedFiles: ['../outside.test.ts'],
          unboundedTaskName: 'test:pkg-00:unbounded',
        }),
      ),
    ).toThrow(/contains non-normalized path/)
  })

  it('rejects duplicate excludes', () => {
    expect(() =>
      decode(
        registryWith({
          excludes: ['src/a.test.ts', 'src/a.test.ts'],
          unboundedFiles: ['src/a.test.ts'],
          unboundedTaskName: 'test:pkg-00:unbounded',
        }),
      ),
    ).toThrow(/excludes contains a duplicate/)
  })

  it('rejects unbounded files without their derived task', () => {
    expect(() =>
      decode(
        registryWith({
          excludes: ['src/a.test.ts'],
          unboundedFiles: ['src/a.test.ts'],
        }),
      ),
    ).toThrow(/declared exactly when unboundedFiles is non-empty/)
  })

  it('rejects an unbounded task with no files, which would run the whole package', () => {
    expect(() => decode(registryWith({ unboundedTaskName: 'test:pkg-00:unbounded' }))).toThrow(
      /declared exactly when unboundedFiles is non-empty/,
    )
  })

  it('accepts an explicit source owner without inventing an empty complement', () => {
    expect(() =>
      decode(
        registryWith({
          excludes: ['src/a.test.ts'],
          sourceOwners: { 'src/a.test.ts': 'test:external' },
        }),
      ),
    ).not.toThrow()
  })

  it('rejects an unbounded task name that is not the complement of the lane task', () => {
    expect(() =>
      decode(
        registryWith({
          excludes: ['src/a.test.ts'],
          unboundedFiles: ['src/a.test.ts'],
          unboundedTaskName: 'test:pkg-00:extra',
        }),
      ),
    ).toThrow(/is not test:pkg-00:unbounded/)
  })

  it('rejects a Vitest lane whose collection target is not <target>_collect', () => {
    expect(() =>
      decode(registryWith({ collectionTarget: 'effect_utils//packages/@overeng/pkg-00:other' })),
    ).toThrow(/must declare collectionTarget/)
  })

  it('rejects a Vitest lane with no collection target', () => {
    const { collectionTarget: _collectionTarget, ...withoutCollectionTarget } =
      conformantLanes()[0]!
    expect(() => decode([withoutCollectionTarget, ...conformantLanes().slice(1)])).toThrow(
      /must declare collectionTarget/,
    )
  })

  it('rejects a non-Vitest lane that declares a collection target', () => {
    expect(() => decode(registryWith({ runner: 'bun' }))).toThrow(
      /bun lane must not declare a collectionTarget/,
    )
  })
  it('rejects nested lane packages whose censuses could overlap', () => {
    expect(() =>
      decode(
        registryWith({
          collectionTarget: 'effect_utils//packages/@overeng/pkg-01/nested:test_collect',
          packageName: 'nested',
          packagePath: 'packages/@overeng/pkg-01/nested',
          target: 'effect_utils//packages/@overeng/pkg-01/nested:test',
          taskName: 'test:nested',
        }),
      ),
    ).toThrow(/nested lane packages are not supported/)
  })
})

describe('ownershipForFile', () => {
  const lanes = [
    lane({
      excludes: ['src/external.test.ts', 'src/live.test.ts'],
      selectedTestFiles: ['src/a.test.ts', 'src/external.test.ts', 'src/live.test.ts'],
      sourceOwners: { 'src/external.test.ts': 'test:external' },
      testFiles: ['src/a.test.ts', 'src/external.test.ts', 'src/live.test.ts'],
      unboundedFiles: ['src/live.test.ts'],
      unboundedTaskName: 'test:alpha:unbounded',
    }),
  ]

  it('binds a lane file that is not excluded to the lane collection target', () => {
    expect(
      ownershipForFile({ file: 'packages/@overeng/alpha/src/a.test.ts', lanes }),
    ).toStrictEqual({
      kind: 'buck',
      collectionTarget: 'effect_utils//packages/@overeng/alpha:test_collect',
      packageRelative: 'src/a.test.ts',
    })
  })

  it('gives an exact exclude to the unbounded source task', () => {
    expect(
      ownershipForFile({ file: 'packages/@overeng/alpha/src/live.test.ts', lanes }),
    ).toStrictEqual({ kind: 'source', taskName: 'test:alpha:unbounded' })
  })

  it('uses an exceptional source owner instead of the lane complement', () => {
    expect(
      ownershipForFile({ file: 'packages/@overeng/alpha/src/external.test.ts', lanes }),
    ).toStrictEqual({ kind: 'source', taskName: 'test:external' })
  })

  it('falls back to the conventional task for a package outside the registry', () => {
    expect(ownershipForFile({ file: 'packages/@overeng/zeta/src/z.test.ts', lanes })).toStrictEqual(
      { kind: 'source', taskName: 'test:zeta' },
    )
  })

  it('refuses a file outside the package layout', () => {
    expect(ownershipForFile({ file: 'context/opentui/src/z.test.ts', lanes }).kind).toBe('unowned')
  })

  it('refuses a bounded lane that declares no collection target', () => {
    const { collectionTarget: _collectionTarget, ...bunLane } = lane({ runner: 'bun' })
    expect(
      ownershipForFile({ file: 'packages/@overeng/alpha/src/a.test.ts', lanes: [bunLane] }).kind,
    ).toBe('unowned')
  })
})

describe('parseShowOutput', () => {
  it('maps each label to its project-relative artifact path', () => {
    const parsed = parseShowOutput('//a:test_collect out/a.json\n//b:test_collect out/b.json\n')
    expect('error' in parsed ? parsed.error : [...parsed.artifacts]).toStrictEqual([
      ['//a:test_collect', 'out/a.json'],
      ['//b:test_collect', 'out/b.json'],
    ])
  })

  it('rejects a label with no output path', () => {
    expect(parseShowOutput('//a:test_collect\n')).toStrictEqual({
      error: 'buck2 --show-output line is not "<label> <path>": //a:test_collect',
    })
  })

  it('rejects a duplicated label', () => {
    expect(parseShowOutput('//a:t out/a.json\n//a:t out/b.json\n')).toStrictEqual({
      error: 'buck2 --show-output reported //a:t twice',
    })
  })
})

describe('decodeCollectionArtifact', () => {
  const artifactPath = '/buck-out/a.json'

  it('accepts a byte-sorted schemaVersion 1 artifact', () => {
    const decoded = {
      schemaVersion: 1,
      tests: [
        { file: 'src/a.test.ts', name: 'a > one' },
        { file: 'src/a.test.ts', name: 'a > two' },
        { file: 'src/b.test.ts', name: 'b' },
      ],
    }
    expect(decodeCollectionArtifact({ artifactPath, decoded })).toStrictEqual({
      tests: decoded.tests,
    })
  })

  it('rejects a wrong schema version', () => {
    expect(
      decodeCollectionArtifact({ artifactPath, decoded: { schemaVersion: 2, tests: [] } }),
    ).toStrictEqual({ error: `${artifactPath} is not a schemaVersion 1 collection artifact` })
  })

  it('rejects a missing tests array', () => {
    expect(decodeCollectionArtifact({ artifactPath, decoded: { schemaVersion: 1 } })).toStrictEqual(
      { error: `${artifactPath} has no tests array` },
    )
  })

  it('rejects an out-of-tree file path', () => {
    const result = decodeCollectionArtifact({
      artifactPath,
      decoded: { schemaVersion: 1, tests: [{ file: '../escape.test.ts', name: 'x' }] },
    })
    expect('error' in result && result.error).toMatch(/not a normalized package-relative path/)
  })

  it('rejects an absolute file path', () => {
    const result = decodeCollectionArtifact({
      artifactPath,
      decoded: { schemaVersion: 1, tests: [{ file: '/abs/x.test.ts', name: 'x' }] },
    })
    expect('error' in result && result.error).toMatch(/not a normalized package-relative path/)
  })

  it('rejects entries that are not byte-sorted by file then name', () => {
    const result = decodeCollectionArtifact({
      artifactPath,
      decoded: {
        schemaVersion: 1,
        tests: [
          { file: 'src/b.test.ts', name: 'b' },
          { file: 'src/a.test.ts', name: 'a' },
        ],
      },
    })
    expect('error' in result && result.error).toMatch(/not byte-sorted by file then name/)
  })

  it('rejects a name that is out of order within one file', () => {
    const result = decodeCollectionArtifact({
      artifactPath,
      decoded: {
        schemaVersion: 1,
        tests: [
          { file: 'src/a.test.ts', name: 'b' },
          { file: 'src/a.test.ts', name: 'a' },
        ],
      },
    })
    expect('error' in result && result.error).toMatch(/not byte-sorted by file then name/)
  })
})

describe('taskFileStem', () => {
  it('matches the retained-report stem devenv writes for unbounded complements', () => {
    expect(taskFileStem('test:megarepo:unbounded')).toBe('test-megarepo-unbounded')
  })
})

describe('repoPathFromReportName', () => {
  const root = '/repo'

  it('accepts an absolute in-tree report name', () => {
    expect(
      repoPathFromReportName({ name: '/repo/packages/@overeng/alpha/src/a.test.ts', root }),
    ).toBe('packages/@overeng/alpha/src/a.test.ts')
  })

  it('accepts a repository-relative report name', () => {
    expect(repoPathFromReportName({ name: 'packages/@overeng/alpha/src/a.test.ts', root })).toBe(
      'packages/@overeng/alpha/src/a.test.ts',
    )
  })

  it('rejects a report name outside the repository', () => {
    expect(repoPathFromReportName({ name: '/elsewhere/a.test.ts', root })).toBeUndefined()
  })
})
