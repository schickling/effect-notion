/**
 * Git operations for megarepo
 *
 * Provides Effect-wrapped git operations for cloning, fetching, and managing worktrees.
 */

import { Cause, Duration, Effect, Option, Schedule, Sink, Stream } from 'effect'
import * as Command from 'effect/unstable/process/ChildProcess'

import * as Observability from './observability.ts'

// =============================================================================
// Git URL Parsing
// =============================================================================

/** Parsed components of a git remote URL */
export interface ParsedGitRemote {
  readonly host: string
  readonly owner: string
  readonly repo: string
}

/**
 * Parse a git remote URL (SSH or HTTPS) into host/owner/repo components
 */
export const parseGitRemoteUrl = (url: string): Option.Option<ParsedGitRemote> => {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/)
  if (sshMatch?.[1] !== undefined && sshMatch[2] !== undefined && sshMatch[3] !== undefined) {
    return Option.some({
      host: sshMatch[1],
      owner: sshMatch[2],
      repo: sshMatch[3],
    })
  }

  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/)
  if (httpsMatch?.[1] !== undefined && httpsMatch[2] !== undefined && httpsMatch[3] !== undefined) {
    return Option.some({
      host: httpsMatch[1],
      owner: httpsMatch[2],
      repo: httpsMatch[3],
    })
  }

  return Option.none()
}

// =============================================================================
// Git Command Error
// =============================================================================

/** Error thrown when a git command fails with non-zero exit code */
export class GitCommandError extends Error {
  readonly _tag = 'GitCommandError'
  readonly args: ReadonlyArray<string>
  readonly exitCode: number
  readonly stderr: string

  constructor({
    args,
    exitCode,
    stderr,
  }: {
    args: ReadonlyArray<string>
    exitCode: number
    stderr: string
  }) {
    // Use stderr as the message if available, otherwise use a generic message
    const stderrTrimmed = stderr.trim()
    const message =
      stderrTrimmed.length > 0
        ? stderrTrimmed
        : `git ${args.join(' ')} failed with exit code ${exitCode}`
    super(message)
    this.name = 'GitCommandError'
    this.args = args
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

/** Error thrown when a git command exceeds the deterministic command deadline. */
export class GitCommandTimeoutError extends GitCommandError {
  readonly timedOut = true
  readonly timeoutMillis: number

  constructor({ args, timeoutMillis }: { args: ReadonlyArray<string>; timeoutMillis: number }) {
    super({
      args,
      exitCode: 124,
      stderr: `git ${args.join(' ')} timed out after ${timeoutMillis}ms`,
    })
    this.name = 'GitCommandTimeoutError'
    this.timeoutMillis = timeoutMillis
  }
}

// =============================================================================
// Git Commands
// =============================================================================

/**
 * The git command deadline is a LIVENESS bound: it kills a wedged subprocess so a
 * hung git can never wedge the calling fiber (paired with the SIGKILL finalizer in
 * {@link startGitProcess}). A single flat value cannot serve both a millisecond-scale
 * local op (`rev-parse`, `status`) and a network transfer whose honest duration scales
 * with repo size — a bare clone of a large member (e.g. `effect-ts/effect`, ~140MB
 * pack) legitimately exceeds 30s under CI contention, yet a hung `rev-parse` must not be
 * allowed to hang for minutes. So the deadline is classified per operation: local ops
 * keep the tight bound, network ops (clone/fetch/pull/push/ls-remote) get a generous one.
 */
const LOCAL_GIT_TIMEOUT_MILLIS = 30_000
const DEFAULT_GIT_NETWORK_TIMEOUT_MILLIS = 600_000

/**
 * git subcommands that perform network I/O, so their honest runtime is bounded by
 * transfer size / remote latency rather than local CPU.
 */
const NETWORK_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'clone',
  'fetch',
  'pull',
  'push',
  'ls-remote',
])

/**
 * git global options (before the subcommand) that consume the FOLLOWING arg as a
 * separate value, e.g. `-c name=value`, `-C <path>`. The subcommand scan skips both the
 * option and its value. The `--opt=value` forms are single tokens and are skipped as
 * ordinary flags.
 */
const GIT_GLOBAL_OPTS_WITH_VALUE: ReadonlySet<string> = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--attr-source',
])

/**
 * The git subcommand within `args`, skipping any leading global options — git's documented
 * form is `git [<global options>] <command> [<args>]`. Every internal call site passes the
 * subcommand first, but `runCommand` is part of the public API (re-exported from `mod.ts`),
 * so a caller may legitimately prepend `-c name=value` / `-C <path>`; classifying on a raw
 * `args[0]` would misread the option as the subcommand and pick the wrong deadline.
 */
const gitSubcommand = (args: ReadonlyArray<string>): string | undefined => {
  let index = 0
  while (index < args.length) {
    const token = args[index]!
    if (token.startsWith('-') === false) return token
    index += GIT_GLOBAL_OPTS_WITH_VALUE.has(token) === true ? 2 : 1
  }
  return undefined
}

/** Whether a git invocation performs network I/O (see {@link NETWORK_GIT_SUBCOMMANDS}). */
export const isNetworkGitCommand = (args: ReadonlyArray<string>): boolean => {
  const subcommand = gitSubcommand(args)
  return subcommand !== undefined && NETWORK_GIT_SUBCOMMANDS.has(subcommand)
}

const parsePositiveIntEnv = (name: string): number | undefined => {
  const raw = process.env[name]
  if (raw === undefined) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isInteger(parsed) === true && parsed > 0 ? parsed : undefined
}

/**
 * Deadline (ms) for a git invocation, chosen by operation class.
 *
 * Local ops keep a fixed {@link LOCAL_GIT_TIMEOUT_MILLIS} liveness bound. Network ops —
 * whose honest runtime scales with transfer size / remote latency — get a generous
 * default, tunable via the single `MEGAREPO_GIT_NETWORK_TIMEOUT_MS` knob (also the test
 * seam). Nobody has needed to tune the local bound; add a knob back if that changes.
 */
