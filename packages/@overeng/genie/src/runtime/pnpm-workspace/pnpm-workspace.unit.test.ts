import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { packageJson, type GenieContext } from '../mod.ts'
import { defineCatalog } from '../package-json/catalog.ts'
import type { WorkspacePackage } from '../package-json/mod.ts'
import { pnpmWorkspaceYaml, projectPnpmPackageClosure, projectPnpmSourceInputs } from './mod.ts'

const mockGenieContext: GenieContext = {
  location: '.',
  cwd: '/workspace',
}

const createTempRepo = (...memberPaths: string[]) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-workspace-'))
  fs.mkdirSync(path.join(repoRoot, '.git'))

  return {
    repoRoot,
    repoName: path.basename(repoRoot),
    memberDirs: Object.fromEntries(
      memberPaths.map((memberPath) => {
        const memberDir = path.join(repoRoot, memberPath)
        fs.mkdirSync(memberDir, { recursive: true })
        return [memberPath, memberDir]
      }),
    ) as Record<string, string>,
  }
}

const workspace = ({
  repoName,
  memberPath,
  pnpmPackageClosure,
}: {
  repoName: string
  memberPath: string
  pnpmPackageClosure?: {
    extraMemberPaths?: readonly string[]
  }
}) => ({
  repoName,
  memberPath,
  ...(pnpmPackageClosure !== undefined ? { pnpmPackageClosure } : {}),
})

describe('metadata-based workspace projections', () => {
  const repo = createTempRepo('packages/utils', 'packages/app')
  const catalog = defineCatalog({})
  const utilsComposition = catalog.compose({
    workspace: workspace({
      repoName: repo.repoName,
      memberPath: 'packages/utils',
    }),
  })
  const utils = packageJson(
    {
      name: '@test/utils',
      version: '1.0.0',
    },
    utilsComposition,
  )
  const appComposition = catalog.compose({
    workspace: workspace({
      repoName: repo.repoName,
      memberPath: 'packages/app',
      pnpmPackageClosure: {
        extraMemberPaths: ['packages/examples/basic'],
      },
    }),
    dependencies: {
      workspace: [utils],
    },
  })
  const app = packageJson(
    {
      name: '@test/app',
      version: '1.0.0',
    },
    appComposition,
  )
  const exampleComposition = catalog.compose({
    workspace: workspace({
      repoName: repo.repoName,
      memberPath: 'packages/examples/basic',
    }),
  })
  const example = packageJson(
    {
      name: '@test/example-basic',
      version: '1.0.0',
    },
    exampleComposition,
  )

  it('projects package-closure workspace members from package metadata', () => {
    const workspaceProjection = projectPnpmPackageClosure({
      pkg: app,
    })

    expect(workspaceProjection.workspaceClosureDirs).toEqual([
      'packages/app',
      'packages/examples/basic',
      'packages/utils',
    ])
    expect(workspaceProjection.packageRelativeMemberPaths).toEqual([
      '.',
      '../examples/basic',
      '../utils',
    ])
  })

  it('projects root workspace members recursively from package metadata', () => {
    const workspaceFile = pnpmWorkspaceYaml.root({
      packages: [app, example],
      repoName: repo.repoName,
      dedupePeerDependents: true,
    })

    expect(workspaceFile.data.packages).toEqual([
      'packages/app',
      'packages/examples/basic',
      'packages/utils',
    ])
  })

  it('stops root workspace projection at foreign repo boundaries', () => {
    const foreignRepo = createTempRepo('packages/shared')
    const foreignShared = packageJson(
      {
        name: '@foreign/shared',
        version: '1.0.0',
      },
      catalog.compose({
        workspace: workspace({
          repoName: foreignRepo.repoName,
          memberPath: 'packages/shared',
        }),
      }),
    )
    const crossRepoApp = packageJson(
      {
        name: '@test/cross-repo-app',
        version: '1.0.0',
      },
      catalog.compose({
        workspace: workspace({
          repoName: repo.repoName,
          memberPath: 'packages/app',
        }),
        dependencies: {
          workspace: [utils, foreignShared],
        },
      }),
    )

    const workspaceFile = pnpmWorkspaceYaml.root({
      packages: [crossRepoApp, utils, foreignShared],
      repoName: repo.repoName,
      dedupePeerDependents: true,
    })

    expect(workspaceFile.data.packages).toEqual(['packages/app', 'packages/utils'])

    expect(projectPnpmSourceInputs({ packages: [crossRepoApp], repoName: repo.repoName })).toEqual({
      sourceInputPaths: [`repos/${foreignRepo.repoName}/packages/shared`],
      overrides: {
        '@foreign/shared': `file:.devenv/pnpm-source-inputs/current/repos/${foreignRepo.repoName}/packages/shared`,
      },
    })
  })

  it('includes extraMembers in root workspace projection', () => {
    const workspaceFile = pnpmWorkspaceYaml.root({
      packages: [app, example],
      repoName: repo.repoName,
      extraMembers: ['examples/*'],
      dedupePeerDependents: true,
    })

    expect(workspaceFile.data.packages).toEqual([
      'examples/*',
      'packages/app',
      'packages/examples/basic',
      'packages/utils',
    ])
  })

  it('serializes top-level storeDir', () => {
    const workspaceFile = pnpmWorkspaceYaml.root({
      packages: [app],
      repoName: repo.repoName,
      storeDir: '.pnpm-store',
    })

    expect(workspaceFile.stringify(mockGenieContext)).toContain('storeDir: .pnpm-store')
  })

  it('serializes hoistingLimits for hoisted pnpm workspaces', () => {
    const workspaceFile = pnpmWorkspaceYaml.root({
      packages: [app],
      repoName: repo.repoName,
      nodeLinker: 'hoisted',
      hoistingLimits: 'workspaces',
    })

    expect(workspaceFile.stringify(mockGenieContext)).toContain('hoistingLimits: workspaces')
  })

  it('projects workspace root workspaces from package metadata', () => {
    const workspaceRoot = packageJson.aggregateFromPackages({
      packages: [app],
      name: 'workspace-root',
      repoName: repo.repoName,
    })

    expect(workspaceRoot.data.workspaces).toEqual(['packages/app', 'packages/utils'])
  })

  it('excludes direct foreign seeds from workspace root workspaces', () => {
    const foreignRepo = createTempRepo('packages/shared')
    const foreignShared = packageJson(
      {
        name: '@foreign/shared',
        version: '1.0.0',
      },
      catalog.compose({
        workspace: workspace({
          repoName: foreignRepo.repoName,
          memberPath: 'packages/shared',
        }),
      }),
    )

    const workspaceRoot = packageJson.aggregateFromPackages({
      packages: [app, utils, foreignShared],
      name: 'workspace-root',
      repoName: repo.repoName,
    })

    expect(workspaceRoot.data.workspaces).toEqual(['packages/app', 'packages/utils'])
  })
})

