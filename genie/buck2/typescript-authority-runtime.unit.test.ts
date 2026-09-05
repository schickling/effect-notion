import { describe, expect, it } from 'vitest'

import {
  authoritativeBuck2TypeScriptAdmissions,
  buck2TypeScriptAuthorityProjects,
  type AuthoritativeBuck2TypeScriptAdmission,
} from './typescript-admissions.ts'
import {
  type CommandArgv,
  type CommandOutcome,
  type CommandRuntime,
  executeCommandPlan,
  type ForwardedSignal,
  planBuck2TypeScriptBuild,
  planTypeScriptDistMaterialization,
} from './typescript-authority-runtime.ts'

const fixtureAdmissions = [
  {
    declarationEntrypoint: 'types/index.d.ts',
    distTarget: '//packages/@example/widget:dist',
    packagePath: 'packages/@example/widget',
    projectFile: 'tsconfig.buck.json',
    typecheckTarget: '//packages/@example/widget:typecheck',
  },
] as const satisfies readonly AuthoritativeBuck2TypeScriptAdmission[]

type SpawnedCommand = {
  readonly command: CommandArgv
  readonly forwardedSignals: ForwardedSignal[]
  readonly resolve: (outcome: CommandOutcome) => void
}

const makeCommandRuntime = () => {
  const spawnedCommands: SpawnedCommand[] = []
  const signalListeners: Record<ForwardedSignal, Set<() => void>> = {
    SIGINT: new Set(),
    SIGTERM: new Set(),
  }
  const runtime: CommandRuntime = {
    spawn: (command) => {
      let resolveCompletion: (outcome: CommandOutcome) => void = () => undefined
      const completion = new Promise<CommandOutcome>((resolve) => {
        resolveCompletion = resolve
      })
      const forwardedSignals: ForwardedSignal[] = []
      spawnedCommands.push({
        command,
        forwardedSignals,
        resolve: resolveCompletion,
      })
      return {
        completion,
        forwardSignal: (signal) => {
          forwardedSignals.push(signal)
        },
      }
    },
    addSignalListener: ({ signal, listener }) => {
      signalListeners[signal].add(listener)
    },
    removeSignalListener: ({ signal, listener }) => {
      signalListeners[signal].delete(listener)
    },
  }
  return {
    emitSignal: (signal: ForwardedSignal) => {
      for (const listener of signalListeners[signal]) listener()
    },
    runtime,
    signalListeners,
    spawnedCommands,
  }
}

describe('Buck2 TypeScript authority runtime planning', () => {
  it('plans exact commands from an injected admission', () => {
    expect(
      planTypeScriptDistMaterialization({
        admissions: fixtureAdmissions,
        bashBin: '/nix/store/bash/bin/bash',
        root: '/repo',
      }),
    ).toEqual([
      [
        '/nix/store/bash/bin/bash',
        '/repo/scripts/typescript-materialize-dist.sh',
        '/repo',
        'packages/@example/widget',
        'effect_utils//packages/@example/widget:dist',
        'types/index.d.ts',
        'tsconfig.buck.json',
      ],
    ])

    expect(
      planBuck2TypeScriptBuild({
        admissions: fixtureAdmissions,
        buck2Bin: '/workspace/.megarepo/bin/buck2',
      }),
    ).toEqual([
      '/workspace/.megarepo/bin/buck2',
      'build',
      'effect_utils//packages/@example/widget:typecheck',
      'effect_utils//buck2/toolchains:archive_tool',
      'effect_utils//buck2/toolchains:product_tool',
      '--local-only',
    ])
  })

  it('preserves command coverage and ordering for the live registry', () => {
    expect(
      planTypeScriptDistMaterialization({
        bashBin: '/nix/store/bash/bin/bash',
        root: '/repo',
      }),
    ).toEqual(
      authoritativeBuck2TypeScriptAdmissions.map(
        ({ declarationEntrypoint, distTarget, packagePath, projectFile }) => [
          '/nix/store/bash/bin/bash',
          '/repo/scripts/typescript-materialize-dist.sh',
          '/repo',
          packagePath,
          `effect_utils${distTarget}`,
          declarationEntrypoint,
          projectFile,
        ],
      ),
    )

    expect(planBuck2TypeScriptBuild({ buck2Bin: '/workspace/.megarepo/bin/buck2' })).toEqual([
      '/workspace/.megarepo/bin/buck2',
      'build',
      ...buck2TypeScriptAuthorityProjects.map(
        ({ typecheckTarget }) => `effect_utils${typecheckTarget}`,
      ),
      'effect_utils//buck2/toolchains:archive_tool',
      'effect_utils//buck2/toolchains:product_tool',
      '--local-only',
    ])

    expect(planBuck2TypeScriptBuild({ buck2Bin: '/workspace/.megarepo/bin/buck2' })).toContain(
      'effect_utils//packages/@overeng/react-inspector:typecheck_strict_consumer',
    )
  })

  it('forwards task signals to the active child and propagates its signal outcome', async () => {
    const { emitSignal, runtime, signalListeners, spawnedCommands } = makeCommandRuntime()
    const execution = executeCommandPlan({
      commands: [
        ['first'],
        ['second'],
      ],
      runtime,
    })

    expect(spawnedCommands.map(({ command }) => command)).toEqual([['first']])
    emitSignal('SIGTERM')
    expect(spawnedCommands[0]?.forwardedSignals).toEqual(['SIGTERM'])
    spawnedCommands[0]?.resolve({ _tag: 'Signal', signal: 'SIGTERM' })

    await expect(execution).resolves.toEqual({ _tag: 'Signal', signal: 'SIGTERM' })
    expect(spawnedCommands).toHaveLength(1)
    expect(signalListeners.SIGINT.size).toBe(0)
    expect(signalListeners.SIGTERM.size).toBe(0)
  })

  it('keeps commands sequential and propagates the first non-zero status', async () => {
    const { runtime, spawnedCommands } = makeCommandRuntime()
    const execution = executeCommandPlan({
      commands: [
        ['first'],
        ['second'],
        ['unreached'],
      ],
      runtime,
    })

    expect(spawnedCommands.map(({ command }) => command)).toEqual([['first']])
    spawnedCommands[0]?.resolve({ _tag: 'Status', status: 0 })
    await Promise.resolve()
    expect(spawnedCommands.map(({ command }) => command)).toEqual([['first'], ['second']])
    spawnedCommands[1]?.resolve({ _tag: 'Status', status: 17 })

    await expect(execution).resolves.toEqual({ _tag: 'Status', status: 17 })
    expect(spawnedCommands.map(({ command }) => command)).toEqual([['first'], ['second']])
  })
})
