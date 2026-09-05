import { execFile as execFileCallback } from 'node:child_process'
import { readFile as readNodeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'
import { promisify } from 'node:util'

import { Effect, Option, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'
import {
  BUCK_MEMBER_MANIFEST_FILENAME,
  decodeBuckMemberManifestJson,
  type BuckMemberManifest,
} from '@overeng/megarepo/buck2-manifest'

import {
  OWNED_WORKTREE_ROOT_MANIFEST,
  OwnedWorktreeAcquisitionJournal,
  OwnedWorktreeRootManifest,
} from '../../composition/acquisition/owned-worktree-acquisition-schema.ts'
import {
  acquireOwnedWorktree,
  ownedWorktreeAcquisitionJournalPath,
  planOwnedWorktreeAcquisition,
  recoverOwnedWorktreeAcquisition,
  type OwnedWorkspaceGenerationContext,
} from '../../composition/acquisition/owned-worktree-acquisition.ts'
import type {
  CompositionApplyOutput,
  CompositionApplyRequest,
  CompositionCommandOutput,
} from '../../composition/apply/composition-apply-schema.ts'
import { compositionApply } from '../../composition/apply/composition-apply.ts'
import { compositionApplyRuntimeFromEnv } from '../../composition/apply/composition-runtime.ts'
import { resolveCompositionCapabilities } from '../../composition/capabilities/composition-capability-resolver.ts'
import {
  getMemberPath,
  isRemoteSource,
  parseSourceString,
  readMegarepoConfig,
  type CompositionGeneratorConfig,
} from '../../core/config.ts'
import * as Git from '../../core/git.ts'
import { LOCK_FILE_NAME, readLockFile, type LockFile } from '../../core/lock.ts'
import { refreshWorkspaceRegistry } from '../../store/store-liveness.ts'
import { Store, type MegarepoStore } from '../../store/store.ts'

const strictParseOptions = { errors: 'all', onExcessProperty: 'error' } as const

/** Read the authoritative lock before or after owned-worktree acquisition. */
export const readCompositionLockFile = ({
  workspaceRoot,
  ownedMemberPath,
}: {
  readonly workspaceRoot: string
  readonly ownedMemberPath: string
}) =>
  Effect.gen(function* () {
    const ownedLock = yield* readLockFile(
      EffectPath.unsafe.absoluteFile(NodePath.join(ownedMemberPath, LOCK_FILE_NAME)),
    )
    if (Option.isSome(ownedLock) === true) return ownedLock
    return yield* readLockFile(
      EffectPath.unsafe.absoluteFile(NodePath.join(workspaceRoot, LOCK_FILE_NAME)),
    )
  })
const execFile = promisify(execFileCallback)
const OwnedManifestJson = Schema.fromJsonString(OwnedWorktreeRootManifest)
const AcquisitionJournalJson = Schema.fromJsonString(OwnedWorktreeAcquisitionJournal)

/** Closed command-boundary failure for Phase-2 composition cutover. */
export class CompositionCutoverError extends Schema.TaggedError<CompositionCutoverError>()(
  'CompositionCutoverError',
  {
    reason: Schema.Literals([
      'InvalidIdentity',
      'InvalidConfiguration',
      'LockedSourceRefused',
      'AcquisitionRefused',
      'ApplyFailed',
    ]),
    message: Schema.String,
    path: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const cutoverFailure = ({
  reason,
  message,
  path,
  cause,
}: {
  readonly reason: CompositionCutoverError['reason']
  readonly message: string
  readonly path?: string
  readonly cause?: unknown
}) =>
  new CompositionCutoverError({
    reason,
    message,
    ...(path === undefined ? {} : { path }),
    ...(cause === undefined ? {} : { cause }),
  })

const preserveCutoverError = (cause: unknown): CompositionCutoverError =>
  cause instanceof CompositionCutoverError
    ? cause
    : cutoverFailure({ reason: 'ApplyFailed', message: 'Composition cutover failed', cause })

/** Owned member identity established from durable acquisition authority. */
export interface OwnedIdentity {
  readonly workspaceRoot: AbsoluteDirPath
  readonly ownedMemberKey: string
  readonly ownedSourcePath: AbsoluteDirPath
  readonly ownedMemberPath: AbsoluteDirPath
  readonly bareRepo: string
  readonly branch: string
  readonly synthesized: boolean
}

const ownedKeyFromManifest = (manifest: BuckMemberManifest): string => {
  const match = /^repos\/([A-Za-z0-9][A-Za-z0-9._-]*)$/u.exec(manifest.mount)
  if (match === null)
    throw new TypeError(`Owned manifest mount must be repos/<member>: ${manifest.mount}`)
  return match[1]!
}

const readManifest = ({
  fs,
  memberRoot,
}: {
  readonly fs: FileSystem.FileSystem
  readonly memberRoot: string
}) =>
  fs
    .readFileString(
      EffectPath.unsafe.absoluteFile(NodePath.join(memberRoot, BUCK_MEMBER_MANIFEST_FILENAME)),
    )
    .pipe(Effect.map(decodeBuckMemberManifestJson))

const readManifestPromise = async (memberRoot: string): Promise<BuckMemberManifest> =>
  decodeBuckMemberManifestJson(
    await readNodeFile(NodePath.join(memberRoot, BUCK_MEMBER_MANIFEST_FILENAME), 'utf8'),
  )

const deriveLegacyIdentity = ({
  workspaceRoot,
  manifest,
}: {
  readonly workspaceRoot: AbsoluteDirPath
  readonly manifest: BuckMemberManifest
}) =>
  Effect.gen(function* () {
    const branchOption = yield* Git.getCurrentBranch(workspaceRoot)
    if (Option.isNone(branchOption) === true) {
      return yield* cutoverFailure({
        reason: 'InvalidIdentity',
        message: 'Composition requires a branch-attached owned worktree',
      })
    }
    const bareRepo = yield* Git.runCommand({
      cwd: workspaceRoot,
      args: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    })
    const ownedMemberKey = ownedKeyFromManifest(manifest)
    return {
      workspaceRoot,
      ownedMemberKey,
      ownedSourcePath: workspaceRoot,
      ownedMemberPath: getMemberPath({ megarepoRoot: workspaceRoot, name: ownedMemberKey }),
      bareRepo,
      branch: branchOption.value,
      synthesized: false,
    } satisfies OwnedIdentity
  })

const readOwnedIdentity = ({
  workspaceRoot,
  fs,
}: {
  readonly workspaceRoot: AbsoluteDirPath
  readonly fs: FileSystem.FileSystem
}) =>
  Effect.gen(function* () {
    const manifestPath = EffectPath.unsafe.absoluteFile(
      NodePath.join(workspaceRoot, OWNED_WORKTREE_ROOT_MANIFEST),
    )
    const rootManifest = yield* fs
      .readFileString(manifestPath)
      .pipe(
        Effect.flatMap((bytes) =>
          Schema.decodeUnknownEffect(OwnedManifestJson, strictParseOptions)(bytes),
        ),
      )
    const ownedMemberPath = getMemberPath({
      megarepoRoot: workspaceRoot,
      name: rootManifest.ownedMember,
    })
    return {
      workspaceRoot,
      ownedMemberKey: rootManifest.ownedMember,
      ownedSourcePath: ownedMemberPath,
      ownedMemberPath,
      bareRepo: rootManifest.bareRepo,
      branch: rootManifest.branchRef.slice('refs/heads/'.length),
      synthesized: true,
    } satisfies OwnedIdentity
  })

/** Load the owned member independently from the configured platform hub. */
export const loadOwnedIdentity = ({
  workspaceRoot,
}: {
  readonly workspaceRoot: AbsoluteDirPath
}): Effect.Effect<
  OwnedIdentity,
  CompositionCutoverError,
  FileSystem.FileSystem | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const managedManifestPath = EffectPath.unsafe.absoluteFile(
      NodePath.join(workspaceRoot, OWNED_WORKTREE_ROOT_MANIFEST),
    )
    if ((yield* fs.exists(managedManifestPath)) === true) {
      return yield* readOwnedIdentity({ workspaceRoot, fs })
    }
    const journalPath = EffectPath.unsafe.absoluteFile(
      ownedWorktreeAcquisitionJournalPath(workspaceRoot),
    )
    if ((yield* fs.exists(journalPath)) === true) {
      const journal = yield* fs
        .readFileString(journalPath)
        .pipe(
          Effect.flatMap((bytes) =>
            Schema.decodeUnknownEffect(AcquisitionJournalJson, strictParseOptions)(bytes),
          ),
        )
      const ownedMemberPath = getMemberPath({
        megarepoRoot: workspaceRoot,
        name: journal.ownedMember,
      })
      const installed = yield* fs.exists(ownedMemberPath)
      const temporary = EffectPath.unsafe.absoluteDir(`${journal.tempPath}/`)
      return {
        workspaceRoot,
        ownedMemberKey: journal.ownedMember,
        ownedSourcePath: installed === true ? ownedMemberPath : temporary,
        ownedMemberPath,
        bareRepo: journal.bareRepo,
        branch: journal.branchRef.slice('refs/heads/'.length),
        synthesized: false,
      } satisfies OwnedIdentity
    }
    const manifest = yield* readManifest({ fs, memberRoot: workspaceRoot })
    return yield* deriveLegacyIdentity({ workspaceRoot, manifest })
  }).pipe(
    Effect.mapError((cause) =>
      cutoverFailure({
        reason: 'InvalidIdentity',
        message: `Could not establish owned composition identity for '${workspaceRoot}'`,
        path: workspaceRoot,
        cause,
      }),
    ),
  )

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
        return yield* cutoverFailure({
          reason: 'LockedSourceRefused',
          message: `Composition member '${key}' must have an immutable remote source`,
        })
      }
      const locked = lockFile.members[key]
      if (locked === undefined) {
        return yield* cutoverFailure({
          reason: 'LockedSourceRefused',
          message: `Composition apply requires a lock entry for '${key}'; run mr fetch first`,
        })
      }
      const sourcePath = store
        .getWorktreePath({ source, ref: locked.commit, refType: 'commit' })
        .replace(/\/+$/u, '')
      if ((yield* store.hasWorktree({ source, ref: locked.commit, refType: 'commit' })) === false) {
        return yield* cutoverFailure({
          reason: 'LockedSourceRefused',
          path: sourcePath,
          message: `Composition apply requires immutable commit source '${sourcePath}'; run mr fetch first`,
        })
      }

      const canonicalSource = (yield* fs.realPath(sourcePath)).replace(/\/+$/u, '')
      if (canonicalSource !== sourcePath) {
        return yield* cutoverFailure({
          reason: 'LockedSourceRefused',
          path: sourcePath,
          message: `Immutable source '${sourcePath}' must be its canonical store path`,
        })
      }
      const expectedNamespace = `${NodePath.sep}refs${NodePath.sep}commits${NodePath.sep}${locked.commit}`
      if (sourcePath.endsWith(expectedNamespace) === false) {
        return yield* cutoverFailure({
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
        return yield* cutoverFailure({
          reason: 'LockedSourceRefused',
          path: sourcePath,
          message: `Immutable source '${sourcePath}' must be one detached canonical worktree registered at '${locked.commit}'`,
        })
      }

      const actualCommit = yield* Git.getCurrentCommit(sourcePath)
      const actualBranch = yield* Git.getCurrentBranch(sourcePath)
      if (actualCommit !== locked.commit || Option.isSome(actualBranch) === true) {
        return yield* cutoverFailure({
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
        return yield* cutoverFailure({
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
        return yield* cutoverFailure({
          reason: 'LockedSourceRefused',
          path: sourcePath,
          message: `Immutable source '${sourcePath}' contains ignored files; ignored bytes cannot enter R6`,
        })
      }
      values.push({ key, sourcePath, lockedCommit: locked.commit })
    }
    return values
  }).pipe(Effect.mapError(preserveCutoverError))

/**
 * Derive root cache policy before the first composition overlay can execute.
 *
 * This is the only CI-reachable injection point: `[buck2_re_client]` is honored from a
 * buckconfig FILE and never from a `-c` override, and no devenv shell (which is what
 * materializes `.buckconfig.local` for developers) has been entered by the time the first
 * overlay runs.
 *
 * Precedence is deliberate:
 *   1. `BUCK2_NO_REMOTE_CACHE=1` wins and hard-disables lookup and upload.
 *   2. An endpoint and an explicit instance name, supplied TOGETHER, enable a cache-only
 *      client against exactly that named instance.
 *   3. Nothing set keeps the shared-cache-free default.
 *
 * There is no default instance name. Half a pair is refused rather than completed, because
 * an endpoint with an implied instance is precisely how a staged run writes production keys
 * by accident.
 */
export const compositionCacheSections = (
  env: Readonly<Record<string, string | undefined>>,
): CompositionApplyRequest['cacheSections'] => {
  if (env['BUCK2_NO_REMOTE_CACHE'] === '1')
    return [
      {
        section: 'buck2',
        entries: [
          { key: 'remote_cache_enabled', value: 'false' },
          { key: 'allow_cache_uploads', value: 'false' },
        ],
      },
    ]
  const endpoint = (env['BUCK2_CACHE_ENDPOINT'] ?? '').trim()
  const instanceName = (env['BUCK2_CACHE_INSTANCE_NAME'] ?? '').trim()
  if (endpoint === '' && instanceName === '') return []
  if (endpoint === '' || instanceName === '')
    throw cutoverFailure({
      reason: 'InvalidConfiguration',
      message:
        'BUCK2_CACHE_ENDPOINT and BUCK2_CACHE_INSTANCE_NAME must be set together; a shared-cache endpoint without an explicit instance name is refused',
    })
  return [
    {
      section: 'buck2',
      entries: [
        { key: 'digest_algorithms', value: 'SHA256' },
        { key: 'default_allow_cache_upload', value: 'true' },
      ],
    },
    {
      section: 'buck2_re_client',
      entries: [
        { key: 'engine_address', value: endpoint },
        { key: 'action_cache_address', value: endpoint },
        { key: 'cas_address', value: endpoint },
        { key: 'instance_name', value: instanceName },
        { key: 'tls', value: 'false' },
        // Explicit 4 MiB upload batch ceiling. Both gRPC peers default to a 4 MiB message
        // limit, so an implicit batch that grows past it fails the upload at the transport
        // instead of at a config boundary we control. Stated here rather than inherited so
        // an upstream default change cannot silently move it.
        { key: 'max_total_batch_size', value: '4194304' },
      ],
    },
  ]
}

const compositionRequest = ({
  identity,
  compositionConfig,
  locked,
  dryRun,
  env,
}: {
  readonly identity: OwnedIdentity
  readonly compositionConfig: CompositionGeneratorConfig
  readonly locked: CompositionApplyRequest['lockedMembers']
  readonly dryRun: boolean
  readonly env: Readonly<Record<string, string | undefined>>
}): CompositionApplyRequest => ({
  workspaceRoot: identity.workspaceRoot.replace(/\/+$/u, ''),
  ownedMemberKey: identity.ownedMemberKey,
  ownedMemberPath: identity.ownedMemberPath.replace(/\/+$/u, ''),
  compositionConfig,
  cacheSections: compositionCacheSections(env),
  lockedMembers: locked,
  dryRun,
  allowVerifiedDarwinAdvance:
    compositionConfig.allowVerifiedDarwinAdvance === true ||
    env['MR_COMPOSITION_DARWIN_ADVANCE_VERIFIED'] === '1',
})

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
    throw cutoverFailure({
      reason: 'LockedSourceRefused',
      message: 'Locked source HEAD changed',
      path: sourcePath,
    })
  try {
    await run(['symbolic-ref', '-q', 'HEAD'])
    throw cutoverFailure({
      reason: 'LockedSourceRefused',
      message: 'Locked source became branch-attached',
      path: sourcePath,
    })
  } catch (cause) {
    if (cause instanceof CompositionCutoverError) throw cause
    if ((cause as NodeJS.ErrnoException & { code?: number }).code !== 1) throw cause
  }
  const dirty = (await run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout
  const ignored = (await run(['ls-files', '--others', '--ignored', '--exclude-standard', '-z']))
    .stdout
  if (dirty.length !== 0 || ignored.length !== 0) {
    throw cutoverFailure({
      reason: 'LockedSourceRefused',
      message: 'Locked source changed after admission',
      path: sourcePath,
    })
  }
}

/** Apply decision-0020 composition or produce its exact acquisition and application plans. */
export const runCompositionApply = ({
  workspaceRoot,
  dryRun,
  callerCwd,
  env = process.env,
}: {
  readonly workspaceRoot: AbsoluteDirPath
  readonly dryRun: boolean
  readonly callerCwd: AbsoluteDirPath
  readonly env?: Readonly<Record<string, string | undefined>>
}): Effect.Effect<
  CompositionCommandOutput,
  CompositionCutoverError,
  FileSystem.FileSystem | ChildProcessSpawner | Store
> =>
  Effect.gen(function* () {
    const store = yield* Store
    const identity = yield* loadOwnedIdentity({ workspaceRoot })
    const { config } = yield* readMegarepoConfig(identity.ownedSourcePath)
    const compositionConfig = config.generators?.composition
    if (compositionConfig?.enabled !== true) {
      return yield* cutoverFailure({
        reason: 'InvalidConfiguration',
        message: 'Composition runtime is not enabled',
      })
    }
    const ignoredMembers = compositionConfig.ignoredMembers ?? []
    if (
      ignoredMembers.some((member, index) => index > 0 && ignoredMembers[index - 1]! >= member) ===
      true
    ) {
      return yield* cutoverFailure({
        reason: 'InvalidConfiguration',
        message: 'ignoredMembers must be canonical sorted unique member keys',
      })
    }
    if (env['MR_COMPOSITION_PLATFORM'] === 'darwin') {
      const folded = new Map<string, string>()
      for (const member of [identity.ownedMemberKey, ...Object.keys(config.members)]) {
        const key = member.toLowerCase()
        const existing = folded.get(key)
        if (existing !== undefined) {
          return yield* cutoverFailure({
            reason: 'InvalidConfiguration',
            message: `Member keys '${existing}' and '${member}' collide on Darwin`,
          })
        }
        folded.set(key, member)
      }
    }
    for (const member of ignoredMembers) {
      if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(member) === false) {
        return yield* cutoverFailure({
          reason: 'InvalidConfiguration',
          message: `Ignored member '${member}' is invalid`,
        })
      }
      if (Object.hasOwn(config.members, member) === false) {
        return yield* cutoverFailure({
          reason: 'InvalidConfiguration',
          message: `Ignored member '${member}' is not configured`,
        })
      }
      if (member === compositionConfig.platformHub || member === identity.ownedMemberKey) {
        return yield* cutoverFailure({
          reason: 'InvalidConfiguration',
          message: `Ignored member '${member}' collides with Buck authority`,
        })
      }
    }
    if (Object.hasOwn(config.members, identity.ownedMemberKey) === true) {
      return yield* cutoverFailure({
        reason: 'InvalidConfiguration',
        message: `Owned member '${identity.ownedMemberKey}' must remain implicit`,
      })
    }
    const lockPath = EffectPath.ops.join(
      identity.ownedSourcePath,
      EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
    )
    const lockOption = yield* readLockFile(lockPath)
    if (Option.isNone(lockOption) === true) {
      return yield* cutoverFailure({
        reason: 'InvalidConfiguration',
        message: `Composition apply requires '${lockPath}'; run mr fetch first`,
        path: lockPath,
      })
    }
    const composedMembers = Object.fromEntries(
      Object.entries(config.members).filter(
        ([member]) => ignoredMembers.includes(member) === false,
      ),
    )
    const locked = yield* resolveLockedCompositionMembers({
      configMembers: composedMembers,
      lockFile: lockOption.value,
      store,
    })
    const acquisition = yield* planOwnedWorktreeAcquisition({
      bareRepo: identity.bareRepo,
      workspaceRoot: identity.workspaceRoot,
      ownedMember: identity.ownedMemberKey,
      branch: identity.branch,
      callerCwd,
    })
    if (acquisition._tag === 'Refused') {
      return yield* cutoverFailure({
        reason: 'AcquisitionRefused',
        message: acquisition.error.message,
        cause: acquisition.error,
      })
    }

    if (dryRun === true) {
      const runtimeBase = compositionApplyRuntimeFromEnv({
        workspaceRoot: identity.workspaceRoot.replace(/\/+$/u, ''),
        env,
      })
      const plannedIdentity = {
        ...identity,
        ownedMemberPath: EffectPath.unsafe.absoluteDir(`${acquisition.ownedWorktree}/`),
      }
      const runtime = {
        ...runtimeBase,
        primitives: {
          assertLockedSourceClean: ({ sourcePath, lockedCommit }) =>
            assertLockedSourceCleanPromise({
              sourcePath,
              lockedCommit,
              gitPath: env['MR_COMPOSITION_GIT_BIN']!,
            }),
          readManifest: (memberRoot: string) =>
            memberRoot === acquisition.ownedWorktree
              ? readManifestPromise(identity.ownedSourcePath)
              : readManifestPromise(memberRoot),
          resolveCapabilities: (input) =>
            resolveCompositionCapabilities({
              ...input,
              memberRoot:
                input.memberRoot === acquisition.ownedWorktree
                  ? identity.ownedSourcePath.replace(/\/+$/u, '')
                  : input.memberRoot,
            }),
        },
      } satisfies ReturnType<typeof compositionApplyRuntimeFromEnv>
      const composition = yield* compositionApply({
        request: compositionRequest({
          identity: plannedIdentity,
          compositionConfig,
          locked,
          dryRun: true,
          env,
        }),
        runtime,
      })
      return {
        _tag: 'CompositionDryRun',
        acquisition,
        composition,
        workspaceRoot: identity.workspaceRoot,
        defaultCwd: acquisition.ownedWorktree,
      } satisfies CompositionCommandOutput
    }

    let composition: CompositionApplyOutput | undefined
    const generate = (context: OwnedWorkspaceGenerationContext) => {
      const appliedIdentity: OwnedIdentity = {
        ...identity,
        ownedSourcePath: context.ownedWorktree,
        ownedMemberPath: context.ownedWorktree,
        synthesized: true,
      }
      const runtimeBase = compositionApplyRuntimeFromEnv({
        workspaceRoot: context.workspaceRoot.replace(/\/+$/u, ''),
        env,
      })
      const gitPath = env['MR_COMPOSITION_GIT_BIN']
      if (gitPath === undefined)
        throw cutoverFailure({
          reason: 'InvalidConfiguration',
          message: 'Missing MR_COMPOSITION_GIT_BIN',
        })
      const runtime = {
        ...runtimeBase,
        primitives: {
          assertLockedSourceClean: ({ sourcePath, lockedCommit }) =>
            assertLockedSourceCleanPromise({ sourcePath, lockedCommit, gitPath }),
        },
      } satisfies typeof runtimeBase
      return compositionApply({
        request: compositionRequest({
          identity: appliedIdentity,
          compositionConfig,
          locked,
          dryRun: false,
          env,
        }),
        runtime,
      }).pipe(
        Effect.tap((output) => Effect.sync(() => (composition = output))),
        Effect.asVoid,
      )
    }

    if (acquisition._tag === 'Recover') {
      const recovered = yield* recoverOwnedWorktreeAcquisition({
        workspaceRoot: identity.workspaceRoot,
        generate,
      })
      if (recovered._tag === 'RolledBack') {
        yield* acquireOwnedWorktree({
          bareRepo: identity.bareRepo,
          workspaceRoot: identity.workspaceRoot,
          ownedMember: identity.ownedMemberKey,
          branch: identity.branch,
          callerCwd,
          generate,
        })
      }
    } else {
      const acquired = yield* acquireOwnedWorktree({
        bareRepo: identity.bareRepo,
        workspaceRoot: identity.workspaceRoot,
        ownedMember: identity.ownedMemberKey,
        branch: identity.branch,
        callerCwd,
        generate,
      })
      if (composition === undefined) {
        yield* generate({
          workspaceRoot: EffectPath.unsafe.absoluteDir(`${acquired.workspaceRoot}/`),
          ownedWorktree: EffectPath.unsafe.absoluteDir(`${acquired.ownedWorktree}/`),
          configPath: EffectPath.unsafe.absoluteFile(acquired.configPath),
          configName: acquired.configName,
        })
      }
    }
    if (composition === undefined) {
      return yield* cutoverFailure({
        reason: 'ApplyFailed',
        message: `Composition generation did not complete; recover '${ownedWorktreeAcquisitionJournalPath(identity.workspaceRoot)}'`,
      })
    }
    yield* refreshWorkspaceRegistry({
      workspaceRoot: identity.workspaceRoot,
      store,
      now: Date.now(),
    })
    return {
      _tag: 'CompositionApplied',
      acquisition,
      composition,
      workspaceRoot: identity.workspaceRoot,
      defaultCwd: identity.ownedMemberPath,
    } satisfies CompositionCommandOutput
  }).pipe(Effect.mapError(preserveCutoverError))
