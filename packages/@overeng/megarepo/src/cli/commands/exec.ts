/**
 * Exec Command
 *
 * Execute a command in member directories.
 */

import { Effect, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Cli from 'effect/unstable/cli'
import * as Command from 'effect/unstable/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'
import React from 'react'

import { run } from '@overeng/tui-react'

import { getMemberPath, readMegarepoConfig } from '../../core/config.ts'
import { Cwd, findMegarepoRoot, outputOption, outputModeLayer, verboseOption } from '../context.ts'
import * as Observability from '../observability.ts'
import { ExecApp, ExecView } from '../renderers/ExecOutput/mod.ts'

/** Execution mode for running commands across members */
type ExecMode = 'parallel' | 'sequential'

/** Execute command across members */
export const execCommand = Cli.Command.make(
  'exec',
  {
    command: Cli.Argument.string('command').pipe(
      Cli.Argument.withDescription('Command to execute'),
    ),
    output: outputOption,
    member: Cli.Flag.string('member').pipe(
      Cli.Flag.withAlias('m'),
      Cli.Flag.withDescription('Run only in this member'),
      Cli.Flag.optional,
    ),
    mode: Cli.Flag.choice('mode', ['parallel', 'sequential'] as const).pipe(
      Cli.Flag.withDescription('Execution mode: parallel (default) or sequential'),
      Cli.Flag.withDefault('parallel' as ExecMode),
    ),
    verbose: verboseOption,
  },
  ({ command: cmd, output, member, mode, verbose }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const root = yield* findMegarepoRoot(cwd)

      yield* run(
        ExecApp,
        (tui) =>
          Effect.gen(function* () {
            if (Option.isNone(root) === true) {
              tui.dispatch({
                _tag: 'SetError',
                error: 'not_found',
                message: 'No megarepo.json found',
              })
              return
            }

            // Load config
            const fs = yield* FileSystem.FileSystem
            const { config } = yield* readMegarepoConfig(root.value)

            // Filter members
            const membersToRun = Option.match(member, {
              onNone: () => Object.keys(config.members),
              onSome: (m) => (m in config.members ? [m] : []),
            })

            if (membersToRun.length === 0) {
              tui.dispatch({
                _tag: 'SetError',
                error: 'not_found',
                message: 'Member not found',
              })
              return
            }

            // Start exec with members
            tui.dispatch({
              _tag: 'Start',
              command: cmd,
              mode,
              verbose,
              members: membersToRun,
            })

            /** Run command in a single member */
            const runInMember = (name: string) =>
              Effect.gen(function* () {
                const memberPath = getMemberPath({ megarepoRoot: root.value, name })
                const exists = yield* fs.exists(memberPath)

                if (exists === false) {
                  tui.dispatch({
                    _tag: 'UpdateMember',
                    name,
                    status: 'skipped',
                    stderr: 'Member not synced',
                  })
                  return
                }

                // Mark as running
                tui.dispatch({
                  _tag: 'UpdateMember',
                  name,
                  status: 'running',
                })

                // Run the command
                yield* Effect.gen(function* () {
                  const commandOutput = yield* ChildProcessSpawner.use((spawner) =>
                    spawner.string(Command.make('sh', ['-c', cmd], { cwd: memberPath })),
                  )
                  tui.dispatch({
                    _tag: 'UpdateMember',
                    name,
                    status: 'success',
                    exitCode: 0,
                    stdout: commandOutput,
                  })
                }).pipe(
                  Effect.catch((error) =>
                    Effect.sync(() => {
                      tui.dispatch({
                        _tag: 'UpdateMember',
                        name,
                        status: 'error',
                        exitCode: 1,
                        stderr: error instanceof Error ? error.message : String(error),
                      })
                    }),
                  ),
                )
              })

            if (mode === 'parallel') {
              // Run all commands in parallel
              yield* Effect.forEach(membersToRun, (name) => runInMember(name), {
                concurrency: 'unbounded',
              })
            } else {
              // Run commands sequentially
              for (const name of membersToRun) {
                yield* runInMember(name)
              }
            }

            // Mark exec as complete
            tui.dispatch({ _tag: 'Complete' })
          }),
        { view: React.createElement(ExecView, { stateAtom: ExecApp.stateAtom }) },
      ).pipe(Effect.provide(outputModeLayer(output)))
    }).pipe(
      Observability.withCommandSpan({
        name: 'megarepo/exec',
        command: 'exec',
        label: Option.getOrElse(member, () => 'exec'),
        output,
        ...(Option.isSome(member) === true ? { member: member.value } : {}),
      }),
    ),
).pipe(Cli.Command.withDescription('Execute a command in member directories'))
