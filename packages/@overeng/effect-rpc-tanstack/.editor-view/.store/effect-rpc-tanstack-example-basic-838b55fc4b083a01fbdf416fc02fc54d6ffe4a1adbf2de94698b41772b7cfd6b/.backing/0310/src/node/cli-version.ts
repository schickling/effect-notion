import { Console as NodeConsole } from 'node:console'

import { Console, Context, Effect, Layer, Option } from 'effect'
import { CliOutput } from 'effect/unstable/cli'

/** CLI name and version pair, provided at startup for error diagnostics. */
export interface CliVersionInfo {
  readonly name: string
  readonly version: string
}

/** Version stamp appended to rendered diagnostics, e.g. `" (genie 0.1.0+abc123)"`. */
const versionSuffix = ({ name, version }: CliVersionInfo): string => ` (${name} ${version})`

/**
 * Wrap an upstream `CliOutput.Formatter` (rc.111) so rendered CLI errors carry
 * the CLI version stamp. This is the rendering-side successor of the deleted
 * `CliVersion.enrichErrors` error-cloning workaround, which tripped Effect v4's
 * getter-only `message` accessors under Bun: errors are no longer mutated, and
 * help/version rendering stays upstream bytes.
 */
const stampErrorsWithVersion = ({
  formatter,
  info,
}: {
  formatter: CliOutput.Formatter
  info: CliVersionInfo
}): CliOutput.Formatter => {
  const stamp = (rendered: string): string => `${rendered}${versionSuffix(info)}`
  return {
    ...formatter,
    formatCliError: (error) => stamp(formatter.formatCliError(error)),
    formatError: (error) => stamp(formatter.formatError(error)),
    formatErrors: (errors) =>
      errors.length === 0 ? formatter.formatErrors(errors) : stamp(formatter.formatErrors(errors)),
  }
}

/** CLI identity and version, provided at startup for error diagnostics. */
export class CliVersion extends Context.Service<CliVersion, CliVersionInfo>()('CliVersion') {
  /**
   * Yield a version suffix for use in error messages.
   * Returns e.g. `" (genie 0.1.0+abc123)"` or `""` if `CliVersion` is not provided.
   */
  static suffix: Effect.Effect<string> = Effect.serviceOption(CliVersion).pipe(
    Effect.map((v) => (Option.isSome(v) === true ? versionSuffix(v.value) : '')),
  )

  /**
   * Upstream `CliOutput.Formatter` whose rendered CLI errors carry this CLI's
   * version stamp (`Command.runWith` renders validation and user errors through
   * it). Apply at the CLI boundary alongside the `CliVersion` service:
   *
   * @example
   * ```ts
   * Cli.Command.runWith(cmd, { version })(args).pipe(
   *   Effect.scoped,
   *   Effect.provide(CliVersion.formatterLayer),
   *   Effect.provideService(CliVersion, { name: 'mr', version }),
   *   runTuiMain(NodeRuntime),
   * )
   * ```
   */
  static formatterLayer: Layer.Layer<never, never, CliVersion> = Layer.effect(
    CliOutput.Formatter,
    Effect.map(CliVersion, (info) =>
      stampErrorsWithVersion({ formatter: CliOutput.defaultFormatter(), info }),
    ),
  )
}

/**
 * Whether an argv requests machine-readable stdout — `--output json|ndjson`
 * (`=`-attached or as the following token, `-o` alias included), the schema
 * command's `--output-mode json|ndjson` (where `--output` names the output
 * file), or a `--json` boolean. Such invocations must keep diagnostics off
 * stdout (cli-C guard); `auto` output resolving to JSON when piped is
 * deliberately not guessed here.
 */
export const argvRequestsJsonStdout = (args: ReadonlyArray<string>): boolean => {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === undefined) continue
    if (arg === '--json') return true
    const match = /^(?:--output|-o|--output-mode)(?:=(.*))?$/.exec(arg)
    if (match === null) continue
    const value = match[1] ?? args[index + 1]
    if (value === 'json' || value === 'ndjson') return true
  }
  return false
}

/** Console with every method bound to stderr, used while argv parsing renders diagnostics. */
const consoleOnStderr: Console.Console = new NodeConsole({
  stdout: process.stderr,
  stderr: process.stderr,
})

/**
 * Keep validation help off stdout for JSON/NDJSON invocations (cli-C guard):
 * upstream `Command.runWith` renders `ShowHelp` documents via `Console.log`,
 * which would corrupt the machine-readable stdout channel that the rc.111
 * locked-rebaseline otherwise accepts for human invocations. Inert unless the
 * argv requests JSON/NDJSON output; also reroutes parse-phase logger output
 * (loggers read the `Console` reference). Pair with {@link handlerConsoleLayer}
 * so handler-phase payload writes still reach stdout.
 */
