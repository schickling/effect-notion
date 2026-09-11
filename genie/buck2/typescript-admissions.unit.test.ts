import { Buffer } from 'node:buffer'
import process from 'node:process'

import { describe, expect, it } from 'vitest'

import buckMemberManifest from '../../buck2-member.json.genie.ts'
import buck2TestAuthority from '../../buck2-test-authority.json.genie.ts'
import { decodeBuckMemberManifestJson } from '../../packages/@overeng/megarepo/src/buck2-manifest.ts'
import {
  isRootTsconfigCheckProject,
  isRootTsconfigEmitProject,
  rootTsconfigProjects,
  rootWorkspaceTsconfigProjects,
} from '../tsconfig-projects.ts'
import {
  authoritativeBuck2TypeScriptAdmissions,
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
  it('derives authority only from package-local declarations in registry order', () => {
    const packageLocalAuthorities = Object.values(buck2TypeScriptAdmissions).flatMap(
      (admission: Buck2TypeScriptAdmission) =>
        admission.authority === undefined
          ? []
          : [
              deriveBuck2TypeScriptAuthority({
                ...admission,
                authority: admission.authority,
              }),
            ],
    )

    expect(authoritativeBuck2TypeScriptAdmissions).toEqual(packageLocalAuthorities)
  })

  it('excludes every Buck-authoritative project from the root TypeScript solution', () => {
    const authoritativePackagePaths = authoritativeBuck2TypeScriptAdmissions.map(
      ({ packagePath }) => packagePath,
    )

    expect(
      rootWorkspaceTsconfigProjects
        .filter((project) => isRootTsconfigCheckProject(project) === false)
        .map(({ path }) => path)
        .toSorted((left, right) => Buffer.from(left).compare(Buffer.from(right))),
    ).toEqual(
      authoritativePackagePaths.toSorted((left, right) =>
        Buffer.from(left).compare(Buffer.from(right)),
      ),
    )
  })

  it('leaves exactly the projects no Buck target owns to root tsc', () => {
    // The generated solutions sort by path, so assert on that same order.
    const rootMembers = (predicate: (project: RootTsconfigProject) => boolean): readonly string[] =>
      rootTsconfigProjects
        .filter(predicate)
        .map(({ path }) => path)
        .toSorted((left, right) => left.localeCompare(right))

    // Checking and emitting are one decision: a project Buck typechecks also
    // owns its declarations, so the two root filters must select the same set.
    expect(rootMembers(isRootTsconfigCheckProject)).toEqual(rootMembers(isRootTsconfigEmitProject))

    expect(rootMembers(isRootTsconfigCheckProject)).toEqual([
      'context/effect/socket',
      'context/opentui',
      'packages/@overeng/buck2-tools',
      'packages/@overeng/effect-rpc-tanstack/examples/basic',
      'packages/@overeng/effect-schema-form-aria',
      'packages/@overeng/genie',
      'packages/@overeng/kdl-effect',
      'packages/@overeng/megarepo',
      'packages/@overeng/react-inspector/tsconfig.strict-consumer.json',
      'packages/@overeng/tui-stories',
    ])
  })

  it('derives manifest overlays and root TypeScript authority from the same entries', () => {
    expect(buck2TypeScriptDistOverlays).toEqual(
      authoritativeBuck2TypeScriptAdmissions
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
      rootWorkspaceTsconfigProjects
        .flatMap(({ buck2Authority, path }) =>
          buck2Authority === undefined ? [] : [{ buck2Authority, path }],
        )
        .toSorted((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path))),
    ).toEqual(
      authoritativeBuck2TypeScriptAdmissions
        .filter(({ packagePath }) =>
          rootWorkspaceTsconfigProjects.some(({ path }) => path === packagePath),
        )
        .map(({ distTarget, packagePath, typecheckTarget }) => ({
          buck2Authority: {
            _tag: 'Buck2TypeScriptAuthority',
            emitTarget: distTarget,
            typecheckTarget,
          },
          path: packagePath,
        }))
        .toSorted((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path))),
    )
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
    expect(buck2TestLanes.length).toBeGreaterThanOrEqual(32)
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

    // A named lane still derives an addressable task, but the published authority rejects
    // multiple lanes for one package until overlap semantics exist.
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
  })

  it('publishes the derived registry verbatim as the generated bridge', () => {
    const bridge: unknown = JSON.parse(
      buck2TestAuthority.stringify({ cwd: process.cwd(), location: '' }),
    )

    expect(bridge).toEqual(JSON.parse(JSON.stringify({ lanes: buck2TestLanes, schemaVersion: 2 })))
  })
})
