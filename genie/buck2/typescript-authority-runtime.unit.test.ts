import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  authoritativeBuck2TypeScriptAdmissions,
  buck2TypeScriptTestCollectionTargets,
  buck2TypeScriptTestTargets,
  type AuthoritativeBuck2TypeScriptAdmission,
} from './typescript-admissions.ts'
import {
  type CommandArgv,
  type CommandOutcome,
  type CommandRuntime,
  type DeclarationSourceResolver,
  executeCommandPlan,
  type ForwardedSignal,
  planBuck2TypeScriptBuild,
  planTypeScriptDistMaterialization,
} from './typescript-authority-runtime.ts'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))

const fixtureAdmissions = [
  {
    declarationEntrypoint: 'types/index.d.ts',
    distTarget: '//packages/@example/widget:dist',
    packagePath: 'packages/@example/widget',
    projectFile: 'tsconfig.buck.json',
    sourceRoots: ['src'],
    typecheckTarget: '//packages/@example/widget:typecheck',
  },
] as const satisfies readonly AuthoritativeBuck2TypeScriptAdmission[]

const fixtureDeclarationSources: DeclarationSourceResolver = ({ packagePath, sourceRoots }) => {
  expect(packagePath).toBe('packages/@example/widget')
  expect(sourceRoots).toEqual(['src'])
  return ['src/vendor.d.ts']
}

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
        declarationSources: fixtureDeclarationSources,
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
        'src/vendor.d.ts',
      ],
    ])

    // A package without handwritten declarations passes none: the materializer
    // must not receive a placeholder path it would then fail to copy.
    expect(
      planTypeScriptDistMaterialization({
        admissions: fixtureAdmissions,
        bashBin: '/nix/store/bash/bin/bash',
        declarationSources: () => [],
        root: '/repo',
      })[0]?.length,
    ).toBe(7)

    expect(
      planBuck2TypeScriptBuild({
        admissions: fixtureAdmissions,
        buck2Bin: '/workspace/.megarepo/bin/buck2',
        collectionTargets: ['effect_utils//packages/@example/widget:test_collect'],
        testTargets: ['effect_utils//packages/@example/widget:test'],
      }),
    ).toEqual([
      '/workspace/.megarepo/bin/buck2',
      'build',
      'effect_utils//packages/@example/widget:typecheck',
      'effect_utils//packages/@example/widget:test',
      'effect_utils//packages/@example/widget:test_collect',
      'effect_utils//buck2/toolchains:archive_tool',
      'effect_utils//buck2/toolchains:product_tool',
      '--local-only',
    ])

    // A package with no declared lane adds nothing: the gate must not invent a
    // target name for it, execution or inventory.
    expect(
      planBuck2TypeScriptBuild({
        admissions: fixtureAdmissions,
        buck2Bin: '/workspace/.megarepo/bin/buck2',
        collectionTargets: [],
        testTargets: [],
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
        declarationSources: ({ packagePath }) => [`${packagePath}/probe.d.ts`],
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
          `${packagePath}/probe.d.ts`,
        ],
      ),
    )

    expect(planBuck2TypeScriptBuild({ buck2Bin: '/workspace/.megarepo/bin/buck2' })).toEqual([
      '/workspace/.megarepo/bin/buck2',
      'build',
      ...authoritativeBuck2TypeScriptAdmissions.map(
        ({ typecheckTarget }) => `effect_utils${typecheckTarget}`,
      ),
      ...buck2TypeScriptTestTargets,
      ...buck2TypeScriptTestCollectionTargets,
      'effect_utils//buck2/toolchains:archive_tool',
      'effect_utils//buck2/toolchains:product_tool',
      '--local-only',
    ])

    // Every admitted package that has test files declares a lane, and every Vitest lane
    // contributes its inventory target, so the gate covers them all rather than a subset
    // that silently shrinks.
    expect(buck2TypeScriptTestTargets.length).toBeGreaterThanOrEqual(32)
    expect(buck2TypeScriptTestTargets.every((target) => target.startsWith('effect_utils//'))).toBe(
      true,
    )
    expect(buck2TypeScriptTestTargets.every((target) => target.endsWith(':test'))).toBe(true)
    expect(buck2TypeScriptTestCollectionTargets.length).toBe(buck2TypeScriptTestTargets.length)
    expect(
      buck2TypeScriptTestCollectionTargets.every((target) => target.endsWith(':test_collect')),
    ).toBe(true)
  })

  it('derives handwritten declaration arguments from the registry census by default', () => {
    const commands = planTypeScriptDistMaterialization({
      bashBin: '/nix/store/bash/bin/bash',
      root: repositoryRoot,
    })
    const declarationArguments = commands.map((command) => ({
      packagePath: command[3],
      sources: command.slice(7),
    }))

    // The materializer copies these paths out of the package tree, so every one
    // has to be a package-relative declaration that actually exists. Anything
    // else would fail the copy or, worse, read as staleness against the dist.
    for (const { packagePath, sources } of declarationArguments) {
      for (const source of sources) {
        expect(source.endsWith('.d.ts'), `${packagePath}: ${source}`).toBe(true)
        expect(path.isAbsolute(source)).toBe(false)
        expect(existsSync(path.join(repositoryRoot, packagePath ?? '', source))).toBe(true)
      }
    }

    // At least one admitted package publishes handwritten declarations; without
    // that the detached comparison would prove nothing about the copy path.
    expect(declarationArguments.some(({ sources }) => sources.length > 0)).toBe(true)
  })

  it('forwards task signals to the active child and propagates its signal outcome', async () => {
    const { emitSignal, runtime, signalListeners, spawnedCommands } = makeCommandRuntime()
    const execution = executeCommandPlan({
      commands: [['first'], ['second']],
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
      commands: [['first'], ['second'], ['unreached']],
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