export const gitCommandTimeoutMillis = (args: ReadonlyArray<string>): number =>
  isNetworkGitCommand(args) === true
    ? (parsePositiveIntEnv('MEGAREPO_GIT_NETWORK_TIMEOUT_MS') ?? DEFAULT_GIT_NETWORK_TIMEOUT_MILLIS)
    : LOCAL_GIT_TIMEOUT_MILLIS

const withGitCommandTimeout =
  <A, E, R>({ args, timeoutMillis }: { args: ReadonlyArray<string>; timeoutMillis: number }) =>
  (effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.timeout(Duration.millis(timeoutMillis)),
      Effect.catchTag('TimeoutError', () =>
        Effect.fail(new GitCommandTimeoutError({ args, timeoutMillis })),
      ),
    )

/** Decode a chunk of byte buffers into a string with a single O(n) allocation. */
const decodeChunks = (chunks: ReadonlyArray<Uint8Array>): string => {
  const arr = chunks
  let total = 0
  for (const chunk of arr) total += chunk.length
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of arr) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder('utf-8').decode(merged)
}

/**
 * Start a git subprocess with piped stdout/stderr and register a SIGKILL
 * finalizer so an interrupted command never leaks a running child.
 */
const startGitProcess = ({ args, cwd }: { args: ReadonlyArray<string>; cwd?: string }) =>
  Effect.gen(function* () {
    const process = yield* Command.make('git', args, {
      cwd,
      stderr: 'pipe',
      stdout: 'pipe',
    })

    yield* Effect.addFinalizer((exit) =>
      Effect.gen(function* () {
        if (exit._tag !== 'Failure' || Cause.hasInterruptsOnly(exit.cause) === false) {
          return
        }

        const isRunning = yield* process.isRunning.pipe(Effect.orElseSucceed(() => false))
        if (isRunning === false) return

        yield* process.kill({ killSignal: 'SIGKILL' }).pipe(Effect.ignore)
      }),
    )
    return process
  })

/**
 * Run a git command and return stdout.
 * Fails with GitCommandError if exit code is non-zero.
 *
 * Buffers the full output, so use {@link streamGitCommandLines} for commands
 * whose output is unbounded (large `status`/`worktree list`/`rev-list`).
 */
const runGitCommand = ({ args, cwd }: { args: ReadonlyArray<string>; cwd?: string }) =>
  (() => {
    const timeoutMillis = gitCommandTimeoutMillis(args)
    return Effect.gen(function* () {
      const process = yield* startGitProcess(cwd !== undefined ? { args, cwd } : { args })

      // Collect stdout and stderr. Concat is a single O(n) allocation per stream
      // (sum lengths once, allocate once, copy once) — the previous per-chunk
      // `reduce` reallocated the whole buffer on every chunk, which is O(n²) in
      // output size and OOM-killed the host on large `git status` output.
      const [stdoutChunks, stderrChunks] = yield* Effect.all([
        Stream.runCollect(process.stdout),
        Stream.runCollect(process.stderr),
      ])

      const stdout = decodeChunks(stdoutChunks)
      const stderr = decodeChunks(stderrChunks)

      const exitCode = yield* process.exitCode

      if (exitCode !== 0) {
        return yield* Effect.fail(new GitCommandError({ args, exitCode, stderr }))
      }

      yield* Observability.annotateGitCmdOutput({
        outputBytes: Buffer.byteLength(stdout, 'utf-8'),
        outputLines: stdout.length === 0 ? 0 : stdout.split('\n').length,
      })

      return stdout.trim()
    }).pipe(
      Effect.scoped,
      withGitCommandTimeout({ args, timeoutMillis }),
      Observability.withGitCmdSpan({ args, streamed: false, timeoutMs: timeoutMillis }),
    )
  })()

/** Run a bounded, observable git command and return trimmed stdout. */
export const runCommand = ({ args, cwd }: { args: ReadonlyArray<string>; cwd?: string }) =>
  runGitCommand(cwd === undefined ? { args } : { args, cwd })

/**
 * Run a git command, folding stdout LINE BY LINE through `sink` at constant
 * memory — stdout is never materialized, so peak memory is independent of output
 * size. stderr is collected (bounded: small for the commands this is used with)
 * and the exit code is checked, so {@link GitCommandError} semantics are
 * identical to {@link runGitCommand}.
 *
 * `streamLines` alone is unsuitable here: it discards the exit code and stderr,
 * silently returning an empty stream on a failing command. We therefore drive the
 * process explicitly via {@link startGitProcess}.
 *
 * Lines are split with `Stream.splitLines`, which (like a trailing-newline-aware
 * `split('\n')`) drops only the final empty segment after the trailing newline;
 * interior blank lines are preserved, so porcelain record separators survive.
 */
