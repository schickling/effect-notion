import { Buffer } from 'node:buffer'
import process from 'node:process'

import { describe, expect, it } from 'vitest'

import buckMemberManifest from '../../buck2-member.json.genie.ts'
import buck2TestAuthority from '../../buck2-test-authority.json.genie.ts'
import { decodeBuckMemberManifestJson } from '../../packages/@overeng/megarepo/src/buck2-manifest.ts'
import { rootTsconfigProjects } from '../tsconfig-projects.ts'
import {
  authoritativeBuck2TypeScriptDeclarations,
  authoritativeBuck2TypeScriptProjects,
  buck2TestLanes,
  buck2TypeScriptAdmissions,
  buck2TypeScriptDistOverlays,
  buck2TypeScriptTestCollectionTargets,
  buck2TypeScriptTestTargets,
  deriveBuck2TestLane,
  deriveBuck2TypeScriptAuthority,
  type Buck2TypeScriptAdmission,
} from './typescript-admissions.ts'

describe('Buck2 TypeScript authority derivation', () => {
  it('derives every project only from package-local declarations in registry order', () => {
    const packageLocalAuthorities = Object.values(buck2TypeScriptAdmissions).flatMap(
      (admission: Buck2TypeScriptAdmission) =>
        (admission.authorities ?? []).map((authority) =>
          deriveBuck2TypeScriptAuthority({
            authority,
            packagePath: admission.packagePath,
            sourceRoots: admission.sourceRoots,
          }),
        ),
    )

    expect(authoritativeBuck2TypeScriptProjects).toEqual(packageLocalAuthorities)
    expect(authoritativeBuck2TypeScriptProjects).toHaveLength(39)
  })

  it('gives every root TypeScript project one Buck typecheck target', () => {
    const authoritativeProjectPaths = authoritativeBuck2TypeScriptProjects
      .map(({ projectPath }) => projectPath)
      .toSorted((left, right) => Buffer.from(left).compare(Buffer.from(right)))
    const rootProjectPaths = rootTsconfigProjects
      .map(({ path }) => path)
      .toSorted((left, right) => Buffer.from(left).compare(Buffer.from(right)))

    expect(authoritativeProjectPaths).toEqual(rootProjectPaths)
  })

  it('derives declaration overlays and project authorities from the same entries', () => {
    expect(buck2TypeScriptDistOverlays).toEqual(
      authoritativeBuck2TypeScriptDeclarations
        .map(({ distTarget, packagePath }) => ({
          destination: `${packagePath}/dist`,
          target: distTarget,
        }))
        .toSorted((left, right) =>
          Buffer.from(left.destination).compare(Buffer.from(right.destination)),
        ),
    )

    const projectedManifest = decodeBuckMemberManifestJson(
      buckMemberManifest.stringify({ cwd: process.cwd(), location: '' }),
    )
    expect(projectedManifest.distOverlays).toEqual(buck2TypeScriptDistOverlays)

    expect(
      rootTsconfigProjects
        .map(({ buck2Authority, path }) => ({ buck2Authority, path }))
        .toSorted((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path))),
    ).toEqual(
      authoritativeBuck2TypeScriptProjects
        .map(({ declarationEntrypoint, packagePath, projectPath, typecheckTarget }) => ({
          buck2Authority: {
            _tag: 'Buck2TypeScriptAuthority',
            typecheckTarget,
            ...(declarationEntrypoint === undefined ? {} : { emitTarget: `//${packagePath}:dist` }),
          },
          path: projectPath,
        }))
        .toSorted((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path))),
    )
  })

  it('represents the React Inspector strict consumer as an independent project', () => {
    expect(
      authoritativeBuck2TypeScriptProjects.find(
        ({ projectPath }) =>
          projectPath === 'packages/@overeng/react-inspector/tsconfig.strict-consumer.json',
      ),
    ).toMatchObject({
      packagePath: 'packages/@overeng/react-inspector',
      projectFile: 'tsconfig.strict-consumer.json',
      typecheckTarget: '//packages/@overeng/react-inspector:strict_consumer_typecheck',
    })
  })
})

