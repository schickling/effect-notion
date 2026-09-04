import { Buffer } from 'node:buffer'
import process from 'node:process'

import { describe, expect, it } from 'vitest'

import buckMemberManifest from '../../buck2-member.json.genie.ts'
import { decodeBuckMemberManifestJson } from '../../packages/@overeng/megarepo/src/buck2-manifest.ts'
import { rootWorkspaceTsconfigProjects } from '../tsconfig-projects.ts'
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