const streamGitCommandLines = <A>({
  args,
  cwd,
  sink,
}: {
  args: ReadonlyArray<string>
  cwd?: string
  sink: Sink.Sink<A, string, string>
}) =>
  (() => {
    const timeoutMillis = gitCommandTimeoutMillis(args)
    return Effect.gen(function* () {
      const process = yield* startGitProcess(cwd !== undefined ? { args, cwd } : { args })

      // SCALAR running counters for the git-cmd output-size span attributes — these
      // must never accumulate the lines themselves, or we reintroduce the O(n²)
      // buffering. `Stream.tap` bumps them as each line flows past on its way to the
      // sink, so memory stays constant.
      let outputLines = 0
      let outputBytes = 0

      const [result, stderrChunks, exitCode] = yield* Effect.all(
        [
          process.stdout.pipe(
            Stream.decodeText({ encoding: 'utf-8' }),
            Stream.splitLines,
            Stream.tap((line) =>
              Effect.sync(() => {
                outputLines += 1
                outputBytes += Buffer.byteLength(line, 'utf-8') + 1 // + newline
              }),
            ),
            Stream.run(sink),
          ),
          Stream.runCollect(process.stderr),
          process.exitCode,
        ],
        { concurrency: 'unbounded' },
      )

      if (exitCode !== 0) {
        return yield* Effect.fail(
          new GitCommandError({ args, exitCode, stderr: decodeChunks(stderrChunks) }),
        )
      }

      yield* Observability.annotateGitCmdOutput({ outputBytes, outputLines })

      return result
    }).pipe(
      Effect.scoped,
      withGitCommandTimeout({ args, timeoutMillis }),
      Observability.withGitCmdSpan({ args, streamed: true, timeoutMs: timeoutMillis }),
    )
  })()

// =============================================================================
// Transient Error Retry
// =============================================================================

/**
 * Classify whether a git error is likely transient (network issue) and worth retrying.
 *
 * Only matches connection-level failures (handshake, connect, read) — NOT permanent
 * SSL certificate validation errors (e.g. "certificate rejected") which would fail
 * identically on every retry.
 */
export const isTransientGitError = (error: GitCommandError): boolean => {
  if (error instanceof GitCommandTimeoutError) return false

  const stderr = error.stderr.toLowerCase()
  return (
    stderr.includes('http 5') ||
    stderr.includes('rpc failed') ||
    stderr.includes('could not resolve host') ||
    stderr.includes('network is unreachable') ||
    stderr.includes('connection refused') ||
    stderr.includes('connection reset') ||
    stderr.includes('timed out') ||
    stderr.includes('unexpected disconnect') ||
    stderr.includes('the remote end hung up') ||
    stderr.includes('ssl_connect') ||
    stderr.includes('ssl handshake') ||
    stderr.includes('ssl_read') ||
    stderr.includes('gnutls_handshake') ||
    stderr.includes('gnutls_record_recv') ||
    stderr.includes('curl error')
  )
}

const GIT_MAX_RETRIES = 3

const transientGitRetrySchedule = Schedule.max([
  Schedule.exponential('2 seconds'),
  Schedule.recurs(GIT_MAX_RETRIES),
])

/**
 * Run a git command with automatic retry on transient network errors.
 * Uses exponential backoff (2s, 4s, 8s) for up to 3 retries.
 */
const runGitCommandWithRetry = ({ args, cwd }: { args: ReadonlyArray<string>; cwd?: string }) =>
  Effect.gen(function* () {
    const meta = yield* Schedule.CurrentMetadata
    if (meta.attempt > 0) {
      const prevError = meta.input as GitCommandError
      yield* Effect.logWarning('Retrying git command after transient error').pipe(
        Effect.annotateLogs({
          command: `git ${args.join(' ')}`,
          attempt: meta.attempt,
          maxRetries: GIT_MAX_RETRIES,
          elapsed: Duration.format(Duration.millis(meta.elapsed)),
          error: prevError.stderr.trim().split('\n')[0] ?? '',
        }),
      )
    }
    return yield* runGitCommand(cwd !== undefined ? { args, cwd } : { args })
  }).pipe(
    Effect.retry({
      schedule: transientGitRetrySchedule,
      while: (error) => error instanceof GitCommandError && isTransientGitError(error),
    }),
  )

/**
 * Clone a git repository
 */
export const clone = (args: { url: string; targetPath: string; bare?: boolean }) =>
  Effect.gen(function* () {
    const cmdArgs = ['clone']
    if (args.bare === true) {
      cmdArgs.push('--bare')
    }
    cmdArgs.push(args.url, args.targetPath)
    yield* runGitCommandWithRetry({ args: cmdArgs })
  }).pipe(
    Observability.withGitUrlSpan({
      name: 'git/clone',
      label: args.url,
      url: args.url,
      bare: args.bare ?? false,
    }),
  )

/**
 * Fetch updates from remote
 */
export const fetch = (args: { repoPath: string; remote?: string; prune?: boolean }) =>
  Effect.gen(function* () {
    const cmdArgs = ['fetch']
    if (args.prune === true) {
      cmdArgs.push('--prune')
    }
    cmdArgs.push(args.remote ?? 'origin')
    yield* runGitCommandWithRetry({ args: cmdArgs, cwd: args.repoPath })
  }).pipe(Observability.withRepoPathSpan({ name: 'git/fetch', path: args.repoPath }))

/**
 * Checkout a specific ref (branch, tag, or commit)
 */
export const checkout = (args: { repoPath: string; ref: string }) =>
  runGitCommand({ args: ['checkout', args.ref], cwd: args.repoPath }).pipe(Effect.asVoid)

/**
 * Get the current branch name
 */
export const getCurrentBranch = (repoPath: string) =>
  Effect.gen(function* () {
    const result = yield* runGitCommand({
      args: ['rev-parse', '--abbrev-ref', 'HEAD'],
      cwd: repoPath,
    })
    return result === 'HEAD' ? Option.none() : Option.some(result)
  })

/**
 * Get the current commit SHA
 */
export const getCurrentCommit = (repoPath: string) =>
  runGitCommand({ args: ['rev-parse', 'HEAD'], cwd: repoPath })

/**
 * Get the remote URL (origin by default)
 */
export const getRemoteUrl = ({
  repoPath,
  remote = 'origin',
}: {
  repoPath: string
  remote?: string
}) =>
  runGitCommand({
    args: ['remote', 'get-url', remote],
    cwd: repoPath,
  }).pipe(
    Effect.asSome,
    Effect.orElseSucceed(() => Option.none()),
  )

/**
 * Check if a directory is a git repository
 */