export const jsonStdoutGuardLayer = (args: ReadonlyArray<string>): Layer.Layer<never> =>
  argvRequestsJsonStdout(args) === true
    ? Layer.succeed(Console.Console, consoleOnStderr)
    : Layer.empty

/**
 * Console binding for the command-handler phase, provided via
 * `Command.provide`: once argv parsing has succeeded, restore the ambient
 * console so handler-phase payload writes that go through the `Console`
 * service (TuiApp JSON/NDJSON output) land on stdout even while
 * {@link jsonStdoutGuardLayer} is active. No-op when the guard is inert.
 */
export const handlerConsoleLayer: Layer.Layer<never> = Layer.succeed(
  Console.Console,
  globalThis.console,
)

/** Build stamp for a CLI running directly from a local source tree. */
export type LocalStamp = {
  readonly type: 'local'
  readonly rev: string
  readonly ts: number
  readonly dirty: boolean
}

/** Build stamp embedded by Nix at build time. */
export type NixStamp = {
  readonly type: 'nix'
  readonly version: string
  readonly rev: string
  readonly commitTs: number
  /** Only present for intentionally impure builds. */
  readonly buildTs?: number
  readonly dirty: boolean
}

/** Discriminated union of build stamp types used to resolve CLI version strings. */
export type CliStamp = LocalStamp | NixStamp

/** Structured build identity shared by CLIs, UIs, diagnostics, and telemetry. */
export type CliBuildIdentity = {
  readonly baseVersion: string
  readonly displayVersion: string
  readonly machineVersion: string
  readonly sourceKind: 'package' | 'local' | 'nix'
  readonly rev?: string
  readonly dirty: boolean
  readonly commitTs?: number
  readonly buildTs?: number
}

type VersionEnv = {
  readonly [key: string]: string | undefined
}

/**
 * Format a Unix timestamp as a human-readable relative time.
 * Uses medium formatting: "5 min ago", "2 hours ago", "3 days ago", "Jan 15"
 */
const formatRelativeTime = ({ ts, now }: { ts: number; now: number }): string => {
  const diffSeconds = now - ts

  if (diffSeconds < 60) {
    return 'just now'
  }

  const diffMinutes = Math.floor(diffSeconds / 60)
  if (diffMinutes < 60) {
    return `${diffMinutes} min ago`
  }

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) {
    return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`
  }

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) {
    return `${diffDays} ${diffDays === 1 ? 'day' : 'days'} ago`
  }

  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7)
    return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`
  }

  // For older builds, show the date
  const date = new Date(ts * 1000)
  const month = date.toLocaleString('en-US', { month: 'short' })
  const day = date.getDate()
  return `${month} ${day}`
}

/**
 * Parse a JSON string as a CliStamp (LocalStamp or NixStamp).
 */
export const parseCliBuildStamp = (stamp: string): CliStamp | undefined => {
  try {
    const parsed = JSON.parse(stamp)
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined
    }

    if (parsed.type === 'local') {
      if (
        typeof parsed.rev === 'string' &&
        typeof parsed.ts === 'number' &&
        typeof parsed.dirty === 'boolean'
      ) {
        return { type: 'local', rev: parsed.rev, ts: parsed.ts, dirty: parsed.dirty }
      }
    } else if (parsed.type === 'nix') {
      if (
        typeof parsed.version === 'string' &&
        typeof parsed.rev === 'string' &&
        typeof parsed.commitTs === 'number' &&
        typeof parsed.dirty === 'boolean'
      ) {
        const buildTs = typeof parsed.buildTs === 'number' ? parsed.buildTs : undefined
        return {
          type: 'nix',
          version: parsed.version,
          rev: parsed.rev,
          commitTs: parsed.commitTs,
          ...(buildTs === undefined ? {} : { buildTs }),
          dirty: parsed.dirty,
        }
      }
    }
  } catch {
    // Invalid JSON
  }
  return undefined
}

/**
 * Render version string for a LocalStamp.
 *
 * Output examples:
 * - dirty:  "0.1.0 — running from local source (abc123, 5 min ago, with uncommitted changes)"
 * - clean:  "0.1.0 — running from local source (abc123, 2 hours ago)"
 */
const renderLocalVersion = ({
  baseVersion,
  stamp,
  now,
}: {
  baseVersion: string
  stamp: LocalStamp
  now: number
}): string => {
  const timeAgo = formatRelativeTime({ ts: stamp.ts, now })
  const dirtyNote = stamp.dirty === true ? ', with uncommitted changes' : ''
  return `${baseVersion} — running from local source (${stamp.rev}, ${timeAgo}${dirtyNote})`
}

