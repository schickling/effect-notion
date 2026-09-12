import * as NodePath from 'node:path'

import { Effect, Exit, Option } from 'effect'
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

/**
 * Resolve the deepest existing ancestor so path identity matches Git even when the store root is
 * a symlink and the final workspace path does not exist yet.
 */
const canonicalizePath = (path: string): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const normalized = normalizePath(path)
    const segments = normalized.split(NodePath.sep)
    for (let depth = segments.length; depth > 1; depth -= 1) {
      const existing = segments.slice(0, depth).join(NodePath.sep) || NodePath.sep
      const real = yield* fs.realPath(existing).pipe(Effect.orElseSucceed(() => undefined))
      if (real === undefined) continue
      return normalizePath(NodePath.join(real, ...segments.slice(depth)))
    }
    return normalized
  })
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

const linkedWorktreeAdminDir = ({
  fs,
  bareRepo,
  worktree,
}: {
  readonly fs: FileSystem.FileSystem
  readonly bareRepo: string
  readonly worktree: string
}) =>
  Effect.gen(function* () {
    const dotGit = NodePath.join(worktree, '.git')
    const pointer = yield* fs.readFileString(asFile(dotGit)).pipe(Effect.orElseSucceed(() => ''))
    const match = /^gitdir: (.+)$/u.exec(pointer.trim())
    const adminDir =
      match === null ? undefined : NodePath.resolve(NodePath.dirname(dotGit), match[1]!)
    return adminDir !== undefined &&
      NodePath.dirname(adminDir) === NodePath.join(bareRepo, 'worktrees')
      ? adminDir
      : undefined
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
    if (adminDir === undefined || NodePath.dirname(adminDir) !== expectedAdminParent) {
      return yield* failure({
        reason: 'GitIdentityConflict',
        path: dotGit,
        message: `Git administration pointer '${dotGit}' does not belong to '${bareRepo}'`,
      })
    }
    const backlink = NodePath.join(adminDir, 'gitdir')
    const backlinkResult = yield* fs.readFileString(asFile(backlink)).pipe(Effect.result)
    if (
      backlinkResult._tag === 'Failure' ||
      NodePath.resolve(adminDir, backlinkResult.success.trim()) !== normalizePath(dotGit)
    ) {
      return yield* failure({
        reason: 'GitIdentityConflict',
        path: backlink,
        message: `Git administration backlink '${backlink}' does not point to '${dotGit}'`,
        ...(backlinkResult._tag === 'Failure' ? { cause: backlinkResult.failure } : {}),
      })
    }

    const registrations = yield* command({ path: bareRepo, effect: Git.listWorktrees(bareRepo) })
    const atBranch = registrations.filter(
      (candidate) => Option.getOrUndefined(candidate.branch) === branch,
    )
    if (atBranch.length !== 1 || normalizePath(atBranch[0]!.path) !== paths.ownedWorktree) {
      return yield* failure({
        reason: 'GitIdentityConflict',
        path: paths.ownedWorktree,
        message: `Expected '${branch}' to have exactly one worktree registration at '${paths.ownedWorktree}'`,
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
  bareRepo: rawBareRepo,
  workspaceRoot: rawWorkspaceRoot,
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
    const bareRepo = yield* canonicalizePath(rawBareRepo)
    const workspaceRoot = yield* canonicalizePath(rawWorkspaceRoot)
    const paths = composedWorkspacePaths({ workspaceRoot, ownedMember })
    if (paths === undefined) {
      return yield* failure({
        reason: 'InvalidRequest',
        path: workspaceRoot,
        message: `Invalid owned member '${ownedMember}'`,
      })
    }
    yield* assertGitIdentity({ fs, bareRepo, branch, paths })
    const { configPath, configName } = yield* readConfig(paths.ownedWorktree)
    yield* ensureRootConfig({ fs, paths, configName, createIfMissing: false })
    return {
      workspaceRoot: paths.workspaceRoot,
      ownedWorktree: paths.ownedWorktree,
      defaultCwd: paths.ownedWorktree,
      configPath,
      configName,
      ownedMember,
      bareRepo,
      branch,
    }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof OwnedWorktreeAcquisitionError
        ? cause
        : failure({
            reason: 'IoFailure',
            path: rawWorkspaceRoot,
            message: `Could not validate composed workspace '${rawWorkspaceRoot}'`,
            cause,
          }),
    ),
  )

/**
 * Create W directly at P/repos/<owned>, or resume that exact Git-authoritative birth.
 * A failed new birth removes only the workspace artifacts created by that invocation.
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
    const bareRepo = yield* canonicalizePath(rawBareRepo)
    const workspaceRoot = yield* canonicalizePath(rawWorkspaceRoot)
    const paths = composedWorkspacePaths({ workspaceRoot, ownedMember })
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

    if (exactRegistration.length === 1) {
      const { configName } = yield* readConfig(paths.ownedWorktree)
      yield* ensureRootConfig({ fs, paths, configName, createIfMissing: true })
      const composed = yield* assertComposedOwnedWorkspace({
        bareRepo,
        workspaceRoot: paths.workspaceRoot,
        ownedMember,
        branch,
      })
      const adminDir = yield* linkedWorktreeAdminDir({
        fs,
        bareRepo,
        worktree: paths.ownedWorktree,
      })
      const clearIndexLock =
        adminDir === undefined
          ? Effect.void
          : fs.remove(NodePath.join(adminDir, 'index.lock'), { force: true }).pipe(Effect.ignore)
      yield* generate({
        workspaceRoot: asDir(composed.workspaceRoot),
        ownedWorktree: asDir(composed.ownedWorktree),
        configPath: asFile(composed.configPath),
        configName: composed.configName,
      }).pipe(
        Effect.mapError((cause) =>
          failure({
            reason: 'GenerationFailed',
            path: paths.workspaceRoot,
            message: `Composition generation failed for '${paths.workspaceRoot}'`,
            cause,
          }),
        ),
        Effect.onExit((exit) => (Exit.isFailure(exit) === true ? clearIndexLock : Effect.void)),
      )
      return composed
    }

    const workspaceRootExisted = yield* fs.exists(asDir(paths.workspaceRoot))
    if (workspaceRootExisted === true) {
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
    const reposExisted = yield* fs.exists(asDir(paths.reposPath))
    const branchExisted =
      startPoint === undefined
        ? true
        : yield* Git.refExists({ repoPath: bareRepo, ref: `refs/heads/${branch}` })

    let createdWorktree = false
    let generationStarted = false
    let createdAdminDir: string | undefined
    const rollback = Effect.gen(function* () {
      if (createdWorktree === false) {
        if (
          reposExisted === false &&
          (yield* fs.exists(asDir(paths.reposPath))) === true &&
          (yield* fs.readDirectory(asDir(paths.reposPath))).length === 0
        ) {
          yield* fs.remove(asDir(paths.reposPath), { recursive: true })
        }
        if (
          workspaceRootExisted === false &&
          (yield* fs.exists(asDir(paths.workspaceRoot))) === true &&
          (yield* fs.readDirectory(asDir(paths.workspaceRoot))).length === 0
        ) {
          yield* fs.remove(asDir(paths.workspaceRoot), { recursive: true })
        }
        return
      }

      const rootConfigs = ['megarepo.kdl', 'megarepo.json'] as const
      for (const configName of rootConfigs) {
        const rootConfig = NodePath.join(paths.workspaceRoot, configName)
        const target = NodePath.join('repos', paths.ownedMember, configName)
        const link = yield* fs.readLink(rootConfig).pipe(Effect.orElseSucceed(() => undefined))
        if (link === target) yield* fs.remove(rootConfig)
      }

      const currentRegistrations = yield* command({
        path: bareRepo,
        effect: Git.listWorktrees(bareRepo),
      })
      const registeredHere = currentRegistrations.some(
        (candidate) => normalizePath(candidate.path) === paths.ownedWorktree,
      )
      if (registeredHere === true) {
        const removed = yield* Git.removeWorktree({
          repoPath: bareRepo,
          worktreePath: paths.ownedWorktree,
          force: true,
        }).pipe(Effect.result)
        if (removed._tag === 'Failure') {
          if (createdAdminDir !== undefined) {
            yield* fs
              .remove(NodePath.join(createdAdminDir, 'index.lock'), { force: true })
              .pipe(Effect.ignore)
          }
          yield* Git.removeWorktree({
            repoPath: bareRepo,
            worktreePath: paths.ownedWorktree,
            force: true,
          })
        }
      } else if ((yield* fs.exists(asDir(paths.ownedWorktree))) === true) {
        yield* fs.remove(asDir(paths.ownedWorktree), { recursive: true })
        yield* Git.pruneWorktrees(bareRepo)
      }

      if (
        startPoint !== undefined &&
        branchExisted === false &&
        (yield* Git.refExists({ repoPath: bareRepo, ref: `refs/heads/${branch}` })) === true
      ) {
        yield* Git.deleteBranch({ repoPath: bareRepo, branch, force: true })
      }
      if (
        reposExisted === false &&
        (yield* fs.exists(asDir(paths.reposPath))) === true &&
        (yield* fs.readDirectory(asDir(paths.reposPath))).length === 0
      ) {
        yield* fs.remove(asDir(paths.reposPath), { recursive: true })
      }
      if (
        workspaceRootExisted === false &&
        (yield* fs.exists(asDir(paths.workspaceRoot))) === true &&
        (yield* fs.readDirectory(asDir(paths.workspaceRoot))).length === 0
      ) {
        yield* fs.remove(asDir(paths.workspaceRoot), { recursive: true })
      }
    })

    return yield* Effect.gen(function* () {
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
      yield* Effect.uninterruptible(
        command({
          path: paths.ownedWorktree,
          effect: Git.createWorktree({
            repoPath: bareRepo,
            worktreePath: paths.ownedWorktree,
            branch,
            createBranch: startPoint !== undefined,
            ...(startPoint === undefined ? {} : { startPoint }),
          }),
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              createdWorktree = true
            }),
          ),
        ),
      )
      createdAdminDir = yield* linkedWorktreeAdminDir({
        fs,
        bareRepo,
        worktree: paths.ownedWorktree,
      })

      const { configName } = yield* readConfig(paths.ownedWorktree)
      yield* ensureRootConfig({ fs, paths, configName, createIfMissing: true })
      const composed = yield* assertComposedOwnedWorkspace({
        bareRepo,
        workspaceRoot: paths.workspaceRoot,
        ownedMember,
        branch,
      })
      generationStarted = true
      yield* generate({
        workspaceRoot: asDir(composed.workspaceRoot),
        ownedWorktree: asDir(composed.ownedWorktree),
        configPath: asFile(composed.configPath),
        configName: composed.configName,
      }).pipe(
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
      Effect.onExit((exit) =>
        Exit.isFailure(exit) === false
          ? Effect.void
          : generationStarted === true
            ? createdAdminDir === undefined
              ? Effect.void
              : fs
                  .remove(NodePath.join(createdAdminDir, 'index.lock'), { force: true })
                  .pipe(Effect.ignore)
            : rollback,
      ),
    )
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
  bareRepo: rawBareRepo,
  workspaceRoot: rawWorkspaceRoot,
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
    const bareRepo = yield* canonicalizePath(rawBareRepo)
    const workspaceRoot = yield* canonicalizePath(rawWorkspaceRoot)
    const registrations = yield* command({
      path: bareRepo,
      effect: Git.listWorktrees(bareRepo),
    })
    const atBranch = registrations.filter(
      (candidate) => Option.getOrUndefined(candidate.branch) === branch,
    )
    if (atBranch.length === 0) return undefined
    if (atBranch.length !== 1) {
      return yield* failure({
        reason: 'GitIdentityConflict',
        path: workspaceRoot,
        message: `Branch '${branch}' has ${atBranch.length} Git worktree registrations`,
      })
    }
    const registeredWorktree = normalizePath(atBranch[0]!.path)
    if (registeredWorktree === normalizePath(workspaceRoot)) return undefined
    const paths = composedWorkspacePathsFromRegistration({
      registeredWorktree,
      expectedWorkspaceRoot: workspaceRoot,
    })
    if (paths === undefined) {
      return yield* failure({
        reason: 'GitIdentityConflict',
        path: registeredWorktree,
        message: `Branch '${branch}' is registered outside canonical P or P/repos/<owned>`,
      })
    }
    yield* assertComposedOwnedWorkspace({
      bareRepo,
      workspaceRoot,
      ownedMember: paths.ownedMember,
      branch,
    })
    return asDir(paths.ownedWorktree)
  })

/** Resolve the registered branch worktree to either canonical P or composed W. */
export const resolveStoreBranchWorktree = ({
  bareRepo: rawBareRepo,
  workspaceRoot: rawWorkspaceRoot,
  branch,
}: {
  readonly bareRepo: string
  readonly workspaceRoot: string
  readonly branch: string
}): Effect.Effect<
  AbsoluteDirPath,
  OwnedWorktreeAcquisitionError,
  FileSystem.FileSystem | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const bareRepo = yield* canonicalizePath(rawBareRepo)
    const workspaceRoot = yield* canonicalizePath(rawWorkspaceRoot)
    const registrations = yield* command({
      path: bareRepo,
      effect: Git.listWorktrees(bareRepo),
    })
    const atBranch = registrations.filter(
      (candidate) => Option.getOrUndefined(candidate.branch) === branch,
    )
    const atWorkspaceRoot = registrations.filter(
      (candidate) => normalizePath(candidate.path) === workspaceRoot,
    )
    if (atBranch.length === 0) {
      if (atWorkspaceRoot.length === 1) return asDir(workspaceRoot)
      const workspaceRootExists = yield* fs.exists(asDir(workspaceRoot)).pipe(
        Effect.mapError((cause) =>
          failure({
            reason: 'IoFailure',
            path: workspaceRoot,
            message: `Could not inspect workspace root '${workspaceRoot}'`,
            cause,
          }),
        ),
      )
      if (atWorkspaceRoot.length === 0 && workspaceRootExists === false) return asDir(workspaceRoot)
      return yield* failure({
        reason: 'GitIdentityConflict',
        path: workspaceRoot,
        message: `Workspace root '${workspaceRoot}' exists without an exact Git worktree registration for branch '${branch}'`,
      })
    }
    if (atBranch.length !== 1) {
      return yield* failure({
        reason: 'GitIdentityConflict',
        path: workspaceRoot,
        message: `Branch '${branch}' has ${atBranch.length} Git worktree registrations`,
      })
    }

    const registeredWorktree = normalizePath(atBranch[0]!.path)
    if (registeredWorktree === workspaceRoot) return asDir(workspaceRoot)
    const paths = composedWorkspacePathsFromRegistration({
      registeredWorktree,
      expectedWorkspaceRoot: workspaceRoot,
    })
    if (paths === undefined) {
      return yield* failure({
        reason: 'GitIdentityConflict',
        path: registeredWorktree,
        message: `Branch '${branch}' is registered outside canonical P or P/repos/<owned>`,
      })
    }
    yield* assertComposedOwnedWorkspace({
      bareRepo,
      workspaceRoot,
      ownedMember: paths.ownedMember,
      branch,
    })
    return asDir(paths.ownedWorktree)
  })