export const isGitRepo = (path: string) =>
  runGitCommand({
    args: ['rev-parse', '--git-dir'],
    cwd: path,
  }).pipe(
    Effect.map(() => true),
    Effect.orElseSucceed(() => false),
  )

// =============================================================================
// Git Worktree Operations
// =============================================================================

/**
 * Create a git worktree
 */
export const createWorktree = (args: {
  repoPath: string
  worktreePath: string
  branch: string
  createBranch?: boolean
  /** Start point for new branch (only used with createBranch: true) */
  startPoint?: string
}) =>
  Effect.gen(function* () {
    const cmdArgs = ['worktree', 'add']
    if (args.createBranch === true) {
      cmdArgs.push('-b', args.branch)
      cmdArgs.push(args.worktreePath)
      if (args.startPoint !== undefined) {
        cmdArgs.push(args.startPoint)
      }
    } else {
      cmdArgs.push(args.worktreePath, args.branch)
    }
    yield* runGitCommand({ args: cmdArgs, cwd: args.repoPath })
  }).pipe(
    Observability.withGitBranchSpan({
      name: 'git/create-worktree',
      branch: args.branch,
    }),
  )

/**
 * Remove a git worktree
 */
export const removeWorktree = (args: { repoPath: string; worktreePath: string; force?: boolean }) =>
  Effect.gen(function* () {
    const cmdArgs = ['worktree', 'remove']
    if (args.force === true) {
      cmdArgs.push('--force')
    }
    cmdArgs.push(args.worktreePath)
    yield* runGitCommand({ args: cmdArgs, cwd: args.repoPath })
  })

/** Prune stale worktree bookkeeping entries from a bare repo */
export const pruneWorktrees = (repoPath: string) =>
  runGitCommand({ args: ['worktree', 'prune'], cwd: repoPath }).pipe(
    Effect.asVoid,
    Observability.withRepoPathSpan({ name: 'git/worktree-prune', path: repoPath }),
  )

/**
 * Move a git worktree to a new path.
 */
export const moveWorktree = (args: { repoPath: string; fromPath: string; toPath: string }) =>
  runGitCommand({
    args: ['worktree', 'move', args.fromPath, args.toPath],
    cwd: args.repoPath,
  }).pipe(Effect.asVoid)

/**
 * List git worktrees
 */
export const listWorktrees = (repoPath: string) =>
  Effect.gen(function* () {
    type Worktree = { path: string; head: string; branch: Option.Option<string> }

    // Mutable accumulator: each completed record is PUSHED (amortized O(1)), so
    // the whole parse is O(n) — NOT a per-record `[...worktrees, x]` spread, which
    // would be O(n²) and reintroduce the buffering this refactor removes. `current`
    // stays small/immutable. Lines are folded one at a time, so memory is bounded
    // by the parsed worktree set, never the full subprocess output.
    const worktrees: Array<Worktree> = []
    let current: { path?: string; head?: string; branch?: string } = {}
    const flush = () => {
      if (current.path !== undefined && current.head !== undefined) {
        worktrees.push({
          path: current.path,
          head: current.head,
          branch: Option.fromUndefinedOr(current.branch),
        })
      }
      current = {}
    }

    // `worktree list --porcelain` emits newline-delimited records separated by
    // blank lines; a record ends on a blank line, and the final record is flushed
    // at end-of-stream.
    yield* streamGitCommandLines({
      args: ['worktree', 'list', '--porcelain'],
      cwd: repoPath,
      sink: Sink.forEach((line: string) =>
        Effect.sync(() => {
          if (line.startsWith('worktree ') === true) {
            current.path = line.slice(9)
          } else if (line.startsWith('HEAD ') === true) {
            current.head = line.slice(5)
          } else if (line.startsWith('branch ') === true) {
            current.branch = line.slice(7).replace('refs/heads/', '')
          } else if (line === '') {
            flush()
          }
        }),
      ),
    })

    // Flush remaining entry if output doesn't end with a blank line.
    flush()
    return worktrees
  })

/**
 * List ref short-names under a `refs/<namespace>/` prefix in a bare repo (e.g.
 * `namespace: 'heads'` yields branch names like `main`, `schickling/foo`).
 *
 * Names are folded one line at a time (bounded memory), so this is safe on repos
 * with very large ref sets. The bare repo's ref set is the authoritative source
 * of truth for which store-layout directories are worktree roots vs intermediate
 * namespace directories.
 */
export const listRefShortNames = (args: { bareRepoPath: string; namespace: 'heads' | 'tags' }) =>
  Effect.gen(function* () {
    const prefix = `refs/${args.namespace}/`
    const names: Array<string> = []
    yield* streamGitCommandLines({
      args: ['for-each-ref', '--format=%(refname)', prefix],
      cwd: args.bareRepoPath,
      sink: Sink.forEach((line: string) =>
        Effect.sync(() => {
          if (line.startsWith(prefix) === true) names.push(line.slice(prefix.length))
        }),
      ),
    })
    return names
  })

// =============================================================================
// Bare Repo Operations
// =============================================================================

/**
 * Clone a repository as a bare repo.
 * Configures fetch refspec so remote tracking refs are created on fetch.
 * (git clone --bare doesn't set this up by default)
 */
export const cloneBare = (args: { url: string; targetPath: string }) =>
  Effect.gen(function* () {
    yield* clone({ url: args.url, targetPath: args.targetPath, bare: true })
    yield* runGitCommand({
      args: ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
      cwd: args.targetPath,
    })
  }).pipe(
    Observability.withGitUrlSpan({
      name: 'git/clone-bare',
      label: args.url,
      url: args.url,
    }),
  )

/**
 * Fetch all refs from remote in a bare repo
 * Includes tags and prunes stale refs
 */
