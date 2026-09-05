import fs from 'node:fs'
import path from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { ChildProcessSpawner } from 'effect/unstable/process'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { cmd, cmdCollect } from './cmd.ts'
import { CurrentWorkingDirectory } from './workspace.ts'

const TestLayer = Layer.mergeAll(NodeServices.layer, CurrentWorkingDirectory.live)

/** Reads one Buck-declared immutable tool path; nothing resolves through an ambient PATH. */
const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

const bunBin = requireTool('BUN_BIN')
const echoBin = requireTool('ECHO_BIN')
const printfBin = requireTool('PRINTF_BIN')

Vitest.describe('cmd helper', () => {
  const ansiRegex = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

  Vitest.it.effect(
    'runs tokenized string without shell',
    Effect.fnUntraced(
      function* () {
        const exit = yield* cmd(`${printfBin} ok`)
        expect(exit).toBe(ChildProcessSpawner.ExitCode(0))
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )

  Vitest.it.effect(
    'runs array input',
    Effect.fnUntraced(
      function* () {
        const exit = yield* cmd([printfBin, 'ok'])
        expect(exit).toBe(ChildProcessSpawner.ExitCode(0))
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )

  Vitest.it.effect(
    'supports logging with archive + retention',
    Effect.fnUntraced(
      function* () {
        const workspaceRoot = path.resolve(import.meta.dirname, '../../../..')
        const logsDir = path.join(workspaceRoot, 'tmp', 'cmd-tests', String(Date.now()))

        // first run
        const exit1 = yield* cmd(`${printfBin} first`, { logDir: logsDir })
        expect(exit1).toBe(ChildProcessSpawner.ExitCode(0))
        const current = path.join(logsDir, 'dev.log')
        expect(fs.existsSync(current)).toBe(true)
        const firstLog = fs.readFileSync(current, 'utf8')
        const firstStdoutLines = firstLog.split('\n').filter((line) => line.includes('[stdout]'))
        expect(firstStdoutLines.length).toBeGreaterThan(0)
        for (const line of firstStdoutLines) {
          expect(line).toContain('[stdout] first')
          expect(line).toContain('Info')
          expect(line).toContain(`${printfBin} first`)
        }

        // second run — archives previous
        const exit2 = yield* cmd(`${printfBin} second`, { logDir: logsDir })
        expect(exit2).toBe(ChildProcessSpawner.ExitCode(0))
        const archiveDir = path.join(logsDir, 'archive')
        const archives = fs.readdirSync(archiveDir).filter((file) => file.endsWith('.log'))
        expect(archives.length).toBe(1)
        const archivedName = archives[0]
        if (archivedName === undefined) throw new Error('Expected archive file')
        const archivedPath = path.join(archiveDir, archivedName)
        const archivedLog = fs.readFileSync(archivedPath, 'utf8')
        const archivedStdoutLines = archivedLog
          .split('\n')
          .filter((line) => line.includes('[stdout]'))
        expect(archivedStdoutLines.length).toBeGreaterThan(0)
        for (const line of archivedStdoutLines) {
          expect(line).toContain('[stdout] first')
        }

        const secondLog = fs.readFileSync(current, 'utf8')
        const secondStdoutLines = secondLog.split('\n').filter((line) => line.includes('[stdout]'))
        expect(secondStdoutLines.length).toBeGreaterThan(0)
        for (const line of secondStdoutLines) {
          expect(line).toContain('[stdout] second')
          expect(line).toContain('Info')
        }

        // generate many archives to exercise retention (keep 50)
        for (let i = 0; i < 60; i++) {
          // Use small unique payloads
          yield* cmd([printfBin, String(i)], { logDir: logsDir })
        }
        const archivesAfter = fs.readdirSync(archiveDir).filter((file) => file.endsWith('.log'))
        expect(archivesAfter.length).toBeLessThanOrEqual(50)
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
    { timeout: 30_000 },
  )

  Vitest.it.effect(
    'streams stdout and stderr with logger formatting',
    Effect.fnUntraced(
      function* () {
        const workspaceRoot = path.resolve(import.meta.dirname, '../../../..')
        const logsDir = path.join(workspaceRoot, 'tmp', 'cmd-tests', `format-${Date.now()}`)

        const exit = yield* cmd([bunBin, '-e', "console.log('out'); console.error('err')"], {
          logDir: logsDir,
        })
        expect(exit).toBe(ChildProcessSpawner.ExitCode(0))

        const current = path.join(logsDir, 'dev.log')
        const logContent = fs.readFileSync(current, 'utf8')
        const strippedContent = logContent.replace(ansiRegex, '')
        expect(strippedContent).toMatch(/\[stdout] out/)
        expect(strippedContent).toMatch(/\[stderr] err/)

        const relevantLines = logContent
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.includes('[stdout]') || line.includes('[stderr]'))

        expect(relevantLines.length).toBeGreaterThanOrEqual(2)

        for (const line of relevantLines) {
          const stripped = line.replace(ansiRegex, '')
          expect(stripped).toMatch(/(Info|Warn)/)
          expect(stripped).toMatch(/\[(stdout|stderr)]/)
        }
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )

  // TODO: Test timeouts with streaming processes - Effect.timeout doesn't interrupt stream-based I/O properly
  // when combined with scoped resources. This needs deeper investigation or a different approach.
  // For now, the core cleanup functionality is covered by acquireRelease in the cmd implementation.
})

Vitest.describe('cmdCollect', () => {
  Vitest.it.effect(
    'collects stdout lines',
    Effect.fnUntraced(
      function* () {
        const result = yield* cmdCollect({ commandInput: [echoBin, 'hello'] })
        expect(result.stdout).toEqual(['hello'])
        expect(result.exitCode).toBe(0)
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )

  Vitest.it.effect(
    'collects stderr lines',
    Effect.fnUntraced(
      function* () {
        const result = yield* cmdCollect({ commandInput: [bunBin, '-e', "console.error('oops')"] })
        expect(result.stderr).toEqual(['oops'])
        expect(result.exitCode).toBe(0)
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )

  Vitest.it.effect(
    'invokes onOutput callback for each line',
    Effect.fnUntraced(
      function* () {
        const lines: Array<{ stream: string; line: string }> = []
        const result = yield* cmdCollect({
          commandInput: [
            bunBin,
            '-e',
            "console.log('out1'); console.log('out2'); console.error('err1')",
          ],
          onOutput: (stream, line) =>
            Effect.sync(() => {
              lines.push({ stream, line })
            }),
        })
        expect(result.stdout).toEqual(['out1', 'out2'])
        expect(result.stderr).toEqual(['err1'])
        expect(result.exitCode).toBe(0)
        expect(lines).toContainEqual({ stream: 'stdout', line: 'out1' })
        expect(lines).toContainEqual({ stream: 'stdout', line: 'out2' })
        expect(lines).toContainEqual({ stream: 'stderr', line: 'err1' })
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )

  Vitest.it.effect(
    'returns non-zero exit code without failing',
    Effect.fnUntraced(
      function* () {
        const result = yield* cmdCollect({ commandInput: [bunBin, '-e', 'process.exit(42)'] })
        expect(result.exitCode).toBe(42)
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )
})
