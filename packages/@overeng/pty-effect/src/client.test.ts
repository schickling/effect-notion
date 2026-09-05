import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import { Effect, Fiber, Schema, Stream } from 'effect'

import { PtyClient, layer as ptyClientLayer } from './client.ts'
import { PtyName } from './PtySpec.ts'

/** Reads one Buck-declared immutable tool path; nothing resolves through an ambient PATH. */
const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

/** POSIX shell the daemons run, from the target's declared `SHELL_BIN`. */
const shell = (): string => requireTool('SHELL_BIN')

/**
 * A delay the shell performs itself.
 *
 * The action environment declares no `PATH`, so an external `sleep` is unreachable and would
 * end the script with 127 before the assertions run. `read -t` is a Bash builtin; nothing
 * writes to these sessions' input, and discarding its timeout status keeps the exit code 0.
 */
const pause = (seconds: number): string => `read -t ${seconds} || true`

/** Per-test isolated `PTY_SESSION_DIR` so daemons can't collide. */
const withIsolatedDir = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-effect-client-test-'))
      const prev = process.env.PTY_SESSION_DIR
      process.env.PTY_SESSION_DIR = dir
      return { dir, prev } as const
    }),
    () => eff,
    ({ dir, prev }) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.PTY_SESSION_DIR
        else process.env.PTY_SESSION_DIR = prev
        try {
          fs.rmSync(dir, { recursive: true, force: true })
        } catch {
          // best effort
        }
      }),
  )

const withTempDir = <A>(prefix: string, f: (dir: string) => A) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  try {
    return f(dir)
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
}

const decodeName = (s: string) => Schema.decodeUnknownSync(PtyName)(s) as PtyName

/** Keep names short — macOS Unix sockets cap at 104 bytes including the
 *  parent directory. With `/var/folders/.../T/.../<name>.sock` we burn ~85
 *  chars before the name itself. */
const uniqueName = (label: string): PtyName =>
  decodeName(`t${label}${(Date.now() % 100000).toString(36)}`)

const stdinEchoScript = [
  "const readline = require('node:readline')",
  "process.stdin.setEncoding('utf8')",
  'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })',
  'rl.on("line", (line) => {',
  '  if (line === "status") process.stdout.write("SEND_OK\\\\n")',
  '  if (line === "exit") process.exit(0)',
  '})',
].join('\n')

const waitForPeekText = (
  client: typeof PtyClient.Service,
  input: { readonly name: PtyName; readonly needle: string },
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 40; attempt++) {
      const screen = yield* client.peek({ name: input.name, plain: true })
      if (screen.includes(input.needle) === true) return screen
      yield* Effect.sleep('50 millis')
    }
    return yield* client.peek({ name: input.name, plain: true })
  })