export const fetchBare = (args: { repoPath: string; remote?: string }) =>
  Effect.gen(function* () {
    const remote = args.remote ?? 'origin'
    yield* runGitCommandWithRetry({
      args: ['fetch', '--tags', '--prune', remote],
      cwd: args.repoPath,
    })
  }).pipe(Observability.withRepoPathSpan({ name: 'git/fetch-bare', path: args.repoPath }))

/**
 * Fetch forge pull-request head refs into a bare repo.
 *
 * A bare repo created by {@link cloneBare} tracks `+refs/heads/*` only, so a commit that exists solely
 * on a pull-request head — which is the normal shape when a downstream repo pins an upstream PR branch,
 * especially a PR opened from a fork — is never fetched and looks unreachable. GitHub-style forges do
 * expose those commits from the canonical remote under `refs/pull/<n>/head`, so this recovers them.
 *
 * Kept separate from {@link fetchBare} rather than folded in as a flag: it is only worth its extra ref
 * negotiation on the missing-commit recovery path, and repos with many open pull requests would
 * otherwise pay for it on every ordinary fetch.
 */
export const fetchPullRequestHeads = (args: { repoPath: string; remote?: string }) =>
  Effect.gen(function* () {
    const remote = args.remote ?? 'origin'
    yield* runGitCommandWithRetry({
      args: ['fetch', remote, '+refs/pull/*/head:refs/remotes/origin/pr/*'],
      cwd: args.repoPath,
    })
  }).pipe(
    Observability.withRepoPathSpan({ name: 'git/fetch-pull-request-heads', path: args.repoPath }),
  )

/**
 * Get the default branch name from a remote
 * Uses `git ls-remote --symref` to query the remote's HEAD
 */
export const getDefaultBranch = (args: { url: string } | { repoPath: string; remote?: string }) =>
  Effect.gen(function* () {
    let output: string

    if ('url' in args) {
      // Query remote directly by URL
      output = yield* runGitCommandWithRetry({
        args: ['ls-remote', '--symref', args.url, 'HEAD'],
      })
    } else {
      // Query remote by name from existing repo
      const remote = args.remote ?? 'origin'
      output = yield* runGitCommandWithRetry({
        args: ['ls-remote', '--symref', remote, 'HEAD'],
        cwd: args.repoPath,
      })
    }

    // Parse output: "ref: refs/heads/main\tHEAD"
    const match = output.match(/ref: refs\/heads\/([^\t\n]+)/)
    if (match?.[1] !== undefined) {
      return Option.some(match[1])
    }
    return Option.none()
  })

/**
 * The store bare repo's default branch, read LOCALLY from its `HEAD` symbolic ref
 * (set at clone time to the remote's default). Offline — no network, unlike
 * {@link getDefaultBranch} which `ls-remote`s. Returns `none` when HEAD is
 * detached or unreadable. Used by cold GC to never reclaim a repo's default
 * branch regardless of PR state or liveness.
 */
export const getStoreDefaultBranch = (args: { bareRepoPath: string }) =>
  runGitCommand({
    args: ['symbolic-ref', '--short', 'HEAD'],
    cwd: args.bareRepoPath,
  }).pipe(
    Effect.map((out) => (out === '' ? Option.none<string>() : Option.some(out))),
    Effect.orElseSucceed(() => Option.none<string>()),
  )

/**
 * Resolve a ref to its commit SHA
 * Works with branches, tags, and commits
 */
export const resolveRef = (args: { repoPath: string; ref: string }) =>
  runGitCommand({
    args: ['rev-parse', args.ref],
    cwd: args.repoPath,
  })

/**
 * Check if a ref resolves to an object that actually exists in the repo.
 * `rev-parse --verify <sha>` accepts a syntactically valid 40-char SHA even when
 * the object is missing, so we dereference to `^{object}` here.
 */
export const refExists = (args: { repoPath: string; ref: string }) =>
  runGitCommand({
    args: ['rev-parse', '--verify', `${args.ref}^{object}`],
    cwd: args.repoPath,
  }).pipe(
    Effect.map(() => true),
    Effect.orElseSucceed(() => false),
  )

/**
 * List commits reachable from `ref` but not from ANY remote-tracking ref
 * (`refs/remotes/*`), i.e. the commits that exist only locally.
 *
 * This is `git -C <repo> rev-list <ref> --not --remotes`. Unlike
 * `branch -r --contains <ref>` (which asks "is this exact tip on a remote"),
 * `rev-list --not --remotes` walks the history from `ref` and stops at the first
 * remote-reachable ancestor, so it returns ONLY the genuinely-unpushed commits.
 * A local commit stacked on top of a parent that lives on an unrelated remote
 * ref therefore still shows up here (the parent is excluded, the new commit is
 * not) — the distinction the lossless check relies on.
 *
 * The result is only as fresh as `refs/remotes/*`, so callers must
 * {@link fetchBare} (fetch --prune) first; on a bare repo with no remote-tracking
 * refs every commit is reported as unpushed.
 */
export const revListUnpushed = (args: { repoPath: string; ref: string }) =>
  Effect.gen(function* () {
    // Push each non-empty commit line into a mutable array (amortized O(1)) so the
    // unbounded `rev-list` output (a whole branch history) is consumed at O(n) —
    // NOT a per-line `[...commits, line]` spread, which would be O(n²).
    const commits: Array<string> = []
    yield* streamGitCommandLines({
      args: ['rev-list', args.ref, '--not', '--remotes'],
      cwd: args.repoPath,
      sink: Sink.forEach((line: string) =>
        Effect.sync(() => {
          if (line.trim().length > 0) commits.push(line)
        }),
      ),
    })
    return commits
  })

