/**
 * Status Command
 *
 * Show workspace status and member states.
 */

import { Clock, Effect, Option, type Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { type PlatformError } from 'effect/PlatformError'
import * as Cli from 'effect/unstable/cli'
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'
import React from 'react'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'
import { run } from '@overeng/tui-react'

import { teardownCpAMemberMount } from '../../composition/mounts/member-mount-cp-a.ts'
import {
  readOwnedCpAMountMetadata,
  type OwnedCpAMountMetadataError,
} from '../../composition/mounts/member-mount-r6.ts'
import {
  ConfigNotFoundError,
  findConfigPath,
  getMemberPath,
  isRemoteSource,
  parseSourceString,
  readMegarepoConfig,
} from '../../core/config.ts'
import * as Git from '../../core/git.ts'
import { detectRefMismatch, type RefMismatch } from '../../core/issues.ts'
import { checkLockStaleness, LOCK_FILE_NAME, readLockFile } from '../../core/lock.ts'
import { type MegarepoTraversal, withMegarepoTraversal } from '../../core/megarepo-traversal.ts'
import { extractRefFromSymlinkPath } from '../../core/ref.ts'
import { refreshWorkspaceRegistry } from '../../store/store-liveness.ts'
import { Store, StoreLayer } from '../../store/store.ts'
import {
  Cwd,
  detectCurrentMemberPath,
  findMegarepoRoot,
  outputOption,
  outputModeLayer,
} from '../context.ts'
import { NotInMegarepoError } from '../errors.ts'
import * as Observability from '../observability.ts'
import { StatusApp, StatusView } from '../renderers/StatusOutput/mod.ts'
import type {
  CommitDrift,
  GitStatus,
  MemberStatus,
  StaleLock,
  SymlinkDrift,
} from '../renderers/StatusOutput/mod.ts'
import { preflightCompositionCommand, type CompositionCommandError } from './composition.ts'

/**
 * Recursively scan members and build status tree.
 * @param megarepoRoot - Root path of the megarepo
 * @param all - Whether to recurse into nested megarepos
 * @param traversal - Shared traversal state keyed by canonical root identity
 */
const scanMembersRecursive = ({
  megarepoRoot,
  all,
  traversal,
  depth = 0,
}: {
  megarepoRoot: AbsoluteDirPath
  all: boolean
  traversal: MegarepoTraversal
  depth?: number
}): Effect.Effect<
  MemberStatus[],
  | PlatformError
  | Schema.SchemaError
  | Git.GitCommandError
  | OwnedCpAMountMetadataError
  | CompositionCommandError,
  FileSystem.FileSystem | ChildProcessSpawner | Store
> =>
  Effect.gen(function* () {
    const enterResult = yield* traversal.enterRoot({ root: megarepoRoot, depth })
    if (enterResult._tag === 'Cycle') {
      return []
    }

    const fs = yield* FileSystem.FileSystem

    // Load config
    const configResult = yield* readMegarepoConfig(megarepoRoot).pipe(
      Effect.catchIf(
        (e): e is ConfigNotFoundError => e instanceof ConfigNotFoundError,
        () => Effect.void,
      ),
    )
    if (configResult === undefined) {
      return []
    }
    const { config, path: configPath } = configResult
    const compositionEnabled = config.generators?.composition?.enabled === true
    const ignoredMembers = new Set(config.generators?.composition?.ignoredMembers ?? [])
    const compositionIdentity = yield* preflightCompositionCommand({
      workspaceRoot: megarepoRoot,
      compositionEnabled,
    })
    const ownedMemberKey = compositionIdentity?.ownedMemberKey

    // Load lock file (optional)
    const configOwner =
      compositionIdentity?.ownedSourcePath ??
      EffectPath.ops.parent(EffectPath.unsafe.absoluteFile(yield* fs.realPath(configPath))) ??
      megarepoRoot
    const lockPath = EffectPath.ops.join(
      configOwner,
      EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
    )
    const lockFileOpt = yield* readLockFile(lockPath)
    const lockFile = Option.getOrUndefined(lockFileOpt)

    // Build member status list
    const members: MemberStatus[] = []
    const effectiveMembers: ReadonlyArray<readonly [string, string]> = [
      ...(ownedMemberKey === undefined ? [] : [[ownedMemberKey, 'owned:branch'] as const]),
      ...Object.entries(config.members),
    ]
    for (const [memberName, sourceString] of effectiveMembers) {
      const isOwned = memberName === ownedMemberKey
      const compositionManaged =
        compositionEnabled === true && ignoredMembers.has(memberName) === false
      const memberPath = getMemberPath({ megarepoRoot, name: memberName })
      const source = isOwned === true ? undefined : parseSourceString(sourceString)
      const isLocal = source?.type === 'path'
      const lockedMember = lockFile?.members[memberName]

      const symlinkPath = memberPath.replace(/\/$/, '')
      const pathExists = yield* fs.exists(symlinkPath)
      let symlinkExists = compositionManaged === false ? pathExists : isOwned === true && pathExists
      let memberExists = pathExists
      let mountKind: MemberStatus['mountKind'] = isOwned === true ? 'owned' : undefined
      let mountedCommit: string | undefined
      if (compositionManaged === true && isOwned === false && pathExists === true) {
        const verification = yield* teardownCpAMemberMount({
          request: { workspaceRoot: megarepoRoot, member: memberName, dryRun: true },
        }).pipe(Effect.result)
        if (verification._tag === 'Success') {
          symlinkExists = true
          mountKind = 'cp-a'
          mountedCommit = (yield* readOwnedCpAMountMetadata({
            workspaceRoot: megarepoRoot,
            member: memberName,
            publishedPath: symlinkPath,
          })).lockedCommit
        } else {
          mountKind = 'foreign'
        }
      } else if (compositionManaged === false && pathExists === true && isLocal === false) {
        const targetExists = yield* fs.readLink(symlinkPath).pipe(
          Effect.flatMap((target) => fs.exists(target)),
          Effect.orElseSucceed(() => false),
        )
        symlinkExists = targetExists
        memberExists = targetExists
        mountKind = 'symlink'
      }

      // Check if this member is itself a megarepo
      const isMegarepo =
        memberExists === true
          ? (yield* findConfigPath(memberPath).pipe(Effect.orElseSucceed(() => undefined))) !==
            undefined
          : false

      // Recursively scan nested members if this is a megarepo and --all is used
      let nestedMembers: readonly MemberStatus[] | undefined = undefined
      if (all === true && isMegarepo === true && memberExists === true) {
        const nestedRoot = EffectPath.unsafe.absoluteDir(
          memberPath.endsWith('/') === true ? memberPath : `${memberPath}/`,
        )
        nestedMembers = yield* scanMembersRecursive({
          megarepoRoot: nestedRoot,
          all,
          traversal,
          depth: depth + 1,
        })
      }

      // Get git status if member exists
      let gitStatus: GitStatus | undefined = undefined
      let currentBranch: string | undefined = undefined
      let fullCommit: string | undefined = undefined
      if (memberExists === true && (isOwned === true || compositionManaged === false)) {
        // Check if it's a git repo first
        const isGit = yield* Git.isGitRepo(memberPath)
        if (isGit === true) {
          // Get worktree status (dirty, unpushed)
          const worktreeStatus = yield* Git.getWorktreeStatus(memberPath).pipe(
            Effect.orElseSucceed(() => ({
              isDirty: false,
              hasUnpushed: false,
              changesCount: 0,
            })),
          )

          // Get current branch
          const branchOpt = yield* Git.getCurrentBranch(memberPath).pipe(
            Effect.orElseSucceed(() => Option.none()),
          )
          const branch = Option.getOrElse(branchOpt, () => 'HEAD')
          currentBranch = branch !== 'HEAD' ? branch : undefined

          // Get current commit (full SHA for drift detection, short for display)
          const fullCommitOpt = yield* Git.getCurrentCommit(memberPath).pipe(Effect.option)
          fullCommit = Option.getOrUndefined(fullCommitOpt)
          const shortRev = fullCommit?.slice(0, 7)

          gitStatus = {
            isDirty: worktreeStatus.isDirty,
            changesCount: worktreeStatus.changesCount,
            hasUnpushed: worktreeStatus.hasUnpushed,
            branch,
            shortRev,
          }
        }
      }

      if (mountedCommit !== undefined) fullCommit = mountedCommit

      // Read symlink target for drift detection
      const symlinkTarget =
        compositionManaged === false && memberExists === true && isLocal === false
          ? yield* fs.readLink(memberPath.replace(/\/$/, '')).pipe(Effect.orElseSucceed(() => null))
          : null

      // Get source ref (what megarepo.json intends)
      const sourceRef =
        source !== undefined && source.type !== 'path'
          ? Option.getOrElse(source.ref, () => 'main')
          : undefined

      // Detect stale lock vs symlink drift
      // These are mutually exclusive scenarios:
      //
      // Stale lock: lock.ref ≠ symlink.ref, but symlink.ref === source.ref
      //   - Current state matches intent, lock is just outdated
      //   - Fix: mr lock (updates lock)
      //
      // Symlink drift: lock.ref === symlink.ref, but lock.ref ≠ source.ref
      //   - Lock and symlink are in sync, but don't match config intent
      //   - Fix: mr fetch --apply (switch to source ref) or edit megarepo.json
      let staleLock: StaleLock | undefined = undefined
      let symlinkDrift: SymlinkDrift | undefined = undefined

      if (symlinkTarget !== null && lockedMember !== undefined && sourceRef !== undefined) {
        const extracted = extractRefFromSymlinkPath(symlinkTarget)
        const symlinkRef = extracted?.ref

        if (symlinkRef !== undefined && lockedMember.ref !== sourceRef) {
          if (symlinkRef === sourceRef && symlinkRef !== lockedMember.ref) {
            // Stale lock: symlink matches source, lock is outdated
            staleLock = {
              lockRef: lockedMember.ref,
              actualRef: symlinkRef,
            }
          } else if (symlinkRef === lockedMember.ref && symlinkRef !== sourceRef) {
            // True symlink drift: symlink follows lock, but lock doesn't match source
            symlinkDrift = {
              symlinkRef,
              sourceRef,
              actualGitBranch: currentBranch,
            }
          }
        }
      }

      // Detect commit drift: local worktree commit differs from locked commit
      let commitDrift: CommitDrift | undefined = undefined
      if (
        memberExists === true &&
        isLocal === false &&
        lockedMember !== undefined &&
        fullCommit !== undefined
      ) {
        if (fullCommit !== lockedMember.commit) {
          commitDrift = {
            localCommit: fullCommit,
            lockedCommit: lockedMember.commit,
          }
        }
      }

      // Detect ref mismatch: worktree git HEAD differs from store path ref (Issue #88)
      // This happens when user runs `git checkout <branch>` directly in the worktree
      let refMismatch: RefMismatch | undefined = undefined
      if (symlinkTarget !== null) {
        refMismatch =
          (yield* detectRefMismatch({
            worktreePath: memberPath as AbsoluteDirPath,
            symlinkTarget,
          })) ?? undefined
      }

      members.push({
        name: memberName,
        exists: memberExists,
        symlinkExists,
        source: sourceString,
        isLocal,
        mountKind,
        writable: isOwned === true,
        lockInfo:
          lockedMember !== undefined
            ? {
                ref: lockedMember.ref,
                commit: lockedMember.commit,
                pinned: lockedMember.pinned,
              }
            : undefined,
        isMegarepo,
        nestedMembers,
        gitStatus,
        staleLock,
        symlinkDrift,
        commitDrift,
        refMismatch,
      })
    }

    return members
  })

/** Show megarepo status */
export const statusCommand = Cli.Command.make(
  'status',
  {
    output: outputOption,
    all: Cli.Flag.boolean('all').pipe(
      Cli.Flag.withDescription('Recursively show status of nested megarepos'),
      Cli.Flag.withDefault(false),
    ),
  },
  ({ output, all }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const fs = yield* FileSystem.FileSystem
      const root = yield* findMegarepoRoot(cwd)

      if (Option.isNone(root) === true) {
        return yield* new NotInMegarepoError({ message: 'Not in a megarepo' })
      }

      const workspaceName = yield* Git.deriveMegarepoName(root.value)
      const store = yield* Store

      // Load config
      const { config, path: configPath } = yield* readMegarepoConfig(root.value)

      // Scan members (recursively if --all)
      const members = yield* withMegarepoTraversal({
        purpose: 'status',
        root: root.value,
        all,
        effect: (traversal) =>
          scanMembersRecursive({
            megarepoRoot: root.value,
            all,
            traversal,
          }),
      })

      // Get last sync time and lock staleness from lock file
      const physicalConfigPath = yield* fs.realPath(configPath)
      const configOwner =
        EffectPath.ops.parent(EffectPath.unsafe.absoluteFile(physicalConfigPath)) ?? root.value
      const lockPath = EffectPath.ops.join(
        configOwner,
        EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
      )
      const lockFileOpt = yield* readLockFile(lockPath)
      yield* refreshWorkspaceRegistry({
        workspaceRoot: root.value,
        store,
        now: yield* Clock.currentTimeMillis,
      })
      let lastSyncTime: Date | undefined = undefined
      let lockStaleness:
        | {
            exists: boolean
            missingFromLock: readonly string[]
            extraInLock: readonly string[]
          }
        | undefined = undefined

      // Determine which members are remote (need lock tracking)
      const remoteMemberNames = new Set<string>()
      for (const [memberName, sourceString] of Object.entries(config.members)) {
        const source = parseSourceString(sourceString)
        if (source !== undefined && isRemoteSource(source) === true) {
          remoteMemberNames.add(memberName)
        }
      }

      if (Option.isSome(lockFileOpt) === true) {
        // Find the most recent lockedAt timestamp across all members
        const timestamps = Object.values(lockFileOpt.value.members)
          .map((m) => new Date(m.lockedAt).getTime())
          .filter((t) => !Number.isNaN(t))
        if (timestamps.length > 0) {
          lastSyncTime = new Date(Math.max(...timestamps))
        }

        // Check staleness
        const staleness = checkLockStaleness({
          lockFile: lockFileOpt.value,
          configMemberNames: remoteMemberNames,
        })
        lockStaleness = {
          exists: true,
          missingFromLock: staleness.addedMembers,
          extraInLock: staleness.removedMembers,
        }
      } else if (remoteMemberNames.size > 0) {
        // Lock file doesn't exist but we have remote members
        lockStaleness = {
          exists: false,
          missingFromLock: [...remoteMemberNames],
          extraInLock: [],
        }
      }

      // Compute current member path (for scope dimming)
      let currentMemberPath = detectCurrentMemberPath({ cwd, megarepoRoot: root.value, all })

      // If path-based detection didn't work, try symlink resolution
      if (currentMemberPath === undefined) {
        const cwdRealPath = yield* fs.realPath(cwd).pipe(
          Effect.map((p) => p.replace(/\/$/, '')),
          Effect.orElseSucceed(() => cwd.replace(/\/$/, '')),
        )

        const findCurrentMemberPath = ({
          memberList,
          megarepoRoot,
          pathSoFar,
        }: {
          memberList: readonly MemberStatus[]
          megarepoRoot: string
          pathSoFar: string[]
        }): Effect.Effect<string[] | undefined, never, FileSystem.FileSystem> =>
          Effect.gen(function* () {
            for (const member of memberList) {
              const memberSymlinkPath = getMemberPath({
                megarepoRoot: EffectPath.unsafe.absoluteDir(megarepoRoot),
                name: member.name,
              })
              const memberRealPath = yield* fs
                .realPath(memberSymlinkPath.replace(/\/$/, ''))
                .pipe(Effect.catch(() => Effect.void))

              if (memberRealPath !== undefined) {
                const memberRealPathNorm = memberRealPath.replace(/\/$/, '')
                if (
                  cwdRealPath === memberRealPathNorm ||
                  cwdRealPath.startsWith(memberRealPathNorm + '/') === true
                ) {
                  const newPath = [...pathSoFar, member.name]
                  if (cwdRealPath === memberRealPathNorm) {
                    return newPath
                  }
                  if (member.nestedMembers !== undefined && member.nestedMembers.length > 0) {
                    const nestedResult = yield* findCurrentMemberPath({
                      memberList: member.nestedMembers,
                      megarepoRoot: memberRealPathNorm + '/',
                      pathSoFar: newPath,
                    })
                    if (nestedResult !== undefined) {
                      return nestedResult
                    }
                  }
                  return newPath
                }
              }
            }
            return undefined
          })

        currentMemberPath = yield* findCurrentMemberPath({
          memberList: members,
          megarepoRoot: root.value,
          pathSoFar: [],
        })
      }

      // Compute workspace vs lock reconciliation needs.
      const applyReasons: string[] = []
      const lockReasons: string[] = []

      // Helper to collect sync reasons from members recursively
      const collectMemberSyncReasons = ({
        memberList,
        prefix = '',
      }: {
        memberList: readonly MemberStatus[]
        prefix?: string
      }) => {
        for (const member of memberList) {
          const memberLabel =
            prefix !== undefined && prefix !== '' ? `${prefix}/${member.name}` : member.name
          if (member.symlinkExists === false) {
            applyReasons.push(`Member '${memberLabel}' symlink missing`)
          } else if (member.exists === false) {
            applyReasons.push(`Member '${memberLabel}' worktree missing`)
          }
          if (member.staleLock !== undefined) {
            lockReasons.push(
              `Member '${memberLabel}' stale lock: lock says '${member.staleLock.lockRef}' but actual is '${member.staleLock.actualRef}'`,
            )
          }
          if (member.symlinkDrift !== undefined) {
            applyReasons.push(
              `Member '${memberLabel}' symlink drift: tracking '${member.symlinkDrift.symlinkRef}' but source says '${member.symlinkDrift.sourceRef}'`,
            )
          }
          if (member.refMismatch !== undefined) {
            applyReasons.push(
              `Member '${memberLabel}' ref mismatch: store path expects '${member.refMismatch.expectedRef}' but git HEAD is '${member.refMismatch.actualRef}'`,
            )
          }
          if (member.commitDrift !== undefined) {
            applyReasons.push(
              `Member '${memberLabel}' commit drift: workspace is '${member.commitDrift.localCommit.slice(0, 8)}' but lock records '${member.commitDrift.lockedCommit.slice(0, 8)}'`,
            )
          }
          if (member.nestedMembers !== undefined) {
            collectMemberSyncReasons({ memberList: member.nestedMembers, prefix: memberLabel })
          }
        }
      }
      collectMemberSyncReasons({ memberList: members })

      // Check lock staleness
      if (lockStaleness !== undefined) {
        if (lockStaleness.exists === false) {
          lockReasons.push('Lock file missing')
        }
        for (const memberName of lockStaleness.missingFromLock) {
          lockReasons.push(`Member '${memberName}' not in lock file`)
        }
        for (const memberName of lockStaleness.extraInLock) {
          lockReasons.push(`Lock file has extra member '${memberName}'`)
        }
      }

      const syncReasons = [...applyReasons, ...lockReasons]
      const applyNeeded = applyReasons.length > 0
      const lockNeeded = lockReasons.length > 0
      const syncNeeded = syncReasons.length > 0

      // Use StatusApp for all output modes (TTY, CI, JSON, NDJSON)
      yield* run(
        StatusApp,
        (tui) =>
          Effect.sync(() => {
            tui.dispatch({
              _tag: 'SetState',
              state: {
                name: workspaceName,
                root: root.value,
                syncNeeded,
                applyNeeded,
                lockNeeded,
                syncReasons,
                members,
                all,
                lastSyncTime: lastSyncTime?.toISOString(),
                lockStaleness,
                currentMemberPath,
              },
            })
          }),
        { view: React.createElement(StatusView, { stateAtom: StatusApp.stateAtom }) },
      ).pipe(Effect.provide(outputModeLayer(output)))
    }).pipe(
      Effect.provide(StoreLayer),
      Observability.withCommandSpan({
        name: 'megarepo/status',
        command: 'status',
        output,
        all,
      }),
    ),
).pipe(Cli.Command.withDescription('Show workspace status and member states'))
