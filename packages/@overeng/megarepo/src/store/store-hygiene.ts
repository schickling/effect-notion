/**
 * Store Hygiene Validation
 *
 * Reusable validation functions that check store consistency.
 * Used by pre-flight checks (sync/lock/pin) and `mr store fix`.
 */

import { Effect, Option, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { type PlatformError } from 'effect/PlatformError'
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'

import { resolveStoreBranchWorktree } from '../composition/acquisition/owned-worktree-acquisition.ts'
import {
  type MegarepoConfig,
  type MemberSource,
  isRemoteSource,
  parseSourceString,
} from '../core/config.ts'
import * as Git from '../core/git.ts'
import type { LockFile } from '../core/lock.ts'
import { classifyRef } from '../core/ref.ts'
import type { MegarepoStore } from './store.ts'

// =============================================================================
// Store Issue Types
// =============================================================================

/** Severity level for store consistency issues */
export type StoreIssueSeverity = 'error' | 'warning' | 'info'

/** Classification of store consistency problems (ref mismatch, broken worktree, etc.) */
export type StoreIssueType =
  | 'ref_mismatch'
  | 'broken_worktree'
  | 'missing_bare'
  | 'dirty'
  | 'unpushed'
  | 'orphaned'
  | 'ambiguous_worktree'

/** A detected consistency problem in the megarepo store for a specific member */
export interface StoreIssue {
  readonly severity: StoreIssueSeverity
  readonly type: StoreIssueType
  readonly memberName: string
  readonly message: string
  /** Human-readable fix instructions */
  readonly fix?: string | undefined
  /** Extra data for programmatic fixes */
  readonly meta?: StoreIssueMeta | undefined
}

/** Extra metadata attached to a store issue, used for programmatic auto-fixes */
export type StoreIssueMeta =
  | {
      readonly _tag: 'ref_mismatch'
      readonly expectedRef: string
      readonly actualRef: string
      readonly worktreePath: string
    }
  | {
      readonly _tag: 'broken_worktree'
      readonly worktreePath: string
      readonly source: MemberSource
    }
  | { readonly _tag: 'missing_bare'; readonly source: MemberSource }

// =============================================================================
// Store Hygiene Error
// =============================================================================

/** Tagged error raised when store pre-flight checks detect blocking issues */
export class StoreHygieneError extends Schema.TaggedError<StoreHygieneError>()(
  'StoreHygieneError',
  {
    message: Schema.String,
    issues: Schema.Array(
      Schema.Struct({
        severity: Schema.Literals(['error', 'warning', 'info']),
        type: Schema.String,
        memberName: Schema.String,
        message: Schema.String,
        fix: Schema.optional(Schema.String),
      }),
    ),
  },
) {}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate store consistency for the given members.
 *
 * Checks:
 * - `ref_mismatch` (error): worktree HEAD branch doesn't match expected ref
 * - `broken_worktree` (error): .git file in worktree is broken or missing
 * - `missing_bare` (error): bare repo doesn't exist but is expected
 * - `dirty` (warning): worktree has uncommitted changes
 * - `unpushed` (warning): worktree has unpushed commits
 */
export const validateStoreMembers = ({
  memberNames,
  config,
  lockFile,
  store,
}: {
  memberNames: readonly string[]
  config: MegarepoConfig
  lockFile: LockFile
  store: MegarepoStore
}): Effect.Effect<StoreIssue[], PlatformError, FileSystem.FileSystem | ChildProcessSpawner> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const issues: StoreIssue[] = []

    for (const memberName of memberNames) {
      const sourceString = config.members[memberName]
      if (sourceString === undefined) continue

      const source = parseSourceString(sourceString)
      if (source === undefined || isRemoteSource(source) === false) continue

      const lockedMember = lockFile.members[memberName]
      if (lockedMember === undefined) continue

      const bareRepoPath = store.getBareRepoPath(source)
      const bareExists = yield* fs.exists(bareRepoPath)

      if (bareExists === false) {
        issues.push({
          severity: 'error',
          type: 'missing_bare',
          memberName,
          message: `bare repo not found at ${bareRepoPath}`,
          fix: `run 'mr apply' to clone the bare repo`,
          meta: { _tag: 'missing_bare', source },
        })
        continue
      }

      // Check both the branch worktree (refs/heads/<ref>/) and the commit worktree
      // (refs/commits/<sha>/). Content-aware selection in apply mode may use either.
      let branchWorktreePath = store.getWorktreePath({
        source,
        ref: lockedMember.ref,
      })
      const commitWorktreePath = store.getWorktreePath({
        source,
        ref: lockedMember.commit,
        refType: 'commit',
      })

      if (classifyRef(lockedMember.ref) === 'branch') {
        const resolution = yield* resolveStoreBranchWorktree({
          bareRepo: bareRepoPath,
          workspaceRoot: branchWorktreePath,
          branch: lockedMember.ref,
        }).pipe(Effect.result)
        if (resolution._tag === 'Failure') {
          issues.push({
            severity: 'error',
            type: 'ambiguous_worktree',
            memberName,
            message: resolution.failure.message,
          })
          continue
        }
        branchWorktreePath = resolution.success
      }
      const branchGitExists = yield* fs
        .exists(`${branchWorktreePath}.git`.replace(/\/\.git$/u, '/.git'))
        .pipe(Effect.orElseSucceed(() => false))
      const commitGitExists = yield* fs
        .exists(`${commitWorktreePath}.git`.replace(/\/\.git$/u, '/.git'))
        .pipe(Effect.orElseSucceed(() => false))
      if (branchGitExists === false && commitGitExists === false) {
        issues.push({
          severity: 'error',
          type: 'broken_worktree',
          memberName,
          message: `.git not found in worktree at ${branchWorktreePath}`,
          fix: `run 'mr apply' to recreate the worktree`,
          meta: { _tag: 'broken_worktree', worktreePath: branchWorktreePath, source },
        })
        continue
      }

      // Use whichever worktree exists for subsequent checks
      const worktreePath = branchGitExists === true ? branchWorktreePath : commitWorktreePath

      // Check ref mismatch (only for branch worktrees — tags/commits are detached by design).
      // Skip if we're using a commit worktree (content-aware selection chose it over the branch worktree).
      const expectedRef = lockedMember.ref

      if (classifyRef(expectedRef) === 'branch' && branchGitExists === true) {
        const actualBranch = yield* Git.getCurrentBranch(worktreePath).pipe(
          Effect.orElseSucceed(() => Option.none<string>()),
        )

        if (Option.isSome(actualBranch) === true && actualBranch.value !== expectedRef) {
          issues.push({
            severity: 'error',
            type: 'ref_mismatch',
            memberName,
            message: `worktree HEAD is '${actualBranch.value}' but expected '${expectedRef}'`,
            fix: `run 'git -C ${worktreePath} checkout ${expectedRef}' or 'mr store fix'`,
            meta: {
              _tag: 'ref_mismatch',
              expectedRef,
              actualRef: actualBranch.value,
              worktreePath,
            },
          })
        } else if (Option.isNone(actualBranch) === true) {
          // Detached HEAD in a branch worktree is also a mismatch
          const commitSha = yield* Git.getCurrentCommit(worktreePath).pipe(
            Effect.map((sha) => sha.slice(0, 7)),
            Effect.orElseSucceed(() => 'unknown'),
          )
          issues.push({
            severity: 'error',
            type: 'ref_mismatch',
            memberName,
            message: `worktree is detached at ${commitSha} but expected branch '${expectedRef}'`,
            fix: `run 'git -C ${worktreePath} checkout ${expectedRef}' or 'mr store fix'`,
            meta: {
              _tag: 'ref_mismatch',
              expectedRef,
              actualRef: commitSha,
              worktreePath,
            },
          })
        }
      }

      // Check dirty/unpushed (warnings)
      const worktreeStatus = yield* Git.getWorktreeStatus(worktreePath).pipe(
        Effect.orElseSucceed(() => ({ isDirty: false, hasUnpushed: false, changesCount: 0 })),
      )

      if (worktreeStatus.isDirty === true) {
        issues.push({
          severity: 'warning',
          type: 'dirty',
          memberName,
          message: `${worktreeStatus.changesCount} uncommitted change${worktreeStatus.changesCount !== 1 ? 's' : ''}`,
        })
      }

      if (worktreeStatus.hasUnpushed === true) {
        issues.push({
          severity: 'warning',
          type: 'unpushed',
          memberName,
          message: 'has unpushed commits',
        })
      }
    }

    return issues
  })