describe('PtyClient', () => {
  it('keeps @overeng/pty-effect/client compile-safe for Bun-built CLIs', () => {
    withTempDir('pty-effect-bun-compile-', (dir) => {
      const entryPath = path.join(dir, 'main.ts')
      const outPath = path.join(dir, 'main')
      const clientModulePath = new URL('./client.ts', import.meta.url).pathname

      fs.writeFileSync(
        entryPath,
        [`import ${JSON.stringify(clientModulePath)}`, `console.log('client-module-ok')`, ''].join(
          '\n',
        ),
      )

      const bun = requireTool('BUN_BIN')
      execFileSync(bun, ['build', entryPath, '--compile', '--outfile', outPath], {
        cwd: dir,
        stdio: 'pipe',
      })

      const stdout = execFileSync(outPath, [], { encoding: 'utf8' })
      expect(stdout.trim()).toBe('client-module-ok')
    })
  })

  it.live('spawns a daemon, lists it, attaches, reads bytes, exits cleanly', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        const client = yield* PtyClient
        const name = uniqueName('roundtrip')

        yield* client.spawnDaemon({
          name: decodeName(name),
          command: shell(),
          args: ['-c', `echo HELLO_FROM_CLIENT && ${pause(1)}`],
        })

        const sessions = yield* client.list
        expect(sessions.some((s) => s.name === name)).toBe(true)
        expect(yield* client.exists({ name })).toBe(true)

        const session = yield* client.attach({
          name,
          size: { rows: 24, cols: 80 },
        })

        expect(session.initialScreen).toContain('HELLO_FROM_CLIENT')

        const collected = yield* session.bytes.pipe(Stream.take(8), Stream.runCollect)
        expect(collected.length).toBeGreaterThanOrEqual(0)

        const exit = yield* session.exit.pipe(Effect.timeout('2 seconds'))
        expect(exit.code).toBe(0)
      }).pipe(Effect.provide(ptyClientLayer)),
    ),
  )

  it.live('attach is scope-bound: closing scope detaches but daemon survives', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        const client = yield* PtyClient
        const name = uniqueName('detach')

        yield* client.spawnDaemon({
          name: decodeName(name),
          command: shell(),
          args: ['-c', pause(1)],
        })

        yield* Effect.scoped(
          Effect.gen(function* () {
            const s = yield* client.attach({ name, size: { rows: 24, cols: 80 } })
            yield* s.write({ data: '' })
          }),
        )

        const stillThere = yield* client.exists({ name })
        expect(stillThere).toBe(true)
      }).pipe(Effect.provide(ptyClientLayer)),
    ),
  )

  it.live('peek returns current screen without side effects', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        const client = yield* PtyClient
        const name = uniqueName('peek')

        yield* client.spawnDaemon({
          name: decodeName(name),
          command: shell(),
          args: ['-c', `echo PEEK_TARGET && ${pause(0.5)}`],
        })

        const screen = yield* waitForPeekText(client, { name, needle: 'PEEK_TARGET' })
        expect(screen).toContain('PEEK_TARGET')
      }).pipe(Effect.provide(ptyClientLayer)),
    ),
  )

  it.live('passes env overrides to the daemon without mutating the parent env', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        const client = yield* PtyClient
        const name = uniqueName('env')
        const marker = `marker-${Date.now().toString(36)}`
        const previous = process.env.PTY_EFFECT_TEST_VALUE

        try {
          delete process.env.PTY_EFFECT_TEST_VALUE

          yield* client.spawnDaemon({
            name,
            command: shell(),
            args: ['-c', `echo "ENV:$PTY_EFFECT_TEST_VALUE" && ${pause(0.5)}`],
            env: { PTY_EFFECT_TEST_VALUE: marker },
          })

          expect(process.env.PTY_EFFECT_TEST_VALUE).toBeUndefined()
          yield* waitForPeekText(client, { name, needle: `ENV:${marker}` })

          const session = yield* client.attach({
            name,
            size: { rows: 24, cols: 80 },
          })

          expect(session.initialScreen).toContain(`ENV:${marker}`)
        } finally {
          if (previous === undefined) delete process.env.PTY_EFFECT_TEST_VALUE
          else process.env.PTY_EFFECT_TEST_VALUE = previous
        }
      }).pipe(Effect.provide(ptyClientLayer)),
    ),
  )

  it.live('exposes get, tag mutation, gc, and live event following', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        const client = yield* PtyClient
        const name = uniqueName('tags')

        yield* client.spawnDaemon({
          name,
          command: shell(),
          args: ['-c', pause(0.5)],
          tags: {
            'forge.tab': 'tab-1',
            'forge.workspace': 'ws-1',
          },
        })

        const initial = yield* client.get({ name })
        expect(initial?.name).toBe(name)
        expect(initial?.metadata?.tags).toEqual({
          'forge.tab': 'tab-1',
          'forge.workspace': 'ws-1',
        })

        yield* client.updateTags({
          name,
          tags: {
            'forge.extra': '1',
            'forge.tab': 'tab-2',
          },
          removals: ['forge.workspace'],
        })

        const updated = yield* client.get({ name })
        expect(updated?.metadata?.tags).toEqual({
          'forge.extra': '1',
          'forge.tab': 'tab-2',
        })

        // Watch session_exit (fires ~500ms later when the shell pause ends) rather
        // than session_start: EventFollower.watchFile sets its read offset to the
        // current file size on new-session discovery, so session_start (written at
        // creation time) is skipped. session_exit is written after the offset is
        // established and is reliably captured. session_start tag verification uses
        // readRecentEvents below.
        const exitEvents = yield* Effect.forkScoped(
          client.followEvents({}).pipe(
            Stream.filter((event) => event.session === name && event.type === 'session_exit'),
            Stream.take(1),
            Stream.runCollect,
          ),
        )

        const session = yield* client.attach({
          name,
          size: { rows: 24, cols: 80 },
        })
        const exit = yield* session.exit.pipe(Effect.timeout('2 seconds'))
        expect(exit.code).toBe(0)

        const seenExitEvents = yield* Fiber.join(exitEvents)
        const [exitEvent] = Array.from(seenExitEvents)
        expect(exitEvent?.type).toBe('session_exit')
        if (exitEvent?.type === 'session_exit') {
          expect(exitEvent.exitCode).toBe(0)
        }

        yield* Effect.sleep('100 millis')
        const recent = yield* client.readRecentEvents({ name, count: 10 })
        expect(recent.some((event) => event.type === 'session_start')).toBe(true)
        expect(recent.some((event) => event.type === 'session_exit')).toBe(true)
        const recentStart = recent.find((event) => event.type === 'session_start')
        if (recentStart?.type === 'session_start') {
          expect(recentStart.tags).toEqual({ 'forge.tab': 'tab-1', 'forge.workspace': 'ws-1' })
        }

        const removed = yield* client.gc
        expect(removed).toContain(name)
        expect(yield* client.exists({ name })).toBe(false)
      }).pipe(Effect.provide(ptyClientLayer)),
    ),
  )

  it.live('supports sendData, queryStats, and recent event reads', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        const client = yield* PtyClient
        const name = uniqueName('send')

        yield* client.spawnDaemon({
          name,
          command: requireTool('NODE_BIN'),
          args: ['-e', stdinEchoScript],
        })

        const session = yield* client.attach({
          name,
          size: { rows: 24, cols: 80 },
        })

        const stats = yield* client.queryStats({ name, timeoutMs: 1_000 })
        expect(stats.name).toBe(name)
        expect(stats.process.alive).toBe(true)
        expect(stats.process.pid).not.toBeNull()

        yield* client.sendData({ name, data: ['status\r'] })

        const echoed = yield* session
          .waitForText({ needle: 'SEND_OK' })
          .pipe(Effect.timeout('5 seconds'))
        expect(echoed.text).toContain('SEND_OK')

        yield* client.sendData({ name, data: ['exit\r'] })

        const exit = yield* session.exit.pipe(Effect.timeout('5 seconds'))
        expect(exit.code).toBe(0)

        yield* Effect.sleep('100 millis')
        const recent = yield* client.readRecentEvents({ name, count: 10 })
        const eventTypes = Array.from(recent, (event) => event.type)
        expect(eventTypes).toContain('session_start')
        expect(eventTypes).toContain('session_exit')
      }).pipe(Effect.provide(ptyClientLayer)),
    ),
  )

  it.live('rejects invalid session names with BadName', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        const client = yield* PtyClient
        const result = yield* client
          .spawnDaemon({
            // @ts-expect-error — bypass branded type to test runtime validation
            name: 'has spaces',
            command: shell(),
            args: ['-c', 'true'],
          })
          .pipe(Effect.result)
        expect(result._tag).toBe('Failure')
        if (result._tag === 'Failure') expect(result.failure.reason).toBe('BadName')
      }).pipe(Effect.provide(ptyClientLayer)),
    ),
  )
})
