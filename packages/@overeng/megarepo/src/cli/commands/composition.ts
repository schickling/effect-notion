import { execFile as execFileCallback } from 'node:child_process'
import { chmod, lstat, readdir } from 'node:fs/promises'
import * as NodePath from 'node:path'
import { promisify } from 'node:util'

import { Effect, Option, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import {
  assertComposedOwnedWorkspace,
  composedWorkspacePathsFromRegistration,
  type OwnedWorkspaceGenerationContext,
} from '../../composition/acquisition/owned-worktree-acquisition.ts'
import type {
  CompositionApplyOutput,
  CompositionApplyRequest,
  CompositionCommandOutput,
} from '../../composition/apply/composition-apply-schema.ts'
import {
  compositionApply,
  type CompositionApplyRuntime,
} from '../../composition/apply/composition-apply.ts'
import { compositionApplyRuntimeFromEnv } from '../../composition/apply/composition-runtime.ts'
import {
  findConfigPath,
  isRemoteSource,
  parseSourceString,
  readMegarepoConfig,
  type CompositionGeneratorConfig,
  type MegarepoConfig,
} from '../../core/config.ts'
import * as Git from '../../core/git.ts'
import { LOCK_FILE_NAME, readLockFile, type LockFile } from '../../core/lock.ts'
import { refreshWorkspaceRegistry } from '../../store/store-liveness.ts'
import { Store, type MegarepoStore } from '../../store/store.ts'

/** Read the lock owned by the nested Git checkout. */
export const readCompositionLockFile = ({
  ownedMemberPath,
}: {
  readonly workspaceRoot: string
  readonly ownedMemberPath: string
}) => readLockFile(EffectPath.unsafe.absoluteFile(NodePath.join(ownedMemberPath, LOCK_FILE_NAME)))

const execFile = promisify(execFileCallback)

/** Closed command-boundary failure for routine composition application. */
export class CompositionCommandError extends Schema.TaggedError<CompositionCommandError>()(
  'CompositionCommandError',
  {
    reason: Schema.Literals([
      'InvalidIdentity',
      'InvalidConfiguration',
      'LockedSourceRefused',
      'AcquisitionRefused',
      'ApplyFailed',
      'RecreateRequired',
    ]),
    message: Schema.String,
    path: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const compositionFailure = ({
  reason,
  message,
  path,
  cause,
}: {
  readonly reason: CompositionCommandError['reason']
  readonly message: string
  readonly path?: string
  readonly cause?: unknown
}) =>
  new CompositionCommandError({
    reason,
    message,
    ...(path === undefined ? {} : { path }),
    ...(cause === undefined ? {} : { cause }),
  })

const preserveCompositionError = (cause: unknown): CompositionCommandError =>
  cause instanceof CompositionCommandError
    ? cause
    : compositionFailure({ reason: 'ApplyFailed', message: 'Composition apply failed', cause })

/** Owned member identity derived from P's config symlink and W's Git registration. */
export interface OwnedIdentity {
  readonly workspaceRoot: AbsoluteDirPath
  readonly ownedMemberKey: string
  readonly ownedSourcePath: AbsoluteDirPath
  readonly ownedMemberPath: AbsoluteDirPath
  readonly bareRepo: string
  readonly branch: string
}

/** Resolve P/W from the root config and validate the Git-authoritative composed shape. */
export const loadOwnedIdentity = ({
  workspaceRoot,
}: {
  readonly workspaceRoot: AbsoluteDirPath
}): Effect.Effect<
  OwnedIdentity,
  CompositionCommandError,
  FileSystem.FileSystem | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = workspaceRoot.replace(/\/+$/u, '')
    const configPath = yield* findConfigPath(workspaceRoot)
    if (configPath === undefined) {
      return yield* compositionFailure({
        reason: 'InvalidIdentity',
        path: root,
        message: `Composition root '${root}' has no megarepo config`,
      })
    }
    const physicalConfig = yield* fs.realPath(configPath)
    const registeredWorktree = NodePath.dirname(physicalConfig)
    if (registeredWorktree === root) {
      const rootGit = EffectPath.unsafe.absoluteFile(NodePath.join(root, '.git'))
      if ((yield* fs.exists(rootGit)) === true) {
        return yield* compositionFailure({
          reason: 'RecreateRequired',
          path: root,
          message: `Legacy flat composition workspace '${root}' cannot be changed in place. Recreate it with 'mr store worktree new'.`,
        })
      }
      return yield* compositionFailure({
        reason: 'InvalidIdentity',
        path: configPath,
        message: `Composed root config '${configPath}' must resolve into '${root}/repos/<owned>'`,
      })
    }
    const paths = composedWorkspacePathsFromRegistration({
      registeredWorktree,
      expectedWorkspaceRoot: root,
    })
    if (paths === undefined) {
      return yield* compositionFailure({
        reason: 'InvalidIdentity',
        path: registeredWorktree,
        message: `Owned checkout must be exactly '${root}/repos/<owned>'`,
      })
    }
    const branchOption = yield* Git.getCurrentBranch(
      EffectPath.unsafe.absoluteDir(`${registeredWorktree}/`),
    )
    if (Option.isNone(branchOption) === true) {
      return yield* compositionFailure({
        reason: 'InvalidIdentity',
        path: registeredWorktree,
        message: `Owned checkout '${registeredWorktree}' must be branch-attached`,
      })
    }
    const bareRepo = yield* Git.runCommand({
      cwd: registeredWorktree,
      args: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    })
    yield* assertComposedOwnedWorkspace({
      bareRepo,
      workspaceRoot: root,
      ownedMember: paths.ownedMember,
      branch: branchOption.value,
    }).pipe(
      Effect.mapError((cause) =>
        compositionFailure({
          reason: 'InvalidIdentity',
          path: cause.path,
          message: cause.message,
          cause,
        }),
      ),
    )
    return {
      workspaceRoot,
      ownedMemberKey: paths.ownedMember,
      ownedSourcePath: EffectPath.unsafe.absoluteDir(`${paths.ownedWorktree}/`),
      ownedMemberPath: EffectPath.unsafe.absoluteDir(`${paths.ownedWorktree}/`),
      bareRepo,
      branch: branchOption.value,
    }
  }).pipe(Effect.mapError(preserveCompositionError))

/**
 * Detect a direct registered W independently of P's root config, then validate that the config
 * still names that exact composed identity. Ordinary Git roots are never inferred as composed.
 */
export const preflightCompositionCommand = ({
  workspaceRoot,
  compositionEnabled,
}: {
  readonly workspaceRoot: AbsoluteDirPath
  readonly compositionEnabled: boolean
}): Effect.Effect<
  OwnedIdentity | undefined,
  CompositionCommandError,
  FileSystem.FileSystem | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = workspaceRoot.replace(/\/+$/u, '')
    const rootGit = EffectPath.unsafe.absoluteFile(NodePath.join(root, '.git'))
    if ((yield* fs.exists(rootGit)) === true) {
      return compositionEnabled === true ? yield* loadOwnedIdentity({ workspaceRoot }) : undefined
    }

    const repos = EffectPath.unsafe.absoluteDir(`${NodePath.join(root, 'repos')}/`)
    const entries =
      (yield* fs.exists(repos)) === true ? yield* fs.readDirectory(repos) : ([] as string[])
    const registeredOwnedWorktrees: string[] = []
    for (const entry of entries) {
      const ownedWorktree = NodePath.join(root, 'repos', entry)
      const entryStat = yield* Effect.promise(() =>
        lstat(ownedWorktree).then(
          (info) => info,
          () => undefined,
        ),
      )
      if (entryStat?.isDirectory() !== true || entryStat.isSymbolicLink() === true) continue
      const dotGit = EffectPath.unsafe.absoluteFile(NodePath.join(ownedWorktree, '.git'))
      const dotGitStat = yield* Effect.promise(() =>
        lstat(dotGit).then(
          (info) => info,
          () => undefined,
        ),
      )
      if (dotGitStat?.isFile() !== true || dotGitStat.isSymbolicLink() === true) continue

      const pointer = (yield* fs.readFileString(dotGit)).trim()
      const match = /^gitdir: (.+)$/u.exec(pointer)
      const adminDir =
        match === null ? undefined : NodePath.resolve(NodePath.dirname(dotGit), match[1]!)
      if (adminDir === undefined || NodePath.basename(NodePath.dirname(adminDir)) !== 'worktrees') {
        return yield* compositionFailure({
          reason: 'InvalidIdentity',
          path: dotGit,
          message: `Git administration pointer '${dotGit}' is not a registered worktree identity`,
        })
      }

      const branchResult = yield* Git.getCurrentBranch(
        EffectPath.unsafe.absoluteDir(`${ownedWorktree}/`),
      ).pipe(Effect.result)
      if (branchResult._tag === 'Failure') {
        return yield* compositionFailure({
          reason: 'InvalidIdentity',
          path: ownedWorktree,
          message: `Cannot read the registered worktree branch at '${ownedWorktree}'`,
          cause: branchResult.failure,
        })
      }
      if (Option.isNone(branchResult.success) === true) continue
      const bareRepo = NodePath.dirname(NodePath.dirname(adminDir))
      const repoRoot = NodePath.dirname(bareRepo)
      const expectedRoot = NodePath.join(repoRoot, 'refs', 'heads', branchResult.success.value)
      if (NodePath.resolve(expectedRoot) !== NodePath.resolve(root)) continue
      const backlink = EffectPath.unsafe.absoluteFile(NodePath.join(adminDir, 'gitdir'))
      const backlinkResult = yield* fs.readFileString(backlink).pipe(Effect.result)
      if (
        backlinkResult._tag === 'Failure' ||
        NodePath.resolve(adminDir, backlinkResult.success.trim()) !== NodePath.resolve(dotGit)
      ) {
        return yield* compositionFailure({
          reason: 'InvalidIdentity',
          path: backlink,
          message: `Git administration backlink '${backlink}' does not point to '${dotGit}'`,
          ...(backlinkResult._tag === 'Failure' ? { cause: backlinkResult.failure } : {}),
        })
      }
      registeredOwnedWorktrees.push(ownedWorktree)
    }

    if (registeredOwnedWorktrees.length === 0) {
      return compositionEnabled === true ? yield* loadOwnedIdentity({ workspaceRoot }) : undefined
    }
    if (registeredOwnedWorktrees.length !== 1) {
      return yield* compositionFailure({
        reason: 'InvalidIdentity',
        path: repos,
        message: `Composition root '${root}' has multiple registered owned worktrees`,
      })
    }

    const identity = yield* loadOwnedIdentity({ workspaceRoot })
    if (
      NodePath.resolve(identity.ownedMemberPath) !== NodePath.resolve(registeredOwnedWorktrees[0]!)
    ) {
      return yield* compositionFailure({
        reason: 'InvalidIdentity',
        path: root,
        message: `Root config does not identify registered owned worktree '${registeredOwnedWorktrees[0]}'`,
      })
    }
    return identity
  }).pipe(Effect.mapError(preserveCompositionError))