// =============================================================================
// Pre-flight Checks
// =============================================================================

/**
 * Run pre-flight hygiene checks before lock operations.
 *
 * Lock mode needs consistent store state to read worktree HEADs accurately.
 * All error-severity issues block. Warning-severity issues are logged but never block.
 *
 * Apply mode does NOT run pre-flight — syncMember self-heals all store issues
 * (clones missing bare repos, recreates broken worktrees, falls back to commit
 * worktrees on ref mismatch). Skipping also avoids races in --all mode where
 * concurrent nested syncs modify shared store state.
 */
export const runPreflightChecks = ({
  memberNames,
  config,
  lockFile,
  store,
}: {
  memberNames: readonly string[]
  config: MegarepoConfig
  lockFile: LockFile
  store: MegarepoStore
}): Effect.Effect<
  void,
  StoreHygieneError | PlatformError,
  FileSystem.FileSystem | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const issues = yield* validateStoreMembers({
      memberNames,
      config,
      lockFile,
      store,
    })

    if (issues.length === 0) return

    const warnings = issues.filter((i) => i.severity === 'warning')
    const blockingErrors = issues.filter((i) => i.severity === 'error')

    for (const warning of warnings) {
      yield* Effect.logWarning(`[${warning.memberName}] ${warning.message}`)
    }

    if (blockingErrors.length > 0) {
      const errorMessages = blockingErrors
        .map((e) => {
          const fixHint = e.fix !== undefined ? `\n  fix: ${e.fix}` : ''
          return `  ${e.memberName}: ${e.message}${fixHint}`
        })
        .join('\n')

      return yield* new StoreHygieneError({
        message: `Store hygiene check failed with ${blockingErrors.length} error${blockingErrors.length !== 1 ? 's' : ''}:\n${errorMessages}`,
        issues: issues.map((i) => ({
          severity: i.severity,
          type: i.type,
          memberName: i.memberName,
          message: i.message,
          fix: i.fix,
        })),
      })
    }
  })