/**
 * Whether the repo has a non-empty stash.
 *
 * Stashes live in a single repo-global `refs/stash` ref in the bare repo (they
 * are NOT per-worktree and do NOT travel with a worktree directory move), so the
 * presence of `refs/stash` is the authoritative "stashed work would be lost"
 * signal. We test the ref directly rather than parsing `git stash list`, whose
 * output is unreliable for detached worktrees.
 */
export const hasStashRef = (args: { repoPath: string }) =>
  refExists({ repoPath: args.repoPath, ref: 'refs/stash' })

// =============================================================================
// Branch Operations
// =============================================================================

/**
 * Create a new branch in a bare repo from a base ref.
 * The branch is created locally and can then be pushed.
 *
 * @param repoPath - Path to the bare repo
 * @param branch - Name of the new branch to create
 * @param baseRef - The ref to create the branch from (commit, tag, or branch)
 */
export const createBranch = (args: { repoPath: string; branch: string; baseRef: string }) =>
  Effect.gen(function* () {
    // Resolve the base ref to a commit
    const baseCommit = yield* resolveRef({ repoPath: args.repoPath, ref: args.baseRef })

    // Create the branch pointing to that commit
    yield* runGitCommand({
      args: ['branch', args.branch, baseCommit],
      cwd: args.repoPath,
    })

    return baseCommit
  })

/**
 * Delete a local branch ref in a (bare) repo.
 *
 * Used by GC archival to FREE a `refs/heads/<branch>` after the worktree has
 * been moved aside, so `mr apply` can re-materialize the branch. `force` maps to
 * `git branch -D` (delete even if not merged); the commit stays reachable via
 * the remote-tracking ref the lossless floor proved.
 */
export const deleteBranch = (args: { repoPath: string; branch: string; force?: boolean }) =>
  runGitCommand({
    args: ['branch', args.force === true ? '-D' : '-d', args.branch],
    cwd: args.repoPath,
  }).pipe(Effect.asVoid, Observability.withGitDeleteBranchSpan(args.branch))

/**
 * Push a branch to the remote.
 *
 * @param repoPath - Path to the bare repo
 * @param branch - Name of the branch to push
 * @param remote - Remote name (default: 'origin')
 * @param setUpstream - Whether to set upstream tracking (default: true)
 */
export const pushBranch = (args: {
  repoPath: string
  branch: string
  remote?: string | undefined
  setUpstream?: boolean | undefined
}) =>
  Effect.gen(function* () {
    const remote = args.remote ?? 'origin'
    const cmdArgs = ['push']
    if (args.setUpstream !== false) {
      cmdArgs.push('-u')
    }
    cmdArgs.push(remote, args.branch)

    yield* runGitCommandWithRetry({
      args: cmdArgs,
      cwd: args.repoPath,
    })
  })

/**
 * Create a new branch and push it to the remote.
 * Combines createBranch and pushBranch for convenience.
 */
export const createAndPushBranch = (args: {
  repoPath: string
  branch: string
  baseRef: string
  remote?: string
}) =>
  Effect.gen(function* () {
    const baseCommit = yield* createBranch({
      repoPath: args.repoPath,
      branch: args.branch,
      baseRef: args.baseRef,
    })

    yield* pushBranch({
      repoPath: args.repoPath,
      branch: args.branch,
      remote: args.remote,
    })

    return baseCommit
  })

// =============================================================================
// Enhanced Worktree Operations
// =============================================================================

/**
 * Create a worktree at a specific commit (detached HEAD)
 * Used for tags and specific commits
 */
export const createWorktreeDetached = (args: {
  repoPath: string
  worktreePath: string
  commit: string
}) =>
  runGitCommand({
    args: ['worktree', 'add', '--detach', args.worktreePath, args.commit],
    cwd: args.repoPath,
  }).pipe(
    Effect.asVoid,
    Observability.withGitCommitSpan({
      name: 'git/create-worktree-detached',
      label: args.commit.slice(0, 8),
      commit: args.commit,
    }),
  )

/**
 * Worktree status information
 */
export interface WorktreeStatus {
  /** Whether the worktree has uncommitted changes */
  readonly isDirty: boolean
  /** Whether the worktree has unpushed commits */
  readonly hasUnpushed: boolean
  /** Number of uncommitted changes */
  readonly changesCount: number
}

const worktreeSpanLabel = (worktreePath: string): string =>
  worktreePath.split('/').findLast((part) => part.length > 0) ?? 'worktree'

const getUnpushedStatus = (worktreePath: string) =>
  runGitCommand({
    args: ['log', '@{upstream}..HEAD', '--oneline'],
    cwd: worktreePath,
  }).pipe(
    Effect.map((out) => out.split('\n').filter((line) => line.trim() !== '').length > 0),
    Effect.orElseSucceed(() => false), // No upstream or not a branch
  )

/**
 * Get the status of a worktree (dirty state, unpushed commits)
 */
export const getWorktreeStatus = (worktreePath: string) =>
  Effect.gen(function* () {
    // Count uncommitted changes by folding `status --porcelain` lines one at a
    // time. `--untracked-files=all` enumerates every untracked file, so a large
    // untracked tree yields huge output — never materialize it (the previous
    // single-buffer collect was the OOM trigger). Counting non-empty lines gives
    // the EXACT `changesCount`/`isDirty` at constant memory, so verdicts are
    // unchanged.
    const changesCount = yield* streamGitCommandLines({
      args: ['status', '--porcelain', '--untracked-files=all'],
      cwd: worktreePath,
      sink: Sink.fold<number, string>(
        () => 0,
        () => true,
        (count, line) => Effect.succeed(line.trim() !== '' ? count + 1 : count),
      ),
    })
    const isDirty = changesCount > 0

    // Check for unpushed commits (only relevant for branches)
    const unpushedOutput = yield* getUnpushedStatus(worktreePath)

    return {
      isDirty,
      hasUnpushed: unpushedOutput,
      changesCount,
    } satisfies WorktreeStatus
  }).pipe(
    Observability.withWorktreePathSpan({
      name: 'git/worktree-status',
      label: worktreeSpanLabel(worktreePath),
      worktreePath,
    }),
  )

