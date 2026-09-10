import os from 'node:os'
import path from 'node:path'

import { Context, Effect, FileSystem, Option, Schema } from 'effect'
/**
 * Configuration service — auto-detects repo from git remote, provides defaults for runner hosts.
 */
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'

import { ConfigError } from '../isomorphic/Errors.ts'

const commandString = ({ command, args }: { command: string; args: ReadonlyArray<string> }) =>
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- Effect service accessor, not a React hook.
  ChildProcessSpawner.use((spawner) => spawner.string(ChildProcess.make(command, args)))

const GitHubCliAuthConfig = Schema.TaggedStruct('gh-cli', {})
export type GitHubCliAuthConfig = typeof GitHubCliAuthConfig.Type

const GitHubAppAuthConfig = Schema.TaggedStruct('github-app', {
  clientID: Schema.String,
  installationIDs: Schema.Record(Schema.String, Schema.Int.check(Schema.isGreaterThan(0))),
  privateKeyPath: Schema.String,
})
export type GitHubAppAuthConfig = typeof GitHubAppAuthConfig.Type

/** Union schema for all supported GitHub authentication methods */
export const GitHubAuthConfig = Schema.Union([GitHubCliAuthConfig, GitHubAppAuthConfig])
export type GitHubAuthConfig = typeof GitHubAuthConfig.Type

/** Default auth config — uses the local `gh` CLI token */
export const defaultGitHubAuthConfig: GitHubAuthConfig = { _tag: 'gh-cli' }

/** Context tag for injecting the active GitHub auth config into the service graph */
export class GitHubAuthConfigTag extends Context.Service<GitHubAuthConfigTag, GitHubAuthConfig>()(
  'gh-ci-utils/GitHubAuthConfig',
) {}

const GhCiUtilsFileConfig = Schema.Struct({
  auth: GitHubAuthConfig.pipe(Schema.withDecodingDefault(Effect.succeed(defaultGitHubAuthConfig))),
})

/** Read `~/.config/gh-ci-utils/config.json` and return the `auth` field, defaulting to `gh-cli`. */
export const loadAuthConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const configPath = path.join(os.homedir(), '.config', 'gh-ci-utils', 'config.json')
  const exists = yield* fs.exists(configPath)
  if (!exists) return defaultGitHubAuthConfig

  const raw = yield* fs
    .readFileString(configPath)
    .pipe(
      Effect.mapError(
        (cause) => new ConfigError({ message: `Failed to read config: ${configPath}`, cause }),
      ),
    )
  const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(GhCiUtilsFileConfig))(
    raw,
  ).pipe(
    Effect.mapError(
      (cause) => new ConfigError({ message: 'Invalid gh-ci-utils config format', cause }),
    ),
  )
  return decoded.auth
})

/** Service providing CI utilities configuration (owner, repo, token) */
export const CiUtilsConfig = Schema.Struct({
  /** Repos to monitor (owner/repo format). Auto-detected from git remote if empty. */
  repos: Schema.Array(Schema.String),
  /** Runner-scaler hosts for /jobs endpoint */
  runnerHosts: Schema.Array(Schema.String),
})
export type CiUtilsConfig = typeof CiUtilsConfig.Type

const RunnerInventory = Schema.Struct({
  allHosts: Schema.Array(Schema.String),
  /** Repos directly served by this self-hosted fleet. Namespace-hosted repos are passed explicitly. */
  managedRepos: Schema.Array(Schema.String),
})
type RunnerInventory = typeof RunnerInventory.Type

const DEFAULT_RUNNER_HOSTS = ['dev3', 'dev4', 'mbp2021']

/** Detect the current repo from `git remote get-url origin`. */
const detectRepo = Effect.gen(function* () {
  const output = yield* commandString({
    command: 'git',
    args: ['remote', 'get-url', 'origin'],
  }).pipe(
    Effect.map((s) => s.trim()),
    Effect.mapError(
      (cause) =>
        new ConfigError({
          message: 'Failed to detect repo from git remote',
          cause,
        }),
    ),
  )

  /** Extract owner/repo from SSH or HTTPS git URLs */
  const match = /(?:github\.com)[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(output)
  if (!match?.[1]) {
    return yield* new ConfigError({
      message: `Could not parse GitHub repo from remote URL: ${output}`,
      cause: 'parse error',
    })
  }

  return match[1]
})

/** Detect the current git branch. */
export const detectCurrentBranch = Effect.gen(function* () {
  const branch = yield* commandString({
    command: 'git',
    args: ['rev-parse', '--abbrev-ref', 'HEAD'],
  }).pipe(
    Effect.map((s) => s.trim()),
    Effect.mapError(
      (cause) =>
        new ConfigError({
          message: 'Failed to detect current git branch',
          cause,
        }),
    ),
  )

  if (branch === 'HEAD') {
    return yield* new ConfigError({
      message: 'Detached HEAD — specify a target explicitly',
      cause: 'detached HEAD',
    })
  }

  return branch
})

const detectWorkspaceRoot = commandString({
  command: 'git',
  args: ['rev-parse', '--show-toplevel'],
}).pipe(Effect.map((s) => s.trim()))

const loadInventory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem

  const workspaceRoot = yield* Effect.option(detectWorkspaceRoot)
  if (Option.isNone(workspaceRoot)) {
    return Option.none<RunnerInventory>()
  }

  const inventoryPath = path.join(
    workspaceRoot.value,
    'nixpkgs/modules/runner-scaler-inventory.nix',
  )

  const exists = yield* fs.exists(inventoryPath)
  if (!exists) {
    return Option.none<RunnerInventory>()
  }

  const output = yield* Effect.option(
    commandString({
      command: 'nix',
      args: ['eval', '--json', '--file', inventoryPath, 'cli'],
    }).pipe(Effect.map((s) => s.trim())),
  )
  if (Option.isNone(output)) {
    return Option.none<RunnerInventory>()
  }

  const decoded = yield* Effect.option(
    Schema.decodeUnknownEffect(Schema.fromJsonString(RunnerInventory))(output.value),
  )
  if (Option.isNone(decoded)) {
    return Option.none<RunnerInventory>()
  }

  return Option.some(decoded.value)
})

/** Resolve config with repo auto-detection and inventory-backed defaults. */
export const resolveConfig = ({
  partial,
  options,
}: {
  partial?: { repos?: string[]; runnerHosts?: string[] }
  options?: { preferManagedRepos?: boolean }
} = {}) =>
  Effect.gen(function* () {
    const inventory = yield* loadInventory
    let repos = partial?.repos ?? []

    if (repos.length === 0) {
      const detected = yield* Effect.result(detectRepo)
      if (detected._tag === 'Success') {
        repos = [detected.success]
      } else if (options?.preferManagedRepos && Option.isSome(inventory)) {
        repos = [...inventory.value.managedRepos]
      }
    }

    return {
      repos,
      runnerHosts:
        partial?.runnerHosts ??
        (Option.isSome(inventory) ? [...inventory.value.allHosts] : DEFAULT_RUNNER_HOSTS),
    } satisfies CiUtilsConfig
  })
