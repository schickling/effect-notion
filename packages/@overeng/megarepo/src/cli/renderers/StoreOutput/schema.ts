/**
 * StoreOutput Schema
 *
 * Effect Schema definitions for all store command outputs.
 * Uses tagged union for different subcommand states.
 */

import { Schema } from 'effect'

// =============================================================================
// Common Types
// =============================================================================

/** Schema for a repository entry in the store with its relative path. */
export const StoreRepo = Schema.Struct({
  relativePath: Schema.String,
})

/** Inferred type for a store repository entry. */
export type StoreRepo = Schema.Schema.Type<typeof StoreRepo>

/** Schema for the result of fetching a single repository in the store. */
export const StoreFetchResult = Schema.Struct({
  path: Schema.String,
  status: Schema.Literals(['fetched', 'error']),
  message: Schema.optional(Schema.String),
})

/** Inferred type for a store fetch result. */
export type StoreFetchResult = Schema.Schema.Type<typeof StoreFetchResult>

/**
 * Status of a single GC result.
 *
 * `removed`/`skipped_dirty`/`skipped_in_use`/`error` are the legacy
 * commit-worktree + `--all` outcomes. The cold named-branch path (decisions
 * 0001–0010) adds three more: `archived` (moved to `.archive/`, recoverable),
 * `reaped` (an archive past retention hard-deleted), and `kept` (a cold named
 * worktree deliberately left in place, e.g. live/not-stale/lossless/grace).
 */
export const StoreGcResultStatus = Schema.Literals([
  'removed',
  'skipped_dirty',
  'skipped_in_use',
  'error',
  'archived',
  'reaped',
  'kept',
])

/** Inferred type for a GC result status. */
export type StoreGcResultStatus = Schema.Schema.Type<typeof StoreGcResultStatus>

/** Schema for the result of garbage-collecting a single worktree. */
export const StoreGcResult = Schema.Struct({
  repo: Schema.String,
  ref: Schema.String,
  refType: Schema.Literals(['heads', 'tags', 'commits']),
  path: Schema.String,
  status: StoreGcResultStatus,
  message: Schema.optional(Schema.String),
  /**
   * Why a cold named worktree was kept/archived/reaped (e.g. `live`,
   * `not-stale`, `unrecoverable-local-work`, `merged`, `closed`, `ref_mismatch`).
   * Distinct from `message` (free-form detail); `reason` is the stable tag.
   */
  reason: Schema.optional(Schema.String),
  /** For `archived`: the `.archive/` location the worktree was moved to (recovery hint). */
  recoverPath: Schema.optional(Schema.String),
  /** For ref-mismatch archives: the branch implied by the store path. */
  pathRef: Schema.optional(Schema.String),
  /** For ref-mismatch archives: the branch actually checked out in the worktree. */
  actualHeadBranch: Schema.optional(Schema.String),
  /** Additive generated-artifact result fields; absent on legacy worktree rows. */
  kind: Schema.optional(Schema.Literals(['worktree', 'generated-artifact'])),
  artifactClass: Schema.optional(Schema.String),
  workspacePath: Schema.optional(Schema.String),
  allocatedBytes: Schema.optional(Schema.Finite),
  exclusiveClosureBytes: Schema.optional(Schema.NullOr(Schema.Finite)),
  outcome: Schema.optional(Schema.Literals(['would-delete', 'deleted', 'keep', 'unknown'])),
  mtimeMs: Schema.optional(Schema.Finite),
})

/** Inferred type for a store GC result. */
export type StoreGcResult = Schema.Schema.Type<typeof StoreGcResult>

/** Schema for a health issue detected on a worktree (dirty, unpushed, orphaned, etc.). */
export const StoreWorktreeIssue = Schema.Struct({
  type: Schema.Literals([
    'dirty',
    'unpushed',
    'ref_mismatch',
    'missing_bare',
    'broken_worktree',
    'orphaned',
  ]),
  severity: Schema.Literals(['error', 'warning', 'info']),
  message: Schema.String,
})