/**
 * Get GC removal status with a cheap fail-closed preflight.
 *
 * Full untracked-file scans are required before declaring a worktree removable,
 * but they are expensive for large worktrees. For GC we can first check tracked
 * changes and unpushed commits; either one already makes the worktree ineligible
 * without walking untracked directories.
 */
export const getWorktreeRemovalStatus = (worktreePath: string) =>
  Effect.gen(function* () {
    const changesCount = yield* streamGitCommandLines({
      args: ['status', '--porcelain', '--untracked-files=normal'],
      cwd: worktreePath,
      // `=normal` collapses large untracked dirs to one entry, but stream-count
      // anyway so the dirty preflight stays constant-memory regardless of tree.
      sink: Sink.fold<number, string>(
        () => 0,
        () => true,
        (count, line) => Effect.succeed(line.trim() !== '' ? count + 1 : count),
      ),
    }).pipe(
      Observability.withWorktreePathSpan({
        name: 'git/worktree-removal-status/dirty',
        label: worktreeSpanLabel(worktreePath),
        worktreePath,
      }),
    )

    if (changesCount > 0) {
      return {
        isDirty: true,
        hasUnpushed: false,
        changesCount,
      } satisfies WorktreeStatus
    }

    const hasUnpushed = yield* getUnpushedStatus(worktreePath).pipe(
      Observability.withWorktreePathSpan({
        name: 'git/worktree-removal-status/unpushed',
        label: worktreeSpanLabel(worktreePath),
        worktreePath,
      }),
    )

    return {
      isDirty: false,
      hasUnpushed,
      changesCount: 0,
    } satisfies WorktreeStatus
  }).pipe(
    Observability.withWorktreePathSpan({
      name: 'git/worktree-removal-status',
      label: worktreeSpanLabel(worktreePath),
      worktreePath,
    }),
  )

/**
 * Update a branch worktree to the latest from remote
 * This is a pull operation (fetch + merge/fast-forward)
 */
export const updateWorktree = (args: { worktreePath: string; remote?: string }) =>
  Effect.gen(function* () {
    const remote = args.remote ?? 'origin'
    // Fetch and merge/rebase
    yield* runGitCommandWithRetry({
      args: ['pull', '--ff-only', remote],
      cwd: args.worktreePath,
    })
  })

/**
 * Fast-forward merge a ref into the current branch of a worktree
 * Used to update branch worktrees after fetching new commits
 */
export const mergeFFOnly = (args: { worktreePath: string; ref: string }) =>
  runGitCommand({
    args: ['merge', '--ff-only', args.ref],
    cwd: args.worktreePath,
  }).pipe(Effect.asVoid)

/**
 * Checkout a specific commit in a worktree
 */
export const checkoutWorktree = (args: { worktreePath: string; ref: string }) =>
  runGitCommand({
    args: ['checkout', args.ref],
    cwd: args.worktreePath,
  }).pipe(Effect.asVoid)

/**
 * Detach a worktree's HEAD from its branch (`git checkout --detach`).
 *
 * Used by GC archival: a moved named-branch worktree still has its
 * `refs/heads/<branch>` checked out, so `git branch -D <branch>` is refused
 * (`cannot delete branch 'X' used by worktree at ...`). Detaching HEAD first
 * frees the branch ref for deletion + later re-materialization (invariant 4).
 */
export const detachWorktreeHead = (args: { worktreePath: string }) =>
  runGitCommand({
    args: ['checkout', '--detach'],
    cwd: args.worktreePath,
  }).pipe(Effect.asVoid, Observability.withGitDetachWorktreeHeadSpan(args.worktreePath))

// =============================================================================
// Megarepo Name Derivation
// =============================================================================

/**
 * Derive megarepo name from git remote or directory name
 */
export const deriveMegarepoName = (repoPath: string) =>
  Effect.gen(function* () {
    // Try to get name from git remote
    const remoteUrl = yield* getRemoteUrl({ repoPath })

    return Option.flatMap(remoteUrl, parseGitRemoteUrl).pipe(
      Option.map((parsed) => `${parsed.owner}/${parsed.repo}`),
      Option.getOrElse(() => {
        // Fall back to directory name (filter empty segments for trailing slash support)
        const parts = repoPath.split('/').filter(Boolean)
        return parts[parts.length - 1] ?? 'unknown'
      }),
    )
  })

// =============================================================================
// Remote Ref Type Detection
// =============================================================================

/** The type of a git ref as determined by the remote */
export type RemoteRefType = 'tag' | 'branch' | 'unknown'

/** Result of querying remote refs */
export interface RemoteRefInfo {
  readonly type: RemoteRefType
  readonly commit: string
}

/**
 * Query a remote to determine the actual type of a ref (tag vs branch).
 * This is more accurate than heuristic-based detection.
 *
 * @returns The ref type and commit SHA, or 'unknown' if the ref doesn't exist
 */
export const queryRemoteRefType = (args: { url: string; ref: string }) =>
  Effect.gen(function* () {
    // Query both tags and heads from remote
    const output = yield* runGitCommandWithRetry({
      args: ['ls-remote', '--refs', args.url],
    }).pipe(Effect.orElseSucceed(() => ''))

    if (output.length === 0) {
      return { type: 'unknown' as const, commit: '' }
    }

    // Parse output: "sha\trefs/heads/branch" or "sha\trefs/tags/tag"
    const lines = output.split('\n').filter((line) => line.trim().length > 0)

    // Look for exact match
    for (const line of lines) {
      const [commit, refPath] = line.split('\t')
      if (commit === undefined || refPath === undefined) continue

      // Check if this is our ref
      if (refPath === `refs/tags/${args.ref}`) {
        return { type: 'tag' as const, commit }
      }
      if (refPath === `refs/heads/${args.ref}`) {
        return { type: 'branch' as const, commit }
      }
    }

    return { type: 'unknown' as const, commit: '' }
  })