describe('Buck2 test lane registry', () => {
  const declaredLanes = Object.values(buck2TypeScriptAdmissions).flatMap(
    (admission: Buck2TypeScriptAdmission) =>
      (admission.tests ?? []).map((target) => ({ admission, target })),
  )

  it('derives one lane per package-local declaration and never invents one', () => {
    expect(buck2TestLanes.length).toBe(declaredLanes.length)
    // The lanes that exist today. A registry that silently shrinks moves tests out of the
    // gate without anyone deciding to, so the floor is asserted rather than described.
    expect(buck2TestLanes.length).toBeGreaterThanOrEqual(34)
    expect(new Set(buck2TestLanes.map(({ target }) => target)).size).toBe(buck2TestLanes.length)
    expect(new Set(buck2TestLanes.map(({ taskName }) => taskName)).size).toBe(buck2TestLanes.length)
  })

  it('projects a collection target for exactly the Vitest lanes', () => {
    const vitestLanes = buck2TestLanes.filter(({ runner }) => runner === 'vitest')

    expect(buck2TypeScriptTestCollectionTargets.length).toBe(vitestLanes.length)
    expect(buck2TypeScriptTestCollectionTargets).toEqual(
      vitestLanes.map(({ collectionTarget }) => collectionTarget),
    )
    expect(
      buck2TestLanes
        .filter(({ runner }) => runner !== 'vitest')
        .every(({ collectionTarget }) => collectionTarget === undefined),
    ).toBe(true)
    for (const lane of vitestLanes) {
      expect(lane.collectionTarget).toBe(`${lane.target}_collect`)
    }
  })

  it('orders lanes deterministically by execution label', () => {
    expect(buck2TestLanes.map(({ target }) => target)).toEqual(
      buck2TestLanes
        .map(({ target }) => target)
        .toSorted((left, right) => Buffer.from(left).compare(Buffer.from(right))),
    )
    expect(buck2TypeScriptTestTargets).toEqual(buck2TestLanes.map(({ target }) => target))
    expect(buck2TypeScriptTestTargets.every((target) => target.startsWith('effect_utils//'))).toBe(
      true,
    )
  })

  it('derives labels, ownership, and task names from one declaration', () => {
    const utilsLane = buck2TestLanes.find(({ packageName }) => packageName === 'utils')
    expect(utilsLane).toMatchObject({
      collectionTarget: 'effect_utils//packages/@overeng/utils:test_collect',
      excludes: buck2TypeScriptAdmissions.utils.tests[0].excludes,
      packageName: 'utils',
      packagePath: 'packages/@overeng/utils',
      runner: 'vitest',
      sourceOwners: {
        'src/browser/__tests__/BroadcastLogger.pw.test.ts': 'test:pw:utils',
      },
      target: 'effect_utils//packages/@overeng/utils:test',
      taskName: 'test:utils',
      unboundedTaskName: 'test:utils:unbounded',
    })
    expect(utilsLane?.testFiles).toContain('src/browser/__tests__/BroadcastLogger.pw.test.ts')
    expect(utilsLane?.unboundedFiles).not.toContain(
      'src/browser/__tests__/BroadcastLogger.pw.test.ts',
    )

    // Named lanes derive distinct addressable tasks without making package identity unique.
    expect(
      deriveBuck2TestLane({
        packagePath: 'packages/@example/widget',
        target: { name: 'test_upstream', runner: 'vitest' },
        testFiles: ['src/upstream.test.ts'],
      }),
    ).toEqual({
      collectionTarget: 'effect_utils//packages/@example/widget:test_upstream_collect',
      excludes: [],
      packageName: 'widget',
      packagePath: 'packages/@example/widget',
      runner: 'vitest',
      selectedTestFiles: ['src/upstream.test.ts'],
      sourceOwners: {},
      target: 'effect_utils//packages/@example/widget:test_upstream',
      taskName: 'test:widget:test_upstream',
      testFiles: ['src/upstream.test.ts'],
      unboundedAfter: [],
      unboundedFiles: [],
    })
    expect(
      buck2TestLanes
        .filter(({ packagePath }) => packagePath === 'packages/@overeng/pty-effect')
        .map(({ taskName, target }) => ({ taskName, target })),
    ).toEqual([
      {
        taskName: 'test:pty-effect:bundle_smoke',
        target: 'effect_utils//packages/@overeng/pty-effect:bundle_smoke',
      },
      {
        taskName: 'test:pty-effect',
        target: 'effect_utils//packages/@overeng/pty-effect:test',
      },
    ])
  })

  it('keeps effect-schema-form-aria out of the source-side fallback partition', () => {
    const lane = buck2TestLanes.find(
      ({ packagePath }) => packagePath === 'packages/@overeng/effect-schema-form-aria',
    )

    expect(lane).toEqual({
      collectionTarget:
        'effect_utils//packages/@overeng/effect-schema-form-aria:test_collect',
      excludes: [],
      packageName: 'effect-schema-form-aria',
      packagePath: 'packages/@overeng/effect-schema-form-aria',
      runner: 'vitest',
      selectedTestFiles: ['src/mod.unit.test.tsx'],
      sourceOwners: {},
      target: 'effect_utils//packages/@overeng/effect-schema-form-aria:test',
      taskName: 'test:effect-schema-form-aria',
      testFiles: ['src/mod.unit.test.tsx'],
      unboundedAfter: [],
      unboundedFiles: [],
    })
  })

  it('publishes the derived registry verbatim as the generated bridge', () => {
    const bridge: unknown = JSON.parse(
      buck2TestAuthority.stringify({ cwd: process.cwd(), location: '' }),
    )

    expect(bridge).toEqual(JSON.parse(JSON.stringify({ lanes: buck2TestLanes, schemaVersion: 2 })))
  })
})