/** Inferred type for a worktree issue. */
export type StoreWorktreeIssue = Schema.Schema.Type<typeof StoreWorktreeIssue>

/** Schema for a worktree's status including its repo, ref, path, and any detected issues. */
export const StoreWorktreeStatus = Schema.Struct({
  repo: Schema.String,
  ref: Schema.String,
  refType: Schema.Literals(['heads', 'tags', 'commits']),
  path: Schema.String,
  issues: Schema.Array(StoreWorktreeIssue),
})

/** Inferred type for a worktree's status. */
export type StoreWorktreeStatus = Schema.Schema.Type<typeof StoreWorktreeStatus>

/** Schema for warnings shown before garbage collection (e.g., not in megarepo). */
export const StoreGcWarning = Schema.Struct({
  type: Schema.Literals(['not_in_megarepo', 'only_current_megarepo', 'custom']),
  message: Schema.optional(Schema.String),
})

/** Inferred type for a store GC warning. */
export type StoreGcWarning = Schema.Schema.Type<typeof StoreGcWarning>

// =============================================================================
// Store State (Union of all subcommand states)
// =============================================================================

/**
 * Ls state - list repos in store
 */
export const StoreLsState = Schema.TaggedStruct('Ls', {
  basePath: Schema.String,
  repos: Schema.Array(StoreRepo),
})

/**
 * Status state - show worktree status
 */
export const StoreStatusState = Schema.TaggedStruct('Status', {
  basePath: Schema.String,
  repoCount: Schema.Finite,
  worktreeCount: Schema.Finite,
  diskUsage: Schema.optional(Schema.String),
  worktrees: Schema.Array(StoreWorktreeStatus),
})

/**
 * Fetch state - fetch updates
 */
export const StoreFetchState = Schema.TaggedStruct('Fetch', {
  basePath: Schema.String,
  results: Schema.Array(StoreFetchResult),
  elapsedMs: Schema.Finite,
})

/**
 * GC state - garbage collection
 */
export const StoreGcState = Schema.TaggedStruct('Gc', {
  basePath: Schema.String,
  results: Schema.Array(StoreGcResult),
  dryRun: Schema.Boolean,
  warning: Schema.optional(StoreGcWarning),
  showForceHint: Schema.Boolean,
  processedCount: Schema.optional(Schema.Finite),
  repoCount: Schema.optional(Schema.Finite),
  completedRepoCount: Schema.optional(Schema.Finite),
  discoveredWorktreeCount: Schema.optional(Schema.Finite),
  activeWorktreeCount: Schema.optional(Schema.Finite),
  statusMessage: Schema.optional(Schema.String),
  done: Schema.optional(Schema.Boolean),
  interrupted: Schema.optional(Schema.Boolean),
  planSha256: Schema.optional(Schema.String),
  censusStatus: Schema.optional(Schema.Literals(['complete', 'unknown'])),
})

/**
 * Add state - add to store
 */
export const StoreAddState = Schema.TaggedStruct('Add', {
  status: Schema.Literals(['added', 'already_exists', 'created']),
  source: Schema.String,
  ref: Schema.String,
  commit: Schema.optional(Schema.String),
  path: Schema.String,
})

/** Schema for a store fix result entry. */
export const StoreFixResult = Schema.Struct({
  memberName: Schema.String,
  issueType: Schema.String,
  status: Schema.Literals(['fixed', 'skipped', 'error']),
  message: Schema.String,
})

/** Inferred type for a store fix result. */
export type StoreFixResult = Schema.Schema.Type<typeof StoreFixResult>

/**
 * Fix state - fix store issues
 */
export const StoreFixState = Schema.TaggedStruct('Fix', {
  basePath: Schema.String,
  results: Schema.Array(StoreFixResult),
  dryRun: Schema.Boolean,
  noIssues: Schema.Boolean,
})