const protectImmutableSource = async (path: string): Promise<void> => {
  const info = await lstat(path)
  if (info.isSymbolicLink() === true) return
  if (info.isDirectory() === true) {
    await Promise.all(
      (await readdir(path)).map((child) => protectImmutableSource(NodePath.join(path, child))),
    )
    await chmod(path, 0o755)
    return
  }
  if (info.isFile() === true) {
    await chmod(path, (info.mode & 0o111) === 0 ? 0o444 : 0o555)
    return
  }
  throw new TypeError(`Immutable source contains unsupported entry '${path}'`)
}

/** Admit exact clean detached commit worktrees before any composition side effect. */
export const resolveLockedCompositionMembers = ({
  configMembers,
  lockFile,
  store,
}: {
  readonly configMembers: Readonly<Record<string, string>>
  readonly lockFile: LockFile
  readonly store: MegarepoStore
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const values: Array<CompositionApplyRequest['lockedMembers'][number]> = []
    for (const [key, sourceString] of Object.entries(configMembers).toSorted(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      const source = parseSourceString(sourceString)
      if (source === undefined || isRemoteSource(source) === false) {
        return yield* compositionFailure({
          reason: 'LockedSourceRefused',
          message: `Composition member '${key}' must have an immutable remote source`,
        })
      }
      const locked = lockFile.members[key]
      if (locked === undefined) {
        return yield* compositionFailure({
          reason: 'LockedSourceRefused',
          message: `Composition apply requires a lock entry for '${key}'; run mr fetch first`,
        })
      }
      const sourcePath = store
        .getWorktreePath({ source, ref: locked.commit, refType: 'commit' })
        .replace(/\/+$/u, '')
      if ((yield* store.hasWorktree({ source, ref: locked.commit, refType: 'commit' })) === false) {
        return yield* compositionFailure({
          reason: 'LockedSourceRefused',
          path: sourcePath,
          message: `Composition apply requires immutable commit source '${sourcePath}'; run mr fetch first`,
        })
      }

      const canonicalSource = (yield* fs.realPath(sourcePath)).replace(/\/+$/u, '')
      if (canonicalSource !== sourcePath) {
        return yield* compositionFailure({
          reason: 'LockedSourceRefused',
          path: sourcePath,
          message: `Immutable source '${sourcePath}' must be its canonical store path`,
        })
      }
      const expectedNamespace = `${NodePath.sep}refs${NodePath.sep}commits${NodePath.sep}${locked.commit}`
      if (sourcePath.endsWith(expectedNamespace) === false) {
        return yield* compositionFailure({
          reason: 'LockedSourceRefused',
          path: sourcePath,
          message: `Immutable source '${sourcePath}' is outside the exact commit namespace`,
        })
      }

      const registrations = yield* Git.listWorktrees(store.getBareRepoPath(source))
      const registration = registrations.filter(
        (candidate) => candidate.path.replace(/\/+$/u, '') === sourcePath,
      )
      if (
        registration.length !== 1 ||
        registration[0]!.head !== locked.commit ||
        Option.isSome(registration[0]!.branch) === true
      ) {
        return yield* compositionFailure({
          reason: 'LockedSourceRefused',
          path: sourcePath,
          message: `Immutable source '${sourcePath}' must be one detached canonical worktree registered at '${locked.commit}'`,
        })
      }

      const actualCommit = yield* Git.getCurrentCommit(sourcePath)
      const actualBranch = yield* Git.getCurrentBranch(sourcePath)
      if (actualCommit !== locked.commit || Option.isSome(actualBranch) === true) {
        return yield* compositionFailure({
          reason: 'LockedSourceRefused',
          path: sourcePath,
          message: `Immutable source '${sourcePath}' must have detached HEAD exactly at '${locked.commit}'`,
        })
      }
      const dirtyOrUntracked = yield* Git.runCommand({
        cwd: sourcePath,
        args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      })
      if (dirtyOrUntracked.length !== 0) {
        return yield* compositionFailure({
          reason: 'LockedSourceRefused',
          path: sourcePath,
          message: `Immutable source '${sourcePath}' has tracked or untracked changes`,
        })
      }
      const ignored = yield* Git.runCommand({
        cwd: sourcePath,
        args: ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
      })
      if (ignored.length !== 0) {
        return yield* compositionFailure({
          reason: 'LockedSourceRefused',
          path: sourcePath,
          message: `Immutable source '${sourcePath}' contains ignored files; ignored bytes cannot enter R6`,
        })
      }
      yield* Effect.tryPromise({
        try: () => protectImmutableSource(sourcePath),
        catch: (cause) =>
          compositionFailure({
            reason: 'LockedSourceRefused',
            path: sourcePath,
            message: `Immutable source '${sourcePath}' could not be protected`,
            cause,
          }),
      })
      values.push({ key, sourcePath, lockedCommit: locked.commit })
    }
    return values
  }).pipe(Effect.mapError(preserveCompositionError))

/** Exact opt-out overrides tracked platform-hub cache coordinates before any overlay executes. */
export const compositionCacheSections = (
  env: Readonly<Record<string, string | undefined>>,
): CompositionApplyRequest['cacheSections'] =>
  env['BUCK2_NO_REMOTE_CACHE'] === '1'
    ? [
        {
          section: 'buck2',
          entries: [
            { key: 'remote_cache_enabled', value: 'false' },
            { key: 'allow_cache_uploads', value: 'false' },
          ],
        },
      ]
    : undefined

const compositionRequest = ({
  workspaceRoot,
  ownedMemberKey,
  ownedMemberPath,
  compositionConfig,
  locked,
  dryRun,
  env,
}: {
  readonly workspaceRoot: string
  readonly ownedMemberKey: string
  readonly ownedMemberPath: string
  readonly compositionConfig: CompositionGeneratorConfig
  readonly locked: CompositionApplyRequest['lockedMembers']
  readonly dryRun: boolean
  readonly env: Readonly<Record<string, string | undefined>>
}): CompositionApplyRequest => {
  const cacheSections = compositionCacheSections(env)
  return {
    workspaceRoot: workspaceRoot.replace(/\/+$/u, ''),
    ownedMemberKey,
    ownedMemberPath: ownedMemberPath.replace(/\/+$/u, ''),
    compositionConfig,
    ...(cacheSections === undefined ? {} : { cacheSections }),
    lockedMembers: locked,
    dryRun,
    allowVerifiedDarwinAdvance:
      compositionConfig.allowVerifiedDarwinAdvance === true ||
      env['MR_COMPOSITION_DARWIN_ADVANCE_VERIFIED'] === '1',
  }
}

const assertLockedSourceCleanPromise = async ({
  sourcePath,
  lockedCommit,
  gitPath,
}: {
  readonly sourcePath: string
  readonly lockedCommit: string
  readonly gitPath: string
}) => {
  const run = (args: ReadonlyArray<string>) =>
    execFile(gitPath, ['-C', sourcePath, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
  const head = (await run(['rev-parse', 'HEAD'])).stdout.trim()
  if (head !== lockedCommit)
    throw compositionFailure({
      reason: 'LockedSourceRefused',
      message: 'Locked source HEAD changed',
      path: sourcePath,
    })
  try {
    await run(['symbolic-ref', '-q', 'HEAD'])
    throw compositionFailure({
      reason: 'LockedSourceRefused',
      message: 'Locked source became branch-attached',
      path: sourcePath,
    })
  } catch (cause) {
    if (cause instanceof CompositionCommandError) throw cause
    if ((cause as NodeJS.ErrnoException & { code?: number }).code !== 1) throw cause
  }
  const dirty = (await run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout
  const ignored = (await run(['ls-files', '--others', '--ignored', '--exclude-standard', '-z']))
    .stdout
  if (dirty.length !== 0 || ignored.length !== 0) {
    throw compositionFailure({
      reason: 'LockedSourceRefused',
      message: 'Locked source changed after admission',
      path: sourcePath,
    })
  }
}

/** Validate the owned composition configuration before any observation or mutation. */
const assertCompositionConfig = ({
  ownedMemberKey,
  config,
  env,
}: {
  readonly ownedMemberKey: string
  readonly config: MegarepoConfig
  readonly env: Readonly<Record<string, string | undefined>>
}): Effect.Effect<CompositionGeneratorConfig, CompositionCommandError> =>
  Effect.gen(function* () {
    const compositionConfig = config.generators?.composition
    if (compositionConfig?.enabled !== true) {
      return yield* compositionFailure({
        reason: 'InvalidConfiguration',
        message: 'Composition runtime is not enabled',
      })
    }
    const ignoredMembers = compositionConfig.ignoredMembers ?? []
    if (
      ignoredMembers.some((member, index) => index > 0 && ignoredMembers[index - 1]! >= member) ===
      true
    ) {
      return yield* compositionFailure({
        reason: 'InvalidConfiguration',
        message: 'ignoredMembers must be canonical sorted unique member keys',
      })
    }
    if (env['MR_COMPOSITION_PLATFORM'] === 'darwin') {
      const folded = new Map<string, string>()
      for (const member of [ownedMemberKey, ...Object.keys(config.members)]) {
        const key = member.toLowerCase()
        const existing = folded.get(key)
        if (existing !== undefined) {
          return yield* compositionFailure({
            reason: 'InvalidConfiguration',
            message: `Member keys '${existing}' and '${member}' collide on Darwin`,
          })
        }
        folded.set(key, member)
      }
    }
    for (const member of ignoredMembers) {
      if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(member) === false) {
        return yield* compositionFailure({
          reason: 'InvalidConfiguration',
          message: `Ignored member '${member}' is invalid`,
        })
      }
      if (Object.hasOwn(config.members, member) === false) {
        return yield* compositionFailure({
          reason: 'InvalidConfiguration',
          message: `Ignored member '${member}' is not configured`,
        })
      }
      if (member === compositionConfig.platformHub || member === ownedMemberKey) {
        return yield* compositionFailure({
          reason: 'InvalidConfiguration',
          message: `Ignored member '${member}' collides with Buck authority`,
        })
      }
    }
    if (Object.hasOwn(config.members, ownedMemberKey) === true) {
      return yield* compositionFailure({
        reason: 'InvalidConfiguration',
        message: `Owned member '${ownedMemberKey}' must remain implicit`,
      })
    }
    return compositionConfig
  })

/** Admit the locked, composition-managed members recorded beside the owned authority config. */
const resolveComposedMembers = ({
  ownedSourcePath,
  config,
  compositionConfig,
  store,
}: {
  readonly ownedSourcePath: AbsoluteDirPath
  readonly config: MegarepoConfig
  readonly compositionConfig: CompositionGeneratorConfig
  readonly store: MegarepoStore
}) =>
  Effect.gen(function* () {
    const lockPath = EffectPath.ops.join(
      ownedSourcePath,
      EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
    )
    const lockOption = yield* readLockFile(lockPath)
    if (Option.isNone(lockOption) === true) {
      return yield* compositionFailure({
        reason: 'InvalidConfiguration',
        message: `Composition apply requires '${lockPath}'; run mr fetch first`,
        path: lockPath,
      })
    }
    const ignoredMembers = compositionConfig.ignoredMembers ?? []
    const composedMembers = Object.fromEntries(
      Object.entries(config.members).filter(
        ([member]) => ignoredMembers.includes(member) === false,
      ),
    )
    return yield* resolveLockedCompositionMembers({
      configMembers: composedMembers,
      lockFile: lockOption.value,
      store,
    })
  })

/** Run one composition application against a validated composed root. */
const applyCompositionAtRoot = ({
  context,
  env,
}: {
  readonly context: OwnedWorkspaceGenerationContext
  readonly env: Readonly<Record<string, string | undefined>>
}): Effect.Effect<
  CompositionApplyOutput,
  CompositionCommandError,
  FileSystem.FileSystem | ChildProcessSpawner | Store
> =>
  Effect.gen(function* () {
    const store = yield* Store
    const ownedMemberKey = NodePath.basename(context.ownedWorktree.replace(/\/+$/u, ''))
    const { config } = yield* readMegarepoConfig(context.ownedWorktree)
    const compositionConfig = yield* assertCompositionConfig({ ownedMemberKey, config, env })
    const locked = yield* resolveComposedMembers({
      ownedSourcePath: context.ownedWorktree,
      config,
      compositionConfig,
      store,
    })
    const gitPath = env['MR_COMPOSITION_GIT_BIN']
    if (gitPath === undefined) {
      return yield* compositionFailure({
        reason: 'InvalidConfiguration',
        message: 'Missing MR_COMPOSITION_GIT_BIN',
      })
    }
    const runtimeBase = compositionApplyRuntimeFromEnv({
      workspaceRoot: context.workspaceRoot.replace(/\/+$/u, ''),
      env,
    })
    const runtime = {
      ...runtimeBase,
      primitives: {
        assertLockedSourceClean: ({ sourcePath, lockedCommit }) =>
          assertLockedSourceCleanPromise({ sourcePath, lockedCommit, gitPath }),
      },
    } satisfies CompositionApplyRuntime
    return yield* compositionApply({
      request: compositionRequest({
        workspaceRoot: context.workspaceRoot,
        ownedMemberKey,
        ownedMemberPath: context.ownedWorktree,
        compositionConfig,
        locked,
        dryRun: false,
        env,
      }),
      runtime,
    })
  }).pipe(Effect.mapError(preserveCompositionError))

const generationContextFromIdentity = ({
  identity,
  configPath,
}: {
  readonly identity: OwnedIdentity
  readonly configPath: string
}): OwnedWorkspaceGenerationContext => ({
  workspaceRoot: identity.workspaceRoot,
  ownedWorktree: identity.ownedMemberPath,
  configPath: EffectPath.unsafe.absoluteFile(configPath),
  configName: NodePath.basename(configPath) === 'megarepo.kdl' ? 'megarepo.kdl' : 'megarepo.json',
})

/** Validate the composed Git shape, then plan or reconcile generated composition state. */
export const runCompositionApply = ({
  workspaceRoot,
  dryRun,
  env = process.env,
}: {
  readonly workspaceRoot: AbsoluteDirPath
  readonly dryRun: boolean
  readonly env?: Readonly<Record<string, string | undefined>>
}): Effect.Effect<
  CompositionCommandOutput,
  CompositionCommandError,
  FileSystem.FileSystem | ChildProcessSpawner | Store
> =>
  Effect.gen(function* () {
    const store = yield* Store
    const identity = yield* loadOwnedIdentity({ workspaceRoot })
    const { config } = yield* readMegarepoConfig(identity.ownedSourcePath)
    const compositionConfig = yield* assertCompositionConfig({
      ownedMemberKey: identity.ownedMemberKey,
      config,
      env,
    })

    if (dryRun === true) {
      const locked = yield* resolveComposedMembers({
        ownedSourcePath: identity.ownedSourcePath,
        config,
        compositionConfig,
        store,
      })
      const runtimeBase = compositionApplyRuntimeFromEnv({
        workspaceRoot: identity.workspaceRoot.replace(/\/+$/u, ''),
        env,
      })
      const runtime = {
        ...runtimeBase,
        primitives: {
          assertLockedSourceClean: ({ sourcePath, lockedCommit }) =>
            assertLockedSourceCleanPromise({
              sourcePath,
              lockedCommit,
              gitPath: env['MR_COMPOSITION_GIT_BIN']!,
            }),
        },
      } satisfies CompositionApplyRuntime
      const composition = yield* compositionApply({
        request: compositionRequest({
          workspaceRoot: identity.workspaceRoot,
          ownedMemberKey: identity.ownedMemberKey,
          ownedMemberPath: identity.ownedMemberPath,
          compositionConfig,
          locked,
          dryRun: true,
          env,
        }),
        runtime,
      })
      return {
        _tag: 'CompositionDryRun',
        composition,
        workspaceRoot: identity.workspaceRoot,
        defaultCwd: identity.ownedMemberPath,
      } satisfies CompositionCommandOutput
    }

    const observed = yield* assertComposedOwnedWorkspace({
      bareRepo: identity.bareRepo,
      workspaceRoot: identity.workspaceRoot,
      ownedMember: identity.ownedMemberKey,
      branch: identity.branch,
    }).pipe(
      Effect.mapError((cause) =>
        compositionFailure({
          reason: 'AcquisitionRefused',
          message: cause.message,
          path: cause.path,
          cause,
        }),
      ),
    )
    const composition = yield* applyCompositionAtRoot({
      context: generationContextFromIdentity({ identity, configPath: observed.configPath }),
      env,
    })
    yield* refreshWorkspaceRegistry({
      workspaceRoot: identity.workspaceRoot,
      store,
      now: Date.now(),
    })
    return {
      _tag: 'CompositionApplied',
      composition,
      workspaceRoot: identity.workspaceRoot,
      defaultCwd: identity.ownedMemberPath,
    } satisfies CompositionCommandOutput
  }).pipe(Effect.mapError(preserveCompositionError))