/**
 * Render version string for a NixStamp.
 *
 * Output examples:
 * - pure, clean:   "0.1.0+def456 — committed 3 days ago"
 * - pure, dirty:   "0.1.0+def456-dirty — committed 3 days ago, with uncommitted changes"
 * - impure, clean: "0.1.0+def456 — built 2 hours ago"
 * - impure, dirty: "0.1.0+def456-dirty — built 2 hours ago, with uncommitted changes"
 */
const nixMachineVersion = (stamp: NixStamp): string => {
  const revAlreadyHasDirty = stamp.rev.endsWith('-dirty')
  const dirtySuffix = stamp.dirty === true && revAlreadyHasDirty === false ? '-dirty' : ''
  return `${stamp.version}+${stamp.rev}${dirtySuffix}`
}

const localMachineVersion = ({
  baseVersion,
  stamp,
}: {
  baseVersion: string
  stamp: LocalStamp
}): string => `${baseVersion}+local.${stamp.rev}${stamp.dirty === true ? '.dirty' : ''}`

const renderNixVersion = ({ stamp, now }: { stamp: NixStamp; now: number }): string => {
  const versionStr = nixMachineVersion(stamp)
  const dirtyNote = stamp.dirty === true ? ', with uncommitted changes' : ''

  if (stamp.buildTs !== undefined) {
    const timeAgo = formatRelativeTime({ ts: stamp.buildTs, now })
    return `${versionStr} — built ${timeAgo}${dirtyNote}`
  }

  const timeAgo = formatRelativeTime({ ts: stamp.commitTs, now })
  return `${versionStr} — committed ${timeAgo}${dirtyNote}`
}

const nixBuildIdentity = ({ stamp, now }: { stamp: NixStamp; now: number }): CliBuildIdentity => ({
  baseVersion: stamp.version,
  displayVersion: renderNixVersion({ stamp, now }),
  machineVersion: nixMachineVersion(stamp),
  sourceKind: 'nix',
  rev: stamp.rev,
  dirty: stamp.dirty,
  commitTs: stamp.commitTs,
  ...(stamp.buildTs === undefined ? {} : { buildTs: stamp.buildTs }),
})

/**
 * Resolve the full CLI build identity from the embedded build stamp and optional runtime stamp.
 */
export const resolveCliBuildIdentity = (options: {
  readonly baseVersion: string
  readonly buildStamp: string
  readonly env?: VersionEnv
  readonly now?: number
  readonly runtimeStampEnvVar?: string
}): CliBuildIdentity => {
  const {
    baseVersion,
    buildStamp,
    env = process.env,
    now = Math.floor(Date.now() / 1000),
    runtimeStampEnvVar = 'CLI_BUILD_STAMP',
  } = options
  const buildTimeStamp = parseCliBuildStamp(buildStamp)

  if (buildTimeStamp?.type === 'nix') {
    return nixBuildIdentity({ stamp: buildTimeStamp, now })
  }

  const runtimeStampRaw = env[runtimeStampEnvVar]?.trim()
  const runtimeStamp =
    runtimeStampRaw === undefined || runtimeStampRaw.length === 0
      ? undefined
      : parseCliBuildStamp(runtimeStampRaw)

  if (runtimeStamp?.type === 'local') {
    return {
      baseVersion,
      displayVersion: renderLocalVersion({ baseVersion, stamp: runtimeStamp, now }),
      machineVersion: localMachineVersion({ baseVersion, stamp: runtimeStamp }),
      sourceKind: 'local',
      rev: runtimeStamp.rev,
      dirty: runtimeStamp.dirty,
      buildTs: runtimeStamp.ts,
    }
  }

  if (runtimeStamp?.type === 'nix') {
    return nixBuildIdentity({ stamp: runtimeStamp, now })
  }

  return {
    baseVersion,
    displayVersion: baseVersion,
    machineVersion: baseVersion,
    sourceKind: 'package',
    dirty: false,
  }
}

/**
 * Resolve the machine-readable CLI version suitable for telemetry, logs, and protocol payloads.
 */
export const resolveCliMachineVersion = (
  options: Parameters<typeof resolveCliBuildIdentity>[0],
): string => resolveCliBuildIdentity(options).machineVersion

/**
 * Resolve the CLI version from build stamp and optional runtime stamp.
 *
 * @param baseVersion - The package.json version (used for local builds)
 * @param buildStamp - JSON stamp embedded at build time, or placeholder '__CLI_BUILD_STAMP__'
 * @param runtimeStampEnvVar - Environment variable name for runtime stamp (default: 'CLI_BUILD_STAMP')
 */
export const resolveCliVersion = (options: {
  baseVersion: string
  buildStamp: string
  runtimeStampEnvVar?: string
}): string => resolveCliBuildIdentity(options).displayVersion