// =============================================================================
// Helpers
// =============================================================================

/** Extract the ref type and value from a worktree path like `/refs/heads/branch` or `/refs/tags/v1.0` */
export const parseWorktreeRef = (
  worktreePath: string,
): { type: 'heads' | 'tags' | 'commits'; ref: string } | undefined => {
  const match = worktreePath.match(/\/refs\/(heads|tags|commits)\/(.+?)\/?\s*$/)
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  return { type: match[1] as 'heads' | 'tags' | 'commits', ref: match[2] }
}

// =============================================================================
// Fix Operations
// =============================================================================

/** Outcome of attempting to auto-fix a single store issue */
export interface FixResult {
  readonly memberName: string
  readonly issueType: StoreIssueType
  readonly status: 'fixed' | 'skipped' | 'error'
  readonly message: string
}

/**
 * Attempt to fix store issues.
 *
 * Currently supports:
 * - `ref_mismatch`: checkout the expected branch in the worktree
 * - `broken_worktree`: remove and recreate the worktree
 * - `missing_bare`: clone the bare repo
 */
export const fixStoreIssues = ({
  issues,
  store,
  dryRun = false,
}: {
  issues: readonly StoreIssue[]
  store: MegarepoStore
  dryRun?: boolean | undefined
}): Effect.Effect<FixResult[], PlatformError, FileSystem.FileSystem | ChildProcessSpawner> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const results: FixResult[] = []

    for (const issue of issues) {
      // Only attempt to fix error-severity issues
      if (issue.severity !== 'error') continue

      switch (issue.type) {
        case 'ref_mismatch': {
          if (issue.meta?._tag !== 'ref_mismatch') {
            results.push({
              memberName: issue.memberName,
              issueType: issue.type,
              status: 'skipped',
              message: 'missing metadata for fix',
            })
            break
          }

          const { expectedRef, worktreePath } = issue.meta

          if (dryRun === true) {
            results.push({
              memberName: issue.memberName,
              issueType: issue.type,
              status: 'skipped',
              message: `would checkout '${expectedRef}' in ${worktreePath}`,
            })
            break
          }

          yield* Git.checkout({ repoPath: worktreePath, ref: expectedRef }).pipe(
            Effect.match({
              onSuccess: () => {
                results.push({
                  memberName: issue.memberName,
                  issueType: issue.type,
                  status: 'fixed',
                  message: `checked out '${expectedRef}'`,
                })
              },
              onFailure: (err) => {
                results.push({
                  memberName: issue.memberName,
                  issueType: issue.type,
                  status: 'error',
                  message: `failed to checkout '${expectedRef}': ${err instanceof Error ? err.message : String(err)}`,
                })
              },
            }),
          )
          break
        }

        case 'broken_worktree': {
          if (issue.meta?._tag !== 'broken_worktree') {
            results.push({
              memberName: issue.memberName,
              issueType: issue.type,
              status: 'skipped',
              message: 'missing metadata for fix',
            })
            break
          }

          const { worktreePath, source } = issue.meta
          const bareRepoPath = store.getBareRepoPath(source)

          if (dryRun === true) {
            results.push({
              memberName: issue.memberName,
              issueType: issue.type,
              status: 'skipped',
              message: `would recreate worktree at ${worktreePath}`,
            })
            break
          }

          // Remove existing broken worktree
          yield* fs.remove(worktreePath, { recursive: true }).pipe(Effect.ignore)

          // Recreate the worktree
          yield* Effect.gen(function* () {
            yield* fs.makeDirectory(worktreePath, { recursive: true }).pipe(Effect.ignore)

            const parsed = parseWorktreeRef(worktreePath)

            if (parsed !== undefined) {
              if (parsed.type === 'heads') {
                yield* Git.createWorktree({
                  repoPath: bareRepoPath,
                  worktreePath,
                  branch: parsed.ref,
                  createBranch: false,
                })
              } else {
                yield* Git.createWorktreeDetached({
                  repoPath: bareRepoPath,
                  worktreePath,
                  commit: parsed.ref,
                })
              }
              results.push({
                memberName: issue.memberName,
                issueType: issue.type,
                status: 'fixed',
                message: `recreated worktree for '${parsed.ref}'`,
              })
            } else {
              results.push({
                memberName: issue.memberName,
                issueType: issue.type,
                status: 'error',
                message: 'could not determine ref from worktree path',
              })
            }
          }).pipe(
            Effect.catch((err) => {
              results.push({
                memberName: issue.memberName,
                issueType: issue.type,
                status: 'error',
                message: `failed to recreate worktree: ${err instanceof Error ? err.message : String(err)}`,
              })
              return Effect.void
            }),
          )
          break
        }

        case 'missing_bare': {
          if (issue.meta?._tag !== 'missing_bare') {
            results.push({
              memberName: issue.memberName,
              issueType: issue.type,
              status: 'skipped',
              message: 'missing metadata for fix',
            })
            break
          }

          const { source } = issue.meta
          const bareRepoPath = store.getBareRepoPath(source)

          if (dryRun === true) {
            results.push({
              memberName: issue.memberName,
              issueType: issue.type,
              status: 'skipped',
              message: `would clone bare repo to ${bareRepoPath}`,
            })
            break
          }

          // Determine clone URL
          let cloneUrl: string | undefined
          if (source.type === 'github') {
            cloneUrl = `git@github.com:${source.owner}/${source.repo}.git`
          } else if (source.type === 'url') {
            cloneUrl = source.url
          }

          if (cloneUrl === undefined) {
            results.push({
              memberName: issue.memberName,
              issueType: issue.type,
              status: 'error',
              message: 'cannot determine clone URL',
            })
            break
          }

          yield* Effect.gen(function* () {
            const repoBasePath = store.getRepoBasePath(source)
            yield* fs.makeDirectory(repoBasePath, { recursive: true })
            yield* Git.cloneBare({ url: cloneUrl, targetPath: bareRepoPath })
            results.push({
              memberName: issue.memberName,
              issueType: issue.type,
              status: 'fixed',
              message: `cloned bare repo from ${cloneUrl}`,
            })
          }).pipe(
            Effect.catch((err) => {
              results.push({
                memberName: issue.memberName,
                issueType: issue.type,
                status: 'error',
                message: `failed to clone: ${err instanceof Error ? err.message : String(err)}`,
              })
              return Effect.void
            }),
          )
          break
        }

        default: {
          results.push({
            memberName: issue.memberName,
            issueType: issue.type,
            status: 'skipped',
            message: `no automatic fix for '${issue.type}'`,
          })
        }
      }
    }

    return results
  })
