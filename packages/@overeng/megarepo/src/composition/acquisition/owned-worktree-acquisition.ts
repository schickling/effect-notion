import * as NodePath from 'node:path'

import { Effect, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'

import { EffectPath, type AbsoluteDirPath, type AbsoluteFilePath } from '@overeng/effect-path'

import { findConfigPath } from '../../core/config.ts'
import * as Git from '../../core/git.ts'
import {
  OwnedWorktreeAcquisitionError,
  type ComposedOwnedWorkspace,
  type OwnedWorktreeConfigName,
} from './owned-worktree-acquisition-schema.ts'

/** Installed owned-worktree authority passed to generation. */
export interface OwnedWorkspaceGenerationContext {
  readonly workspaceRoot: AbsoluteDirPath
  readonly ownedWorktree: AbsoluteDirPath
  readonly configPath: AbsoluteFilePath
  readonly configName: OwnedWorktreeConfigName
}

const failure = ({
  reason,
  path,
  message,
  cause,
}: {
  readonly reason: OwnedWorktreeAcquisitionError['reason']
  readonly path: string
  readonly message: string
  readonly cause?: unknown
}) =>
  new OwnedWorktreeAcquisitionError({
    reason,
    path,
    message,
    ...(cause === undefined ? {} : { cause }),
  })

const normalizePath = (path: string): string => NodePath.resolve(path)
const asDir = (path: string): AbsoluteDirPath =>
  EffectPath.unsafe.absoluteDir(`${path.replace(/\/+$/u, '')}/`)
const asFile = (path: string): AbsoluteFilePath => EffectPath.unsafe.absoluteFile(path)

/** Canonical paths for one composed workspace and its owned Git worktree. */
export interface ComposedWorkspacePaths {
  readonly workspaceRoot: string
  readonly reposPath: string
  readonly ownedWorktree: string
  readonly ownedMember: string
}

/** The only P/W path policy: W is exactly P/repos/<one canonical segment>. */
export const composedWorkspacePaths = ({
  workspaceRoot,
  ownedMember,
}: {
  readonly workspaceRoot: string
  readonly ownedMember: string
}): ComposedWorkspacePaths | undefined => {
  if (
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(ownedMember) === false ||
    ownedMember === '.' ||
    ownedMember === '..'
  )
    return undefined
  const root = normalizePath(workspaceRoot)
  const reposPath = NodePath.join(root, 'repos')
  return {
    workspaceRoot: root,
    reposPath,
    ownedWorktree: NodePath.join(reposPath, ownedMember),
    ownedMember,
  }
}

/** Resolve a Git registration to P/W only when it has the canonical composed shape. */
export const composedWorkspacePathsFromRegistration = ({
  registeredWorktree,
  expectedWorkspaceRoot,
}: {
  readonly registeredWorktree: string
  readonly expectedWorkspaceRoot?: string
}): ComposedWorkspacePaths | undefined => {
  const worktree = normalizePath(registeredWorktree)
  const reposPath = NodePath.dirname(worktree)
  if (NodePath.basename(reposPath) !== 'repos') return undefined
  const paths = composedWorkspacePaths({
    workspaceRoot: NodePath.dirname(reposPath),
    ownedMember: NodePath.basename(worktree),
  })
  if (paths === undefined || paths.ownedWorktree !== worktree) return undefined
  if (
    expectedWorkspaceRoot !== undefined &&
    paths.workspaceRoot !== normalizePath(expectedWorkspaceRoot)
  )
    return undefined
  return paths
}

const command = <A, E, R>({
  path,
  effect,
}: {
  readonly path: string
  readonly effect: Effect.Effect<A, E, R>
}): Effect.Effect<A, OwnedWorktreeAcquisitionError, R> =>
  effect.pipe(
    Effect.mapError((cause) =>
      failure({
        reason: 'CommandFailure',
        path,
        message: `Git command failed for '${path}'`,
        cause,
      }),
    ),
  )

const readConfig = (ownedWorktree: string) =>
  Effect.gen(function* () {
    const configPath = yield* findConfigPath(asDir(ownedWorktree))
    if (configPath === undefined) {
      return yield* failure({
        reason: 'ConfigMissing',
        path: ownedWorktree,
        message: `Owned checkout '${ownedWorktree}' has no megarepo.kdl or megarepo.json`,
      })
    }
    const configName = NodePath.basename(configPath)
    if (configName !== 'megarepo.kdl' && configName !== 'megarepo.json') {
      return yield* failure({
        reason: 'ConfigMissing',
        path: configPath,
        message: `Unsupported owned config '${configPath}'`,
      })
    }
    return { configPath, configName } as const
  })

const ensureRootConfig = ({
  fs,
  paths,
  configName,
  createIfMissing,
}: {
  readonly fs: FileSystem.FileSystem
  readonly paths: ComposedWorkspacePaths
  readonly configName: OwnedWorktreeConfigName
  readonly createIfMissing: boolean
}) =>
  Effect.gen(function* () {
    const rootConfig = NodePath.join(paths.workspaceRoot, configName)
    const target = NodePath.join('repos', paths.ownedMember, configName)
    const link = yield* fs.readLink(rootConfig).pipe(Effect.result)
    if (link._tag === 'Failure') {
      if ((yield* fs.exists(asFile(rootConfig))) === true || createIfMissing === false) {
        return yield* failure({
          reason: 'ConfigSymlinkInvalid',
          path: rootConfig,
          message: `Root config '${rootConfig}' must be the symlink '${target}'`,
          cause: link.failure,
        })
      }
      yield* fs.symlink(target, rootConfig).pipe(
        Effect.mapError((cause) =>
          failure({
            reason: 'ConfigSymlinkInvalid',
            path: rootConfig,
            message: `Cannot create root config symlink '${rootConfig}'`,
            cause,
          }),
        ),
      )
      return rootConfig
    }
    if (link.success !== target) {
      return yield* failure({
        reason: 'ConfigSymlinkInvalid',
        path: rootConfig,
        message: `Root config '${rootConfig}' points to '${link.success}', expected '${target}'`,
      })
    }
    return rootConfig
  })

const assertGitIdentity = ({
  fs,
  bareRepo,
  branch,
  paths,
}: {
  readonly fs: FileSystem.FileSystem
  readonly bareRepo: string
  readonly branch: string
  readonly paths: ComposedWorkspacePaths
}) =>
  Effect.gen(function* () {
    const dotGit = NodePath.join(paths.ownedWorktree, '.git')
    if ((yield* fs.exists(asFile(dotGit))) === false) {
      return yield* failure({
        reason: 'GitIdentityConflict',
        path: dotGit,
        message: `Owned checkout is missing its Git administration pointer at '${dotGit}'`,
      })
    }
    const pointer = (yield* fs.readFileString(asFile(dotGit))).trim()
    const match = /^gitdir: (.+)$/u.exec(pointer)
    const expectedAdminParent = NodePath.join(normalizePath(bareRepo), 'worktrees')
    const adminDir =
      match === null ? undefined : NodePath.resolve(NodePath.dirname(dotGit), match[1]!)
    if (
      adminDir === undefined ||
      (adminDir !== expectedAdminParent &&
        adminDir.startsWith(`${expectedAdminParent}${NodePath.sep}`) === false)
    ) {
      return yield* failure({
        reason: 'GitIdentityConflict',
        path: dotGit,
        message: `Git administration pointer '${dotGit}' does not belong to '${bareRepo}'`,
      })
    }

    const registrations = yield* command({ path: bareRepo, effect: Git.listWorktrees(bareRepo) })
    const atPath = registrations.filter(
      (candidate) => normalizePath(candidate.path) === paths.ownedWorktree,
    )
    if (atPath.length !== 1 || Option.getOrUndefined(atPath[0]!.branch) !== branch) {
      return yield* failure({
        reason: 'GitIdentityConflict',
        path: paths.ownedWorktree,
        message: `Expected exactly one '${branch}' worktree registration at '${paths.ownedWorktree}'`,
      })
    }
    const currentBranch = yield* command({
      path: paths.ownedWorktree,
      effect: Git.getCurrentBranch(asDir(paths.ownedWorktree)),
    })
    const commonDir = yield* command({
      path: paths.ownedWorktree,
      effect: Git.runCommand({
        cwd: paths.ownedWorktree,
        args: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      }),
    })
    if (
      Option.getOrUndefined(currentBranch) !== branch ||
      normalizePath(commonDir) !== normalizePath(bareRepo)
    ) {
      return yield* failure({
        reason: 'GitIdentityConflict',
        path: paths.ownedWorktree,
        message: `Owned checkout '${paths.ownedWorktree}' does not match branch '${branch}' and bare repository '${bareRepo}'`,
      })
    }
  })

/** Validate an existing composed root from Git registration and its W `.git` identity. */
export const assertComposedOwnedWorkspace = ({
  bareRepo,
  workspaceRoot,
  ownedMember,
  branch,
}: {
  readonly bareRepo: string
  readonly workspaceRoot: string
  readonly ownedMember: string
  readonly branch: string
}): Effect.Effect<
  ComposedOwnedWorkspace,
  OwnedWorktreeAcquisitionError,
  FileSystem.FileSystem | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = composedWorkspacePaths({ workspaceRoot, ownedMember })
    if (paths === undefined) {
      return yield* failure({
        reason: 'InvalidRequest',
        path: workspaceRoot,
        message: `Invalid owned member '${ownedMember}'`,
      })
    }
    yield* assertGitIdentity({ fs, bareRepo: normalizePath(bareRepo), branch, paths })
    const { configPath, configName } = yield* readConfig(paths.ownedWorktree)
    yield* ensureRootConfig({ fs, paths, configName, createIfMissing: false })
    return {
      workspaceRoot: paths.workspaceRoot,
      ownedWorktree: paths.ownedWorktree,
      defaultCwd: paths.ownedWorktree,
      configPath,
      configName,
      ownedMember,
      bareRepo: normalizePath(bareRepo),
      branch,
    }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof OwnedWorktreeAcquisitionError
        ? cause
        : failure({
            reason: 'IoFailure',
            path: workspaceRoot,
            message: `Could not validate composed workspace '${workspaceRoot}'`,
            cause,
          }),
    ),
  )

