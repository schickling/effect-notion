/**
 * Live-process in-use probe
 *
 * The deletion lease only excludes an activation that takes it. A shell or agent
 * session that was already sitting inside a worktree holds no lease, and on
 * Linux a directory rename is invisible to a process already in that directory:
 * its cwd silently follows the inode into `.archive/`, and the following git
 * bookkeeping strips the worktree out from under the live session. That is a
 * real incident class, not a hypothetical.
 *
 * So destructive reclamation additionally asks the strictly stronger question
 * the liveness manifest cannot answer: is a live OS process working inside this
 * directory right now? Evidence is `/proc/<pid>/cwd`. Conservative in both
 * directions that matter: no `/proc`, or an unreadable scan, is `unknown`, and
 * the caller treats `unknown` as in-use and keeps.
 */

import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { type AbsoluteDirPath } from '@overeng/effect-path'

/** The process that holds a worktree, and the in-worktree path proving it. */
export interface InUseHolder {
  readonly pid: number
  readonly path: string
}

/** Probe outcome. `unknown` MUST be treated as in-use by callers. */
export type InUseResult =
  | { readonly _tag: 'free' }
  | { readonly _tag: 'in-use'; readonly holder: InUseHolder }
  | { readonly _tag: 'unknown'; readonly reason: 'no-proc' | 'scan-failed' }

/** One observed process cwd, as read from `/proc/<pid>/cwd`. */
export interface ProcessCwd {
  readonly pid: number
  readonly path: string
}

const normalizePath = (path: string): string => path.replace(/\/+$/, '')

/**
 * True when `candidate` is the worktree itself or a path inside it.
 *
 * Compared on normalized boundaries so a sibling like `<worktree>.archive-old`
 * never matches by raw string prefix.
 */
export const isInsideWorktree = ({
  candidate,
  worktreePath,
}: {
  candidate: string
  worktreePath: string
}): boolean => {
  const worktree = normalizePath(worktreePath)
  const path = normalizePath(candidate)
  return path === worktree || path.startsWith(`${worktree}/`) === true
}

/**
 * Pure classifier: the first process whose cwd is inside the worktree and which
 * is not excluded.
 *
 * `excludePids` carries this gc process and its descendants — a `git` child
 * megarepo itself spawned with a cwd inside the worktree must never self-veto.
 * Keeping it a parameter is what makes this seam unit-testable and lets the
 * integration test observe a real spawned holder.
 */
export const classifyInUse = ({
  processes,
  worktreePath,
  excludePids,
}: {
  processes: ReadonlyArray<ProcessCwd>
  worktreePath: string
  excludePids: ReadonlySet<number>
}): InUseResult => {
  for (const entry of processes) {
    if (excludePids.has(entry.pid) === true) continue
    if (isInsideWorktree({ candidate: entry.path, worktreePath }) === false) continue
    return { _tag: 'in-use', holder: { pid: entry.pid, path: entry.path } }
  }
  return { _tag: 'free' }
}

const parsePpid = (statusContent: string): number | undefined => {
  const line = statusContent.split('\n').find((entry) => entry.startsWith('PPid:') === true)
  if (line === undefined) return undefined
  const parsed = Number.parseInt(line.slice('PPid:'.length).trim(), 10)
  return Number.isSafeInteger(parsed) === true && parsed >= 0 ? parsed : undefined
}

/**
 * Walk a pid's parent chain; `true` when `ancestorPid` is reached.
 *
 * Climbing from the rare in-worktree match is far cheaper than materializing
 * the whole process tree, and the depth bound keeps a corrupted or recycled
 * chain from looping.
 */
const hasAncestor = ({
  fs,
  pid,
  ancestorPid,
}: {
  fs: FileSystem.FileSystem
  pid: number
  ancestorPid: number
}): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    let current = pid
    for (let depth = 0; depth < 64; depth += 1) {
      if (current === ancestorPid) return true
      if (current <= 1) return false
      const status = yield* fs
        .readFileString(`/proc/${current}/status`)
        .pipe(Effect.orElseSucceed(() => undefined))
      const parent = status === undefined ? undefined : parsePpid(status)
      if (parent === undefined) return false
      current = parent
    }
    return false
  })

/**
 * Read every readable process cwd from `/proc`.
 *
 * A pid that vanishes mid-scan, or whose cwd belongs to another user, is simply
 * not evidence — those are skipped rather than failing the whole probe, because
 * refusing on any unreadable pid would make the probe permanently `unknown` on
 * a shared host and thereby disable reclamation entirely.
 */
const readProcessCwds = (
  fs: FileSystem.FileSystem,
): Effect.Effect<ReadonlyArray<ProcessCwd> | undefined> =>
  Effect.gen(function* () {
    const entries = yield* fs.readDirectory('/proc').pipe(Effect.orElseSucceed(() => undefined))
    if (entries === undefined) return undefined
    const pids = entries.flatMap((entry) => {
      const pid = Number.parseInt(entry, 10)
      return `${pid}` === entry && Number.isSafeInteger(pid) === true && pid > 0 ? [pid] : []
    })
    const observed = yield* Effect.forEach(
      pids,
      (pid) =>
        fs.readLink(`/proc/${pid}/cwd`).pipe(
          Effect.map((path) => ({ pid, path })),
          Effect.orElseSucceed(() => undefined),
        ),
      { concurrency: 16 },
    )
    return observed.flatMap((entry) => (entry === undefined ? [] : [entry]))
  })

/**
 * Probe whether a live process is working inside `worktreePath`.
 *
 * `selfPid` defaults to this process; it and its descendants are excluded so
 * megarepo's own git children can never veto its work.
 */
export const readWorktreeInUse = ({
  worktreePath,
  selfPid = process.pid,
}: {
  worktreePath: AbsoluteDirPath | string
  selfPid?: number | undefined
}): Effect.Effect<InUseResult, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if ((yield* fs.exists('/proc').pipe(Effect.orElseSucceed(() => false))) === false) {
      return { _tag: 'unknown', reason: 'no-proc' } as const
    }
    const processes = yield* readProcessCwds(fs)
    if (processes === undefined) return { _tag: 'unknown', reason: 'scan-failed' } as const

    const inside = processes.filter((entry) =>
      isInsideWorktree({ candidate: entry.path, worktreePath }),
    )
    const excluded = yield* Effect.forEach(
      inside,
      (entry) =>
        hasAncestor({ fs, pid: entry.pid, ancestorPid: selfPid }).pipe(
          Effect.map((self) => (self === true ? [entry.pid] : [])),
        ),
      { concurrency: 8 },
    )
    return classifyInUse({
      processes: inside,
      worktreePath,
      excludePids: new Set(excluded.flat()),
    })
  })