/**
 * WorktreeNew state - create a new worktree in the store
 */
export const StoreWorktreeNewState = Schema.TaggedStruct('WorktreeNew', {
  source: Schema.String,
  ref: Schema.String,
  path: Schema.String,
  commit: Schema.optional(Schema.String),
  autoBootstrap: Schema.Boolean,
  branchCreated: Schema.Boolean,
})

/**
 * Error state - any store command error
 */
export const StoreErrorState = Schema.TaggedStruct('Error', {
  error: Schema.String,
  message: Schema.String,
  source: Schema.optional(Schema.String),
})

/**
 * Interrupted state - command was cancelled by the user.
 */
export const StoreInterruptedState = Schema.TaggedStruct('Interrupted', {})

/**
 * State for all store commands - discriminated by _tag property.
 */
export const StoreState = Schema.Union([
  StoreLsState,
  StoreStatusState,
  StoreFetchState,
  StoreGcState,
  StoreAddState,
  StoreWorktreeNewState,
  StoreFixState,
  StoreErrorState,
  StoreInterruptedState,
])

export type StoreState = typeof StoreState.Type

// =============================================================================
// Type Guards
// =============================================================================

/** Type guard that checks if the store state is an error. */
export const isStoreError = (state: StoreState): state is typeof StoreErrorState.Type =>
  state._tag === 'Error'

/** Type guard that checks if the store state is a repository listing. */
export const isStoreLs = (state: StoreState): state is typeof StoreLsState.Type =>
  state._tag === 'Ls'

/** Type guard that checks if the store state is a worktree status report. */
export const isStoreStatus = (state: StoreState): state is typeof StoreStatusState.Type =>
  state._tag === 'Status'

/** Type guard that checks if the store state is a fetch result. */
export const isStoreFetch = (state: StoreState): state is typeof StoreFetchState.Type =>
  state._tag === 'Fetch'

/** Type guard that checks if the store state is a garbage collection result. */
export const isStoreGc = (state: StoreState): state is typeof StoreGcState.Type =>
  state._tag === 'Gc'

/** Type guard that checks if the store state is an add-to-store result. */
export const isStoreAdd = (state: StoreState): state is typeof StoreAddState.Type =>
  state._tag === 'Add'

/** Type guard that checks if the store state is a worktree-new result. */
export const isStoreWorktreeNew = (state: StoreState): state is typeof StoreWorktreeNewState.Type =>
  state._tag === 'WorktreeNew'

/** Type guard that checks if the store state is a fix result. */
export const isStoreFix = (state: StoreState): state is typeof StoreFixState.Type =>
  state._tag === 'Fix'

// =============================================================================
// Store Actions
// =============================================================================

/**
 * Actions for store output.
 */