describe('root patch coverage validation', () => {
  const repo = createTempRepo('packages/utils', 'packages/app')
  const catalog = defineCatalog({})

  const makeUtilsWithPatches = () => {
    const utilsComposition = catalog.compose({
      workspace: workspace({
        repoName: repo.repoName,
        memberPath: 'packages/utils',
      }),
    })
    return packageJson(
      {
        name: '@test/utils',
        version: '1.0.0',
        pnpm: {
          patchedDependencies: {
            'some-pkg@1.0.0': 'packages/utils/patches/some-pkg@1.0.0.patch',
          },
        },
      },
      utilsComposition,
    )
  }

  const makeApp = (deps: WorkspacePackage[]) => {
    const appComposition = catalog.compose({
      workspace: workspace({
        repoName: repo.repoName,
        memberPath: 'packages/app',
      }),
      dependencies: {
        workspace: deps,
      },
    })
    return packageJson(
      {
        name: '@test/app',
        version: '1.0.0',
      },
      appComposition,
    )
  }

  it('passes when root config includes all required patches', async () => {
    const utils = makeUtilsWithPatches()
    const app = makeApp([utils])

    const workspaceFile = pnpmWorkspaceYaml.root({
      packages: [app],
      repoName: repo.repoName,
      patchedDependencies: {
        'some-pkg@1.0.0': 'repos/upstream/packages/utils/patches/some-pkg@1.0.0.patch',
      },
    })

    const issues = await workspaceFile.validate?.({
      location: '.',
      cwd: repo.repoRoot,
    })
    expect(issues).toEqual([])
  })

  it('reports missing patch when root config omits a required patch', async () => {
    const utils = makeUtilsWithPatches()
    const app = makeApp([utils])

    const workspaceFile = pnpmWorkspaceYaml.root({
      packages: [app],
      repoName: repo.repoName,
    })

    const issues = await workspaceFile.validate?.({
      location: '.',
      cwd: repo.repoRoot,
    })
    expect(issues).toHaveLength(1)
    expect(issues?.[0]).toMatchObject({
      severity: 'error',
      dependency: 'some-pkg@1.0.0',
      rule: 'root-patch-coverage',
    })
  })

  it('detects patches from transitive workspace deps', async () => {
    const transitiveRepo = createTempRepo('packages/utils', 'packages/app', 'packages/wrapper')
    const utils = makeUtilsWithPatches()
    const app = makeApp([utils])

    const wrapperComposition = catalog.compose({
      workspace: workspace({
        repoName: transitiveRepo.repoName,
        memberPath: 'packages/wrapper',
      }),
      dependencies: {
        workspace: [app],
      },
    })
    const wrapper = packageJson({ name: '@test/wrapper', version: '1.0.0' }, wrapperComposition)

    const workspaceFile = pnpmWorkspaceYaml.root({
      packages: [wrapper],
      repoName: transitiveRepo.repoName,
    })

    const issues = await workspaceFile.validate?.({
      location: '.',
      cwd: transitiveRepo.repoRoot,
    })
    expect(issues).toHaveLength(1)
    expect(issues?.[0]).toMatchObject({
      rule: 'root-patch-coverage',
      dependency: 'some-pkg@1.0.0',
    })
  })

  it('passes when no packages declare patches', async () => {
    const utilsComposition = catalog.compose({
      workspace: workspace({
        repoName: repo.repoName,
        memberPath: 'packages/utils',
      }),
    })
    const plainUtils = packageJson({ name: '@test/utils', version: '1.0.0' }, utilsComposition)
    const app = makeApp([plainUtils])

    const workspaceFile = pnpmWorkspaceYaml.root({
      packages: [app],
      repoName: repo.repoName,
    })

    const issues = await workspaceFile.validate?.({
      location: '.',
      cwd: repo.repoRoot,
    })
    expect(issues).toEqual([])
  })
})
