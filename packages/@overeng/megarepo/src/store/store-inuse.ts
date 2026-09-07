/**
 * Live-process in-use probe
 *
 * The deletion lease only excludes an activation that takes it. A shell or agent
 * session that was already sitting inside a worktree holds no lease, and on
 * Unix a directory rename is invisible to a process already in that directory:
 * its cwd silently follows the inode into `.archive/`, and the following git
 * bookkeeping strips the worktree out from under the live session. That is a
 * real incident class, not a hypothetical.
 *
 * So destructive reclamation additionally asks the strictly stronger question
 * the liveness manifest cannot answer: is a live OS process working inside this
 * directory right now? Evidence is `/proc/<pid>/cwd` on Linux and `lsof`'s cwd
 * table on macOS. Conservative in both directions that matter: no supported
 * process table, or an unreadable scan, is `unknown`, and the caller keeps.
 */

import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'

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

/** One observed process cwd. */
export interface ProcessCwd {
  readonly pid: number
  readonly path: string
}

interface DarwinProcessCwd extends ProcessCwd {
  readonly parentPid: number | undefined
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

const parsePidField = (value: string): number | undefined => {
  const parsed = Number.parseInt(value, 10)
  return `${parsed}` === value && Number.isSafeInteger(parsed) === true && parsed > 0
    ? parsed
    : undefined
}

/**
 * Parse `lsof -d cwd -FpnR` output into one cwd record per visible process.
 *
 * Process fields precede the selected cwd file record. Keeping the parser pure
 * makes the Darwin process-table contract independently testable on Linux.
 */
export const parseLsofProcessCwds = (
  lines: ReadonlyArray<string>,
): ReadonlyArray<DarwinProcessCwd> => {
  const observed: Array<DarwinProcessCwd> = []
  let pid: number | undefined
  let parentPid: number | undefined
  let path: string | undefined

  const flush = () => {
    if (pid !== undefined && path !== undefined) observed.push({ pid, parentPid, path })
  }

  for (const line of lines) {
    const field = line[0]
    const value = line.slice(1)
    if (field === 'p') {
      flush()
      pid = parsePidField(value)
      parentPid = undefined
      path = undefined
    } else if (field === 'R') {
      parentPid = parsePidField(value)
    } else if (field === 'n') {
      path = value
    }
  }
  flush()
  return observed
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

/** Read macOS process cwd and parent evidence from the system `lsof`. */
const readDarwinProcessCwds = (
  selfPid: number,
): Effect.Effect<ReadonlyArray<DarwinProcessCwd> | undefined, never, ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const lines = yield* spawner
      .lines(ChildProcess.make('/usr/sbin/lsof', ['-n', '-P', '-w', '-d', 'cwd', '-FpnR']))
      .pipe(Effect.timeout('5 seconds'), Effect.option)
    if (lines._tag === 'None') return undefined
    const observed = parseLsofProcessCwds(lines.value)
    return observed.some((entry) => entry.pid === selfPid) === true ? observed : undefined
  })

const hasDarwinAncestor = ({
  parentByPid,
  pid,
  ancestorPid,
}: {
  parentByPid: ReadonlyMap<number, number | undefined>
  pid: number
  ancestorPid: number
}): boolean => {
  let current = pid
  for (let depth = 0; depth < 64; depth += 1) {
    if (current === ancestorPid) return true
    if (current <= 1) return false
    const parent = parentByPid.get(current)
    if (parent === undefined) return false
    current = parent
  }
  return false
}

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
}): Effect.Effect<InUseResult, never, FileSystem.FileSystem | ChildProcessSpawner> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const hasProc = yield* fs.exists('/proc').pipe(Effect.orElseSucceed(() => false))

    if (hasProc === true) {
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
    }

    if (process.platform !== 'darwin') {
      return { _tag: 'unknown', reason: 'no-proc' } as const
    }
    const processes = yield* readDarwinProcessCwds(selfPid)
    if (processes === undefined) return { _tag: 'unknown', reason: 'scan-failed' } as const
    const inside = processes.filter((entry) =>
      isInsideWorktree({ candidate: entry.path, worktreePath }),
    )
    const parentByPid = new Map(processes.map((entry) => [entry.pid, entry.parentPid]))
    return classifyInUse({
      processes: inside,
      worktreePath,
      excludePids: new Set(
        inside
          .filter((entry) =>
            hasDarwinAncestor({ parentByPid, pid: entry.pid, ancestorPid: selfPid }),
          )
          .map((entry) => entry.pid),
      ),
    })
  })