/**
 * Create W directly at P/repos/<owned>, or resume that exact Git-authoritative birth.
 * No existing worktree is moved and no path is ever deleted on failure.
 */
export const createComposedOwnedWorkspace = <R, E>({
  bareRepo: rawBareRepo,
  workspaceRoot: rawWorkspaceRoot,
  ownedMember,
  branch,
  startPoint,
  generate,
}: {
  readonly bareRepo: string
  readonly workspaceRoot: string
  readonly ownedMember: string
  readonly branch: string
  readonly startPoint?: string
  readonly generate: (context: OwnedWorkspaceGenerationContext) => Effect.Effect<void, E, R>
}): Effect.Effect<
  ComposedOwnedWorkspace,
  OwnedWorktreeAcquisitionError,
  R | FileSystem.FileSystem | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const bareRepo = normalizePath(rawBareRepo)
    const paths = composedWorkspacePaths({ workspaceRoot: rawWorkspaceRoot, ownedMember })
    if (paths === undefined || branch.length === 0 || branch.startsWith('-') === true) {
      return yield* failure({
        reason: 'InvalidRequest',
        path: rawWorkspaceRoot,
        message: `Invalid composed workspace request for member '${ownedMember}' and branch '${branch}'`,
      })
    }

    const registrations = yield* command({ path: bareRepo, effect: Git.listWorktrees(bareRepo) })
    const branchRegistrations = registrations.filter(
      (candidate) => Option.getOrUndefined(candidate.branch) === branch,
    )
    const exactRegistration = branchRegistrations.filter(
      (candidate) => normalizePath(candidate.path) === paths.ownedWorktree,
    )
    if (branchRegistrations.length > 0 && exactRegistration.length !== 1) {
      return yield* failure({
        reason: 'GitIdentityConflict',
        path: paths.ownedWorktree,
        message: `Branch '${branch}' is registered outside the required owned checkout '${paths.ownedWorktree}': ${branchRegistrations.map((entry) => entry.path).join(', ')}`,
      })
    }

    if (exactRegistration.length === 0) {
      if ((yield* fs.exists(asDir(paths.workspaceRoot))) === true) {
        const canonicalRoot = (yield* fs.realPath(asDir(paths.workspaceRoot))).replace(/\/+$/u, '')
        if (canonicalRoot !== paths.workspaceRoot) {
          return yield* failure({
            reason: 'ForeignRoot',
            path: paths.workspaceRoot,
            message: `Workspace root '${paths.workspaceRoot}' resolves to foreign path '${canonicalRoot}'`,
          })
        }
        const rootStat = yield* fs.stat(asDir(paths.workspaceRoot))
        if (rootStat.type !== 'Directory') {
          return yield* failure({
            reason: 'ForeignRoot',
            path: paths.workspaceRoot,
            message: `Workspace root '${paths.workspaceRoot}' is not a directory`,
          })
        }
        const rootEntries = yield* fs.readDirectory(asDir(paths.workspaceRoot))
        if (rootEntries.some((entry) => entry !== 'repos') === true) {
          return yield* failure({
            reason: 'ForeignRoot',
            path: paths.workspaceRoot,
            message: `Refusing existing workspace root '${paths.workspaceRoot}'; before Git registration it may contain only an empty 'repos' directory (found: ${rootEntries.join(', ')})`,
          })
        }
      }
      yield* fs.makeDirectory(asDir(paths.reposPath), { recursive: true })
      const canonicalRepos = (yield* fs.realPath(asDir(paths.reposPath))).replace(/\/+$/u, '')
      if (canonicalRepos !== paths.reposPath) {
        return yield* failure({
          reason: 'ForeignRoot',
          path: paths.reposPath,
          message: `Repos directory '${paths.reposPath}' resolves to foreign path '${canonicalRepos}'`,
        })
      }
      const repoEntries = yield* fs.readDirectory(asDir(paths.reposPath))
      if (repoEntries.length !== 0) {
        return yield* failure({
          reason: 'ForeignRoot',
          path: paths.reposPath,
          message: `Refusing non-empty unregistered repos directory '${paths.reposPath}' (found: ${repoEntries.join(', ')})`,
        })
      }
      yield* command({
        path: paths.ownedWorktree,
        effect: Git.createWorktree({
          repoPath: bareRepo,
          worktreePath: paths.ownedWorktree,
          branch,
          createBranch: startPoint !== undefined,
          ...(startPoint === undefined ? {} : { startPoint }),
        }),
      })
    }

    const { configName } = yield* readConfig(paths.ownedWorktree)
    yield* ensureRootConfig({ fs, paths, configName, createIfMissing: true })
    const composed = yield* assertComposedOwnedWorkspace({
      bareRepo,
      workspaceRoot: paths.workspaceRoot,
      ownedMember,
      branch,
    })
    const context: OwnedWorkspaceGenerationContext = {
      workspaceRoot: asDir(composed.workspaceRoot),
      ownedWorktree: asDir(composed.ownedWorktree),
      configPath: asFile(composed.configPath),
      configName: composed.configName,
    }
    yield* generate(context).pipe(
      Effect.mapError((cause) =>
        failure({
          reason: 'GenerationFailed',
          path: paths.workspaceRoot,
          message: `Composition generation failed for '${paths.workspaceRoot}'`,
          cause,
        }),
      ),
    )
    return composed
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof OwnedWorktreeAcquisitionError
        ? cause
        : failure({
            reason: 'IoFailure',
            path: rawWorkspaceRoot,
            message: `Could not create composed workspace '${rawWorkspaceRoot}'`,
            cause,
          }),
    ),
  )

/** Resolve a store branch root to W when Git registers the canonical composed shape. */
export const resolveComposedStoreWorktree = ({
  bareRepo,
  workspaceRoot,
  branch,
}: {
  readonly bareRepo: string
  readonly workspaceRoot: string
  readonly branch: string
}): Effect.Effect<
  AbsoluteDirPath | undefined,
  OwnedWorktreeAcquisitionError,
  FileSystem.FileSystem | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const registrations = yield* command({
      path: bareRepo,
      effect: Git.listWorktrees(bareRepo),
    })
    const atBranch = registrations.filter(
      (candidate) => Option.getOrUndefined(candidate.branch) === branch,
    )
    if (atBranch.length !== 1) return undefined
    const paths = composedWorkspacePathsFromRegistration({
      registeredWorktree: atBranch[0]!.path,
      expectedWorkspaceRoot: workspaceRoot,
    })
    if (paths === undefined) return undefined
    yield* assertComposedOwnedWorkspace({
      bareRepo,
      workspaceRoot,
      ownedMember: paths.ownedMember,
      branch,
    })
    return asDir(paths.ownedWorktree)
  })
