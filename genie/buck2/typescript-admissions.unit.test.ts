import { Buffer } from 'node:buffer'
import process from 'node:process'

import { describe, expect, it } from 'vitest'

import buckMemberManifest from '../../buck2-member.json.genie.ts'
import { decodeBuckMemberManifestJson } from '../../packages/@overeng/megarepo/src/buck2-manifest.ts'
import {
  isRootTsconfigCheckProject,
  isRootTsconfigEmitProject,
  rootTsconfigProjects,
  rootWorkspaceTsconfigProjects,
} from '../tsconfig-projects.ts'
import {
  authoritativeBuck2TypeScriptAdmissions,
  buck2TypeScriptAdmissions,
  buck2TypeScriptDistOverlays,
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
    expect(rootMembers(isRootTsconfigCheckProject)).toEqual(
      rootMembers(isRootTsconfigEmitProject),
    )

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
