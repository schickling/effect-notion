import { Buffer } from 'node:buffer'
import process from 'node:process'

import { describe, expect, it } from 'vitest'

import buckMemberManifest from '../../buck2-member.json.genie.ts'
import { decodeBuckMemberManifestJson } from '../../packages/@overeng/megarepo/src/buck2-manifest.ts'
import { rootTsconfigProjects } from '../tsconfig-projects.ts'
import {
  authoritativeBuck2TypeScriptAdmissions,
  blockedBuck2TypeScriptProjectPaths,
  buck2TypeScriptAdmissionBlockers,
  buck2TypeScriptAdmissions,
  buck2TypeScriptAuthorityProjects,
  buck2TypeScriptAuthorityProjectPaths,
  buck2TypeScriptDistOverlays,
  deriveBuck2TypeScriptAuthority,
  editorViewConsumerPackagePaths,
  editorViewPublicationRoots,
  rootInstallConsumerBlockers,
  type Buck2TypeScriptAdmission,
} from './typescript-admissions.ts'

describe('Buck2 TypeScript authority derivation', () => {
  it('derives authority only from package-local declarations in registry order', () => {
    const packageLocalAuthorities = Object.values(buck2TypeScriptAdmissions).flatMap(
      (admission: Buck2TypeScriptAdmission) =>
        admission.authority?.declarationEntrypoint === undefined
          ? []
          : [
              deriveBuck2TypeScriptAuthority({
                ...admission,
                authority: {
                  ...admission.authority,
                  declarationEntrypoint: admission.authority.declarationEntrypoint,
                },
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
        .toSorted(
          (left, right) =>
            Buffer.from(left.target).compare(Buffer.from(right.target)) ||
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
      buck2TypeScriptAuthorityProjects
        .filter(({ projectPath }) =>
          rootTsconfigProjects.some(({ path }) => path === projectPath),
        )
        .map(({ emitTarget, projectPath: path, typecheckTarget }) => ({
          buck2Authority: {
            _tag: 'Buck2TypeScriptAuthority',
            ...(emitTarget === undefined ? {} : { emitTarget }),
            typecheckTarget,
          },
          path,
        }))
        .toSorted((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path))),
    )
  })

  /**
   * This is deliberately only the TypeScript-authority gate. Root-install
   * deletion remains blocked by the separately enumerated consumer registry.
   */
  it('admits every root TypeScript project to Buck authority', () => {
    expect(blockedBuck2TypeScriptProjectPaths).toEqual([])
    expect(buck2TypeScriptAdmissionBlockers).toEqual({})
    const authorityProjectPaths = new Set(buck2TypeScriptAuthorityProjectPaths)
    expect(
      rootTsconfigProjects
        .map(({ path }) => path)
        .filter((path) => authorityProjectPaths.has(path) === false),
    ).toEqual([])
  })

  it('has no remaining whole-repository root-install consumers', () => {
    expect(rootInstallConsumerBlockers).toEqual([])
  })

  /**
   * `editor-view.ts` publishes into `<packageDir>/../../.editor-view`, so every root is a pure
   * function of the admitted package path. Both the Buck project ignores and the composition-root
   * Watchman `ignore_dirs` read this one derivation.
   */
  it('derives every editor-view publication root from the admitted package list', () => {
    expect(editorViewPublicationRoots).toEqual([
      '.editor-view',
      'context/.editor-view',
      'packages/.editor-view',
      'packages/@overeng/effect-rpc-tanstack/.editor-view',
    ])
    expect(editorViewConsumerPackagePaths).toContain('context/effect/socket')
    expect(editorViewPublicationRoots).not.toContain('context/effect/.editor-view')

    const projectedManifest = decodeBuckMemberManifestJson(
      buckMemberManifest.stringify({ cwd: process.cwd(), location: '' }),
    )
    expect(
      projectedManifest.projectIgnore.filter((pattern) => pattern.endsWith('.editor-view')),
    ).toEqual(editorViewPublicationRoots)
  })
})
