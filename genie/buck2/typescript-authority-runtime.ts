import { spawn } from 'node:child_process'
import process from 'node:process'

import {
  authoritativeBuck2TypeScriptDeclarations,
  authoritativeBuck2TypeScriptProjects,
  buck2TypeScriptTestCollectionTargets,
  buck2TypeScriptTestTargets,
  type AuthoritativeBuck2TypeScriptDeclaration,
  type AuthoritativeBuck2TypeScriptProject,
} from './typescript-admissions.ts'

/** Executable followed by its exact ordered argument vector. */
export type CommandArgv = [executable: string, ...args: string[]]

/** Termination signals forwarded by the task wrapper to its active child. */
export type ForwardedSignal = 'SIGINT' | 'SIGTERM'

/** Observable command completion propagated to the task process. */
export type CommandOutcome =
  | { readonly _tag: 'Status'; readonly status: number }
  | { readonly _tag: 'Signal'; readonly signal: NodeJS.Signals }

/** Active child boundary used by the sequential command executor. */
export type RunningCommand = {
  readonly completion: Promise<CommandOutcome>
  readonly forwardSignal: (signal: ForwardedSignal) => void
}

/** Injectable process and signal boundary for command execution tests. */
export type CommandRuntime = {
  readonly spawn: (command: CommandArgv) => RunningCommand
  readonly addSignalListener: (options: {
    readonly signal: ForwardedSignal
    readonly listener: () => void
  }) => void
  readonly removeSignalListener: (options: {
    readonly signal: ForwardedSignal
    readonly listener: () => void
  }) => void
}

/** Plans one declaration publisher invocation for every emitting authoritative project. */
export const planTypeScriptDistMaterialization = ({
  admissions = authoritativeBuck2TypeScriptDeclarations,
  bashBin,
  root,
}: {
  readonly admissions?: readonly AuthoritativeBuck2TypeScriptDeclaration[]
  readonly bashBin: string
  readonly root: string
}): readonly CommandArgv[] =>
  admissions.map(
    ({ declarationEntrypoint, distTarget, packagePath }): CommandArgv => [
      bashBin,
      `${root}/scripts/typescript-materialize-dist.sh`,
      root,
      packagePath,
      qualifyEffectUtilsLabel(distTarget),
      declarationEntrypoint,
    ],
  )

/**
 * Plans the single Buck build used by buck2:check, preserving target order.
 *
 * Every declared lane contributes both its execution target and its inventory target. The
 * inventory is what the source-side bounded task reads, so an inventory that stops
 * analysing has to fail the check rather than quietly fall back to a source-side census.
 */
export const planBuck2TypeScriptBuild = ({
  admissions = authoritativeBuck2TypeScriptProjects,
  buck2Bin,
  collectionTargets = buck2TypeScriptTestCollectionTargets,
  testTargets = buck2TypeScriptTestTargets,
}: {
  readonly admissions?: readonly AuthoritativeBuck2TypeScriptProject[]
  readonly buck2Bin: string
  /** Fully qualified inventory labels. */
  readonly collectionTargets?: readonly string[]
  /** Fully qualified execution labels. */
  readonly testTargets?: readonly string[]
}): CommandArgv => [
  buck2Bin,
  'build',
  ...admissions.map(({ typecheckTarget }) => qualifyEffectUtilsLabel(typecheckTarget)),
  ...testTargets,
  ...collectionTargets,
  'effect_utils//buck2/toolchains:archive_tool',
  'effect_utils//buck2/toolchains:product_tool',
  '--local-only',
]

/** Runs commands sequentially and forwards task termination signals to the active child. */
export const executeCommandPlan = async ({
  commands,
  runtime = nodeCommandRuntime,
}: {
  readonly commands: readonly CommandArgv[]
  readonly runtime?: CommandRuntime
}): Promise<CommandOutcome> => {
  for (const command of commands) {
    let runningCommand: RunningCommand | undefined
    const forwardSigint = (): void => runningCommand?.forwardSignal('SIGINT')
    const forwardSigterm = (): void => runningCommand?.forwardSignal('SIGTERM')
    runtime.addSignalListener({ signal: 'SIGINT', listener: forwardSigint })
    runtime.addSignalListener({ signal: 'SIGTERM', listener: forwardSigterm })
    try {
      runningCommand = runtime.spawn(command)
      const outcome = await runningCommand.completion
      if (outcome._tag === 'Signal' || outcome.status !== 0) return outcome
    } finally {
      runtime.removeSignalListener({ signal: 'SIGINT', listener: forwardSigint })
      runtime.removeSignalListener({ signal: 'SIGTERM', listener: forwardSigterm })
    }
  }
  return { _tag: 'Status', status: 0 }
}

const qualifyEffectUtilsLabel = (label: `//${string}`): string => `effect_utils${label}`

const nodeCommandRuntime: CommandRuntime = {
  spawn: ([executable, ...args]) => {
    const child = spawn(executable, args, { stdio: 'inherit' })
    const completion = new Promise<CommandOutcome>((resolve) => {
      child.once('error', (error) => {
        console.error(error.message)
        resolve({ _tag: 'Status', status: 1 })
      })
      child.once('close', (status, signal) => {
        resolve(
          signal === null ? { _tag: 'Status', status: status ?? 1 } : { _tag: 'Signal', signal },
        )
      })
    })
    return {
      completion,
      forwardSignal: (signal) => {
        child.kill(signal)
      },
    }
  },
  addSignalListener: ({ signal, listener }) => process.on(signal, listener),
  removeSignalListener: ({ signal, listener }) => process.off(signal, listener),
}

const main = async (): Promise<CommandOutcome> => {
  const [operation, firstArgument, secondArgument, ...unexpectedArguments] = process.argv.slice(2)
  if (
    operation === 'materialize-dist' &&
    firstArgument !== undefined &&
    secondArgument !== undefined &&
    unexpectedArguments.length === 0
  ) {
    return executeCommandPlan({
      commands: planTypeScriptDistMaterialization({
        root: firstArgument,
        bashBin: secondArgument,
      }),
    })
  }
  if (
    operation === 'build' &&
    firstArgument !== undefined &&
    secondArgument === undefined &&
    unexpectedArguments.length === 0
  ) {
    return executeCommandPlan({
      commands: [planBuck2TypeScriptBuild({ buck2Bin: firstArgument })],
    })
  }
  console.error(
    'usage: typescript-authority-runtime.ts materialize-dist <repo-root> <bash-bin> | build <buck2-bin>',
  )
  return { _tag: 'Status', status: 2 }
}

if (import.meta.main === true) {
  const outcome = await main()
  if (outcome._tag === 'Signal') {
    process.exitCode = 1
    process.kill(process.pid, outcome.signal)
  } else {
    process.exit(outcome.status)
  }
}