export const StoreAction = Schema.Union([
  Schema.TaggedStruct('SetLs', {
    basePath: Schema.String,
    repos: Schema.Array(StoreRepo),
  }),
  Schema.TaggedStruct('SetStatus', {
    basePath: Schema.String,
    repoCount: Schema.Finite,
    worktreeCount: Schema.Finite,
    diskUsage: Schema.optional(Schema.String),
    worktrees: Schema.Array(StoreWorktreeStatus),
  }),
  Schema.TaggedStruct('SetFetch', {
    basePath: Schema.String,
    results: Schema.Array(StoreFetchResult),
    elapsedMs: Schema.Finite,
  }),
  Schema.TaggedStruct('SetGc', {
    basePath: Schema.String,
    results: Schema.Array(StoreGcResult),
    dryRun: Schema.Boolean,
    warning: Schema.optional(StoreGcWarning),
    showForceHint: Schema.Boolean,
    processedCount: Schema.optional(Schema.Finite),
    repoCount: Schema.optional(Schema.Finite),
    completedRepoCount: Schema.optional(Schema.Finite),
    discoveredWorktreeCount: Schema.optional(Schema.Finite),
    activeWorktreeCount: Schema.optional(Schema.Finite),
    statusMessage: Schema.optional(Schema.String),
    done: Schema.optional(Schema.Boolean),
    interrupted: Schema.optional(Schema.Boolean),
    planSha256: Schema.optional(Schema.String),
    censusStatus: Schema.optional(Schema.Literals(['complete', 'unknown'])),
  }),
  Schema.TaggedStruct('SetAdd', {
    status: Schema.Literals(['added', 'already_exists', 'created']),
    source: Schema.String,
    ref: Schema.String,
    commit: Schema.optional(Schema.String),
    path: Schema.String,
  }),
  Schema.TaggedStruct('SetWorktreeNew', {
    source: Schema.String,
    ref: Schema.String,
    path: Schema.String,
    commit: Schema.optional(Schema.String),
    autoBootstrap: Schema.Boolean,
    branchCreated: Schema.Boolean,
  }),
  Schema.TaggedStruct('SetFix', {
    basePath: Schema.String,
    results: Schema.Array(StoreFixResult),
    dryRun: Schema.Boolean,
    noIssues: Schema.Boolean,
  }),
  Schema.TaggedStruct('SetError', {
    error: Schema.String,
    message: Schema.String,
    source: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct('Interrupted', {}),
])

/** Inferred type for store actions. */
export type StoreAction = Schema.Schema.Type<typeof StoreAction>

// =============================================================================
// Reducer
// =============================================================================

/** Reduces store actions into state, replacing the state with the appropriate subcommand result. */
export const storeReducer = ({
  state: _state,
  action,
}: {
  state: StoreState
  action: StoreAction
}): StoreState => {
  switch (action._tag) {
    case 'SetLs':
      return { _tag: 'Ls', basePath: action.basePath, repos: action.repos }
    case 'SetStatus':
      return {
        _tag: 'Status',
        basePath: action.basePath,
        repoCount: action.repoCount,
        worktreeCount: action.worktreeCount,
        diskUsage: action.diskUsage,
        worktrees: action.worktrees,
      }
    case 'SetFetch':
      return {
        _tag: 'Fetch',
        basePath: action.basePath,
        results: action.results,
        elapsedMs: action.elapsedMs,
      }
    case 'SetGc':
      return {
        _tag: 'Gc',
        basePath: action.basePath,
        results: action.results,
        dryRun: action.dryRun,
        warning: action.warning,
        showForceHint: action.showForceHint,
        processedCount: action.processedCount,
        repoCount: action.repoCount,
        completedRepoCount: action.completedRepoCount,
        discoveredWorktreeCount: action.discoveredWorktreeCount,
        activeWorktreeCount: action.activeWorktreeCount,
        statusMessage: action.statusMessage,
        done: action.done,
        interrupted: action.interrupted,
        planSha256: action.planSha256,
        censusStatus: action.censusStatus,
      }
    case 'SetAdd':
      return {
        _tag: 'Add',
        status: action.status,
        source: action.source,
        ref: action.ref,
        commit: action.commit,
        path: action.path,
      }
    case 'SetWorktreeNew':
      return {
        _tag: 'WorktreeNew',
        source: action.source,
        ref: action.ref,
        path: action.path,
        commit: action.commit,
        autoBootstrap: action.autoBootstrap,
        branchCreated: action.branchCreated,
      }
    case 'SetFix':
      return {
        _tag: 'Fix',
        basePath: action.basePath,
        results: action.results,
        dryRun: action.dryRun,
        noIssues: action.noIssues,
      }
    case 'SetError':
      return {
        _tag: 'Error',
        error: action.error,
        message: action.message,
        source: action.source,
      }
    case 'Interrupted':
      if (_state._tag === 'Gc') {
        return {
          ..._state,
          activeWorktreeCount: 0,
          statusMessage: 'interrupted',
          done: true,
          interrupted: true,
        }
      }
      return { _tag: 'Interrupted' }
  }
}