/**
 * Query a bare repo to determine the actual type of a ref (tag vs branch).
 * Uses local refs after fetch.
 */
export const queryLocalRefType = (args: { repoPath: string; ref: string }) =>
  Effect.gen(function* () {
    // Check if it's a tag
    const tagExists = yield* runGitCommand({
      args: ['rev-parse', '--verify', `refs/tags/${args.ref}`],
      cwd: args.repoPath,
    }).pipe(
      Effect.map((commit) => ({ exists: true, commit })),
      Effect.orElseSucceed(() => ({ exists: false, commit: '' })),
    )

    if (tagExists.exists === true) {
      return { type: 'tag' as const, commit: tagExists.commit }
    }

    // Check if it's a branch (remote tracking)
    const branchExists = yield* runGitCommand({
      args: ['rev-parse', '--verify', `refs/remotes/origin/${args.ref}`],
      cwd: args.repoPath,
    }).pipe(
      Effect.map((commit) => ({ exists: true, commit })),
      Effect.orElseSucceed(() => ({ exists: false, commit: '' })),
    )

    if (branchExists.exists === true) {
      return { type: 'branch' as const, commit: branchExists.commit }
    }

    // Check local branch (less common in bare repos but possible)
    const localBranchExists = yield* runGitCommand({
      args: ['rev-parse', '--verify', `refs/heads/${args.ref}`],
      cwd: args.repoPath,
    }).pipe(
      Effect.map((commit) => ({ exists: true, commit })),
      Effect.orElseSucceed(() => ({ exists: false, commit: '' })),
    )

    if (localBranchExists.exists === true) {
      return { type: 'branch' as const, commit: localBranchExists.commit }
    }

    return { type: 'unknown' as const, commit: '' }
  })

/**
 * Validate that a ref exists, using hybrid approach:
 * - If bare repo exists locally, check there (fast, no network)
 * - If bare repo doesn't exist, query remote via ls-remote (accurate for new repos)
 *
 * @returns Object with `exists` boolean and optional `type` ('branch' | 'tag' | 'commit')
 */
export const validateRefExists = (args: {
  ref: string
  bareRepoPath: string | undefined
  bareExists: boolean
  cloneUrl: string
}) =>
  Effect.gen(function* () {
    const { ref, bareRepoPath, bareExists, cloneUrl } = args

    // If it looks like a commit SHA, we can't validate without the repo
    // Just assume it's valid - it will fail later if not
    if (/^[0-9a-f]{40}$/i.test(ref) === true) {
      return { exists: true, type: 'commit' as const }
    }

    if (bareExists === true && bareRepoPath !== undefined) {
      // Check locally (fast path)
      const localResult = yield* queryLocalRefType({ repoPath: bareRepoPath, ref })
      if (localResult.type !== 'unknown') {
        return { exists: true, type: localResult.type }
      }
      // Ref not found locally - could be a new remote branch
      // Fall through to remote check
    }

    // Check remote (slower but accurate for new repos or refs)
    const remoteResult = yield* queryRemoteRefType({ url: cloneUrl, ref })
    if (remoteResult.type !== 'unknown') {
      return { exists: true, type: remoteResult.type }
    }

    return { exists: false, type: undefined }
  })

// =============================================================================
// Error Message Interpretation
// =============================================================================

/**
 * Interpret a git error and return a user-friendly message with hints.
 */
export const interpretGitError = (error: GitCommandError): { message: string; hint?: string } => {
  const stderr = error.stderr.toLowerCase()
  const args = error.args

  // Repository not found / access denied
  if (
    stderr.includes('repository not found') === true ||
    stderr.includes('could not read from remote') === true ||
    stderr.includes('permission denied') === true
  ) {
    return {
      message: 'Repository not found or access denied',
      hint: 'Check the repository URL and your access permissions',
    }
  }

  // Authentication required
  if (
    stderr.includes('could not read username') === true ||
    stderr.includes('authentication failed') === true ||
    stderr.includes('invalid credentials') === true
  ) {
    return {
      message: 'Authentication required',
      hint: 'Configure git credentials or use SSH with an SSH key',
    }
  }

  // Ref not found (ambiguous argument)
  if (
    stderr.includes('ambiguous argument') === true ||
    stderr.includes('unknown revision') === true
  ) {
    // Extract the ref from the error or args
    const refMatch = error.stderr.match(/ambiguous argument '([^']+)'/)
    const ref = refMatch?.[1] ?? args.find((a) => !a.startsWith('-'))
    return {
      message: `Ref '${ref}' not found`,
      hint: `Check available refs with: git ls-remote --refs <url>`,
    }
  }

  // Clone destination exists
  if (stderr.includes('already exists and is not an empty directory') === true) {
    return {
      message: 'Target directory already exists',
      hint: 'Remove the directory or choose a different location',
    }
  }

  // Network errors
  if (
    stderr.includes('could not resolve host') === true ||
    stderr.includes('network is unreachable') === true ||
    stderr.includes('connection refused') === true
  ) {
    return {
      message: 'Network error - could not connect to remote',
      hint: 'Check your internet connection and the repository URL',
    }
  }

  // SSH errors
  if (
    stderr.includes('host key verification failed') === true ||
    stderr.includes('no such identity') === true
  ) {
    return {
      message: 'SSH connection failed',
      hint: 'Check your SSH configuration and keys',
    }
  }

  // Default: use original message but clean it up
  return {
    message: error.message.split('\n')[0] ?? error.message,
  }
}
