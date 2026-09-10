/**
 * Pin / Unpin Commands
 *
 * Commands to pin and unpin members to specific refs.
 */

import { Clock, Effect, Layer, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Cli from 'effect/unstable/cli'
import React from 'react'

import { EffectPath } from '@overeng/effect-path'
import { run } from '@overeng/tui-react'

import { resolveComposedStoreWorktree } from '../../composition/acquisition/owned-worktree-acquisition.ts'
import { teardownCpAMemberMount } from '../../composition/mounts/member-mount-cp-a.ts'
import {
  foreignMemberMountMessage,
  inspectMemberMount,
} from '../../composition/mounts/member-mount.ts'
import {
  buildSourceStringWithRef,
  MegarepoConfig,
  getMemberPath,
  getSourceUrl,
  parseSourceString,
  isRemoteSource,
  readMegarepoConfig,
  writeMegarepoConfig,
} from '../../core/config.ts'
import * as Git from '../../core/git.ts'
import {
  createEmptyLockFile,
  createLockedMember,
  getLockedMember,
  LOCK_FILE_NAME,
  pinMember,
  readLockFile,
  unpinMember,
  updateLockedMember,
  writeLockFile,
} from '../../core/lock.ts'
import { classifyRef } from '../../core/ref.ts'
import { runPreflightChecks } from '../../store/store-hygiene.ts'
import { refreshWorkspaceRegistry } from '../../store/store-liveness.ts'
import { Store, StoreLayer } from '../../store/store.ts'
import { Cwd, findMegarepoRoot, outputOption, outputModeLayer } from '../context.ts'
import {
  NotInMegarepoError,
  MemberNotFoundError,
  ForeignMemberMountError,
  InvalidSourceError,
  CannotUseLocalPathError,
  CannotGetCloneUrlError,
  MemberNotSyncedError,
  NoLockFileError,
} from '../errors.ts'
import * as Observability from '../observability.ts'
import { PinApp, PinView } from '../renderers/PinOutput/mod.ts'
import { preflightCompositionCommand, runCompositionApply } from './composition.ts'

/**
 * Pin a member to a specific ref.
 * When -c is provided, switches to a different ref (branch, tag, or commit).
 * Without -c, pins to the current commit.
 * Pinned members won't be updated by `mr fetch` unless explicitly forced.
 */
export const pinCommand = Cli.Command.make(
  'pin',
  {
    member: Cli.Argument.string('member').pipe(Cli.Argument.withDescription('Member to pin')),
    checkout: Cli.Flag.string('checkout').pipe(
      Cli.Flag.withAlias('c'),
      Cli.Flag.withDescription('Ref to switch to (branch, tag, or commit SHA)'),
      Cli.Flag.optional,
    ),
    dryRun: Cli.Flag.boolean('dry-run').pipe(
      Cli.Flag.withDescription('Show what would be changed without making changes'),
      Cli.Flag.withDefault(false),
    ),
    output: outputOption,
  },
  ({ member, checkout, dryRun, output }) =>
    run(
      PinApp,
      (tui) =>
        Effect.gen(function* () {
          const cwd = yield* Cwd
          const root = yield* findMegarepoRoot(cwd)

          if (Option.isNone(root) === true) {
            tui.dispatch({
              _tag: 'SetError',
              error: 'not_in_megarepo',
              message: 'Not in a megarepo',
            })
            return yield* new NotInMegarepoError({ message: 'Not in a megarepo' })
          }

          const fs = yield* FileSystem.FileSystem
          const store = yield* Store

          // Load config to verify member exists
          const { config: configRead, path: configPath } = yield* readMegarepoConfig(root.value)
          let config = configRead
          const compositionEnabled = config.generators?.composition?.enabled === true
          const compositionIdentity = yield* preflightCompositionCommand({
            workspaceRoot: root.value,
            compositionEnabled,
          })

          if (!(member in config.members)) {
            tui.dispatch({
              _tag: 'SetError',
              error: 'member_not_found',
              message: `Member '${member}' not found`,
            })
            return yield* new MemberNotFoundError({ message: 'Member not found', member })
          }

          const memberPath = getMemberPath({ megarepoRoot: root.value, name: member })
          const memberPathNormalized = memberPath.replace(/\/$/, '')
          const memberMount = yield* inspectMemberMount(memberPathNormalized)
          if (memberMount._tag === 'Foreign') {
            const verifiedOwnedMount =
              compositionEnabled === true
                ? yield* teardownCpAMemberMount({
                    request: { workspaceRoot: root.value, member, dryRun: true },
                  }).pipe(Effect.result)
                : undefined
            if (verifiedOwnedMount?._tag !== 'Success') {
              const message = foreignMemberMountMessage({
                name: member,
                path: memberPathNormalized,
                operation: 'pin',
              })
              tui.dispatch({ _tag: 'SetError', error: 'foreign_member_mount', message })
              return yield* new ForeignMemberMountError({
                message,
                member,
                path: memberPathNormalized,
              })
            }
          }

          // Check if it's a local path (can't pin local paths)
          let sourceString = config.members[member]
          if (sourceString === undefined) {
            return yield* new MemberNotFoundError({ message: 'Member not found', member })
          }
          let source = parseSourceString(sourceString)
          if (source === undefined) {
            tui.dispatch({
              _tag: 'SetError',
              error: 'invalid_source',
              message: 'Invalid source string',
            })
            return yield* new InvalidSourceError({
              message: 'Invalid source',
              source: sourceString,
            })
          }
          if (isRemoteSource(source) === false) {
            tui.dispatch({
              _tag: 'SetError',
              error: 'local_path',
              message: 'Cannot pin local path members',
            })
            return yield* new CannotUseLocalPathError({ message: 'Cannot pin local path' })
          }

          // Load or create lock file
          const configOwner =
            compositionIdentity?.ownedSourcePath ??
            EffectPath.ops.parent(EffectPath.unsafe.absoluteFile(yield* fs.realPath(configPath))) ??
            root.value
          const lockPath = EffectPath.ops.join(
            configOwner,
            EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
          )
          const lockFileOpt = yield* readLockFile(lockPath)
          let lockFile = Option.getOrElse(lockFileOpt, () => createEmptyLockFile())

          // Run pre-flight hygiene checks (pin operates on existing worktrees like lock)
          yield* runPreflightChecks({
            memberNames: [member],
            config,
            lockFile,
            store,
          })

          // If -c is provided, switch to the new ref
          if (Option.isSome(checkout) === true) {
            const newRef = checkout.value

            // Get current ref from source string for display (source is guaranteed to be remote at this point)
            const currentRef =
              source.type !== 'path' ? Option.getOrElse(source.ref, () => 'main') : 'main'

            // Calculate new source string
            const newSourceString = buildSourceStringWithRef({ sourceString, newRef })
            const newSource = parseSourceString(newSourceString)!

            // Get paths for display
            const bareRepoPath = store.getBareRepoPath(newSource)
            const bareExists = yield* store.hasBareRepo(newSource)
            const refType = classifyRef(newRef)

            // Resolve P/W from Git registration; composed roots never carry a second identity file.
            const worktreeRoot = store.getWorktreePath({
              source: newSource,
              ref: newRef,
              refType,
            })
            const composedWorktreePath =
              bareExists === true && refType === 'branch'
                ? yield* resolveComposedStoreWorktree({
                    bareRepo: bareRepoPath,
                    workspaceRoot: worktreeRoot,
                    branch: newRef,
                  }).pipe(
                    Effect.mapError(
                      (cause) =>
                        new InvalidSourceError({
                          source: newSourceString,
                          message: cause.message,
                        }),
                    ),
                  )
                : undefined
            const worktreePath = composedWorktreePath ?? worktreeRoot

            // Get current symlink target
            const currentLink = yield* fs
              .readLink(memberPathNormalized)
              .pipe(Effect.orElseSucceed(() => null))

            const worktreeExists =
              composedWorktreePath === undefined
                ? yield* store.hasWorktree({
                    source: newSource,
                    ref: newRef,
                    refType,
                  })
                : yield* fs.exists(
                    EffectPath.ops.join(
                      composedWorktreePath,
                      EffectPath.unsafe.relativeFile('.git'),
                    ),
                  )
            if (composedWorktreePath !== undefined && worktreeExists === false) {
              return yield* new InvalidSourceError({
                source: newSourceString,
                message: `Composed workspace is missing its owned Git checkout at ${composedWorktreePath}; recreate the workspace before pinning`,
              })
            }

            // Get current lock info
            const currentLockEntry = Option.getOrUndefined(
              getLockedMember({ lockFile, memberName: member }),
            )
            const currentLockRef = currentLockEntry?.ref ?? currentRef
            const currentLockPinned = currentLockEntry?.pinned ?? false

            // For dry-run, show what would happen
            if (dryRun === true) {
              const shortCurrentLink = currentLink !== null ? shortenPath(currentLink) : '(none)'
              const shortNewLink = shortenPath(worktreePath.replace(/\/$/, ''))
              const lockChanges: string[] = []
              if (currentLockRef !== newRef) lockChanges.push(`ref: ${currentLockRef} → ${newRef}`)
              if (currentLockPinned === false) lockChanges.push('pinned: true')

              tui.dispatch({
                _tag: 'SetDryRun',
                member,
                action: 'pin',
                ref: newRef,
                currentSource: sourceString,
                newSource: newSourceString,
                currentSymlink: shortCurrentLink,
                newSymlink: shortNewLink,
                lockChanges: lockChanges.length > 0 ? lockChanges : undefined,
                wouldClone: !bareExists,
                wouldCreateWorktree: !worktreeExists,
              })
              return
            }

            // Actually perform the changes
            config = new MegarepoConfig({
              ...config,
              members: {
                ...config.members,
                [member]: newSourceString,
              },
            })

            // Write updated config (preserves format)
            yield* writeMegarepoConfig({ configPath: configPath, config: config })

            // Re-parse the source with the new ref
            sourceString = newSourceString
            source = parseSourceString(newSourceString)!

            if (bareExists === false) {
              // Clone the bare repo
              const cloneUrl = getCloneUrl(source)
              if (cloneUrl === undefined) {
                return yield* new CannotGetCloneUrlError({ message: 'Cannot get clone URL' })
              }

              const repoBasePath = store.getRepoBasePath(source)
              yield* fs.makeDirectory(repoBasePath, { recursive: true })
              yield* Git.cloneBare({ url: cloneUrl, targetPath: bareRepoPath })
            } else {
              // Fetch to ensure we have the latest refs
              yield* Git.fetchBare({ repoPath: bareRepoPath }).pipe(Effect.ignore)
            }

            // Resolve commit
            let targetCommit: string

            if (refType === 'commit') {
              // It's already a commit SHA
              targetCommit = newRef
            } else {
              // Resolve the ref to a commit
              targetCommit = yield* Git.resolveRef({
                repoPath: bareRepoPath,
                ref: refType === 'tag' ? `refs/tags/${newRef}` : `refs/remotes/origin/${newRef}`,
              }).pipe(
                Effect.catch(() =>
                  // Fallback: try resolving directly
                  Git.resolveRef({ repoPath: bareRepoPath, ref: newRef }),
                ),
              )
            }

            if (worktreeExists === false) {
              // Ensure parent directory exists
              const worktreeParent = EffectPath.ops.parent(worktreePath)
              if (worktreeParent !== undefined) {
                yield* fs.makeDirectory(worktreeParent, { recursive: true })
              }

              // Create the worktree
              if (refType === 'commit' || refType === 'tag') {
                yield* Git.createWorktreeDetached({
                  repoPath: bareRepoPath,
                  worktreePath,
                  commit: targetCommit,
                })
              } else {
                // Branch: create worktree tracking the branch
                yield* Git.createWorktree({
                  repoPath: bareRepoPath,
                  worktreePath,
                  branch: `origin/${newRef}`,
                  createBranch: false,
                }).pipe(
                  Effect.catch(() =>
                    // Fallback: create detached at the resolved commit
                    Git.createWorktreeDetached({
                      repoPath: bareRepoPath,
                      worktreePath,
                      commit: targetCommit,
                    }),
                  ),
                )
              }
            }
            if (compositionEnabled === false) {
              const reposDir = EffectPath.ops.parent(memberPath)
              if (reposDir !== undefined) {
                yield* fs.makeDirectory(reposDir, { recursive: true })
              }
              if (currentLink !== null) yield* fs.remove(memberPathNormalized)
              yield* fs.symlink(worktreePath.replace(/\/$/, ''), memberPathNormalized)
            }

            // Update lock file with new ref
            const url = getSourceUrl(source)
            if (url !== undefined) {
              lockFile = updateLockedMember({
                lockFile,
                memberName: member,
                member: createLockedMember({
                  url,
                  ref: newRef,
                  commit: targetCommit,
                  pinned: true,
                }),
              })
              yield* writeLockFile({ lockPath, lockFile })
            }

            if (compositionEnabled === true) {
              yield* runCompositionApply({ workspaceRoot: root.value, dryRun: false })
            }

            // Keep the store liveness record fresh after repinning so a
            // concurrent gc sees the new target as live (decision 0010).
            yield* refreshWorkspaceRegistry({
              workspaceRoot: root.value,
              store,
              now: yield* Clock.currentTimeMillis,
            })

            tui.dispatch({
              _tag: 'SetSuccess',
              member,
              action: 'pin',
              ref: newRef,
              commit: targetCommit,
            })

            return
          }

          // No -c provided: pin to current commit (existing behavior)
          const lockedMember = Option.getOrUndefined(
            getLockedMember({ lockFile, memberName: member }),
          )
          if (lockedMember === undefined) {
            tui.dispatch({
              _tag: 'SetError',
              error: 'not_synced',
              message: `Member '${member}' not synced yet`,
            })
            return yield* new MemberNotSyncedError({ message: 'Member not synced', member })
          }

          // Check if already pinned (only when not switching refs)
          if (lockedMember.pinned === true) {
            tui.dispatch({
              _tag: 'SetAlready',
              member,
              action: 'pin',
              commit: lockedMember.commit,
            })
            return
          }

          // Get paths for display and dry-run
          const commitWorktreePath = store.getWorktreePath({
            source,
            ref: lockedMember.commit,
            refType: 'commit',
          })

          const commitWorktreeExists = yield* store.hasWorktree({
            source,
            ref: lockedMember.commit,
            refType: 'commit',
          })

          const currentLink = yield* fs
            .readLink(memberPathNormalized)
            .pipe(Effect.orElseSucceed(() => null))

          const bareRepoPath = store.getBareRepoPath(source)
          const bareExists = yield* store.hasBareRepo(source)

          // For dry-run, show what would happen
          if (dryRun === true) {
            const wouldChangeSymlink =
              currentLink !== null &&
              currentLink.replace(/\/$/, '') !== commitWorktreePath.replace(/\/$/, '')

            tui.dispatch({
              _tag: 'SetDryRun',
              member,
              action: 'pin',
              commit: lockedMember.commit,
              currentSymlink: wouldChangeSymlink === true ? shortenPath(currentLink) : undefined,
              newSymlink:
                wouldChangeSymlink === true
                  ? shortenPath(commitWorktreePath.replace(/\/$/, ''))
                  : undefined,
              lockChanges: ['pinned: false → true'],
              wouldCreateWorktree: commitWorktreeExists === false && bareExists === true,
              worktreeNotAvailable: commitWorktreeExists === false && bareExists === false,
            })
            return
          }

          // Actually perform the changes
          lockFile = pinMember({ lockFile, memberName: member })
          yield* writeLockFile({ lockPath, lockFile })

          // If the commit worktree doesn't exist, create it
          if (commitWorktreeExists === false) {
            if (bareExists === false) {
              // Bare repo doesn't exist, can't create worktree - warn user
              tui.dispatch({
                _tag: 'SetWarning',
                warning: 'worktree_not_available',
              })
            } else {
              // Create the worktree parent directory
              const worktreeParent = EffectPath.ops.parent(commitWorktreePath)
              if (worktreeParent !== undefined) {
                yield* fs.makeDirectory(worktreeParent, { recursive: true })
              }

              // Create detached worktree at the pinned commit
              yield* Git.createWorktreeDetached({
                repoPath: bareRepoPath,
                worktreePath: commitWorktreePath,
                commit: lockedMember.commit,
              })
            }
          }

          // Check again if worktree exists (it may have been created above)
          const worktreeReady = yield* store.hasWorktree({
            source,
            ref: lockedMember.commit,
            refType: 'commit',
          })

          if (worktreeReady === true && compositionEnabled === false) {
            // Update the symlink
            if (
              currentLink !== null &&
              currentLink.replace(/\/$/, '') !== commitWorktreePath.replace(/\/$/, '')
            ) {
              yield* fs.remove(memberPathNormalized)
              yield* fs.symlink(commitWorktreePath.replace(/\/$/, ''), memberPathNormalized)
            }
          }

          if (compositionEnabled === true) {
            yield* runCompositionApply({ workspaceRoot: root.value, dryRun: false })
          }

          // Keep the store liveness record fresh after pinning (the symlink may
          // have been repointed to the commit worktree) so a concurrent gc sees
          // the new target as live (decision 0010).
          yield* refreshWorkspaceRegistry({
            workspaceRoot: root.value,
            store,
            now: yield* Clock.currentTimeMillis,
          })

          tui.dispatch({
            _tag: 'SetSuccess',
            member,
            action: 'pin',
            commit: lockedMember.commit,
          })
        }),
      { view: React.createElement(PinView, { stateAtom: PinApp.stateAtom }) },
    ).pipe(
      Effect.provide(Layer.merge(outputModeLayer(output), StoreLayer)),
      Observability.withCommandSpan({
        name: 'megarepo/pin',
        command: 'pin',
        label: member,
        output,
        dryRun,
        member,
      }),
    ),
).pipe(Cli.Command.withDescription('Pin a member to a specific ref'))

/**
 * Get the git clone URL for a member source
 */
const getCloneUrl = (source: ReturnType<typeof parseSourceString>): string | undefined => {
  if (source === undefined) return undefined
  switch (source.type) {
    case 'github':
      return `git@github.com:${source.owner}/${source.repo}.git`
    case 'url':
      return source.url
    case 'path':
      return undefined
  }
}

/**
 * Shorten a path for display by replacing home directory with ~
 * and keeping only the last few path components if too long
 */
const shortenPath = (path: string): string => {
  const home = process.env['HOME'] ?? ''
  let shortened = path
  if (home !== '' && shortened.startsWith(home) === true) {
    shortened = '~' + shortened.slice(home.length)
  }
  // If still too long, show .../<last-3-components>
  const parts = shortened.split('/')
  if (parts.length > 5) {
    shortened = '.../' + parts.slice(-3).join('/')
  }
  return shortened
}

/**
 * Unpin a member, allowing it to be updated by `mr update`.
 */
export const unpinCommand = Cli.Command.make(
  'unpin',
  {
    member: Cli.Argument.string('member').pipe(Cli.Argument.withDescription('Member to unpin')),
    output: outputOption,
  },
  ({ member, output }) =>
    run(
      PinApp,
      (tui) =>
        Effect.gen(function* () {
          const cwd = yield* Cwd
          const root = yield* findMegarepoRoot(cwd)

          if (Option.isNone(root) === true) {
            tui.dispatch({
              _tag: 'SetError',
              error: 'not_in_megarepo',
              message: 'Not in a megarepo',
            })
            return yield* new NotInMegarepoError({ message: 'Not in a megarepo' })
          }

          const fs = yield* FileSystem.FileSystem

          // Load config to verify member exists
          const { config, path: configPath } = yield* readMegarepoConfig(root.value)
          const compositionEnabled = config.generators?.composition?.enabled === true
          const compositionIdentity = yield* preflightCompositionCommand({
            workspaceRoot: root.value,
            compositionEnabled,
          })

          if (!(member in config.members)) {
            tui.dispatch({
              _tag: 'SetError',
              error: 'member_not_found',
              message: `Member '${member}' not found`,
            })
            return yield* new MemberNotFoundError({ message: 'Member not found', member })
          }

          const memberPath = getMemberPath({ megarepoRoot: root.value, name: member })
          const memberPathNormalized = memberPath.replace(/\/$/, '')
          const memberMount = yield* inspectMemberMount(memberPathNormalized)
          if (memberMount._tag === 'Foreign') {
            const verifiedOwnedMount =
              compositionEnabled === true
                ? yield* teardownCpAMemberMount({
                    request: { workspaceRoot: root.value, member, dryRun: true },
                  }).pipe(Effect.result)
                : undefined
            if (verifiedOwnedMount?._tag !== 'Success') {
              const message = foreignMemberMountMessage({
                name: member,
                path: memberPathNormalized,
                operation: 'unpin',
              })
              tui.dispatch({ _tag: 'SetError', error: 'foreign_member_mount', message })
              return yield* new ForeignMemberMountError({
                message,
                member,
                path: memberPathNormalized,
              })
            }
          }

          // Load lock file
          const configOwner =
            compositionIdentity?.ownedSourcePath ??
            EffectPath.ops.parent(EffectPath.unsafe.absoluteFile(yield* fs.realPath(configPath))) ??
            root.value
          const lockPath = EffectPath.ops.join(
            configOwner,
            EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
          )
          const lockFileOpt = yield* readLockFile(lockPath)
          if (Option.isNone(lockFileOpt) === true) {
            tui.dispatch({
              _tag: 'SetError',
              error: 'no_lock',
              message: 'No lock file found',
            })
            return yield* new NoLockFileError({ message: 'No lock file' })
          }
          let lockFile = lockFileOpt.value

          // Check if member is in lock file
          const lockedMember = Option.getOrUndefined(
            getLockedMember({ lockFile, memberName: member }),
          )
          if (lockedMember === undefined) {
            tui.dispatch({
              _tag: 'SetError',
              error: 'not_in_lock',
              message: `Member '${member}' not in lock file`,
            })
            return
          }

          // Check if already unpinned
          if (lockedMember.pinned === false) {
            tui.dispatch({
              _tag: 'SetAlready',
              member,
              action: 'unpin',
            })
            return
          }

          // Unpin the member
          lockFile = unpinMember({ lockFile, memberName: member })
          yield* writeLockFile({ lockPath, lockFile })

          // cp-a mounts advance only through the typed composition apply service.
          const sourceString = config.members[member]
          if (sourceString === undefined) {
            // Member was removed from config but still in lock file - warn user
            tui.dispatch({
              _tag: 'SetWarning',
              warning: 'member_removed_from_config',
              member,
            })
          } else {
            const source = parseSourceString(sourceString)
            if (
              compositionEnabled === false &&
              source !== undefined &&
              isRemoteSource(source) === true
            ) {
              const store = yield* Store
              // Get the ref-based worktree path (use the locked ref)
              const refWorktreePath = store.getWorktreePath({
                source,
                ref: lockedMember.ref,
                // Use undefined to let heuristics determine the type
              })

              // Check if worktree exists at ref path
              const refWorktreeExists = yield* store.hasWorktree({
                source,
                ref: lockedMember.ref,
              })

              // Update symlink if ref worktree exists and current link is different
              if (refWorktreeExists === true) {
                const currentLink = yield* fs
                  .readLink(memberPathNormalized)
                  .pipe(Effect.orElseSucceed(() => null))
                if (
                  currentLink !== null &&
                  currentLink.replace(/\/$/, '') !== refWorktreePath.replace(/\/$/, '')
                ) {
                  yield* fs.remove(memberPathNormalized)
                  yield* fs.symlink(refWorktreePath.replace(/\/$/, ''), memberPathNormalized)
                }
              }
            }
          }

          if (compositionEnabled === true) {
            yield* runCompositionApply({ workspaceRoot: root.value, dryRun: false })
          }

          tui.dispatch({
            _tag: 'SetSuccess',
            member,
            action: 'unpin',
          })
        }),
      { view: React.createElement(PinView, { stateAtom: PinApp.stateAtom }) },
    ).pipe(
      Effect.provide(Layer.merge(outputModeLayer(output), StoreLayer)),
      Observability.withCommandSpan({
        name: 'megarepo/unpin',
        command: 'unpin',
        label: member,
        output,
        member,
      }),
    ),
).pipe(Cli.Command.withDescription('Unpin a member to allow updates'))
