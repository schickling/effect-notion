import { Console, Effect } from 'effect'
import { CliError, CliOutput } from 'effect/unstable/cli'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import {
  argvRequestsJsonStdout,
  CliVersion,
  jsonStdoutGuardLayer,
  parseCliBuildStamp,
  resolveCliBuildIdentity,
  resolveCliMachineVersion,
  resolveCliVersion,
} from './cli-version.ts'

const placeholder = '__CLI_BUILD_STAMP__'
const now = 1_740_000_000
const fiveMinutesAgo = now - 5 * 60
const threeDaysAgo = now - 3 * 86_400
const dash = '\u2014'

const localStamp = JSON.stringify({
  type: 'local',
  rev: 'abc123',
  ts: fiveMinutesAgo,
  dirty: true,
})

const nixStamp = JSON.stringify({
  type: 'nix',
  version: '0.1.0',
  rev: 'def456',
  commitTs: threeDaysAgo,
  dirty: false,
})

Vitest.describe('parseCliBuildStamp', () => {
  Vitest.it('parses local stamps without preserving extra fields', () => {
    expect(
      parseCliBuildStamp(
        JSON.stringify({
          type: 'local',
          rev: 'abc123',
          ts: fiveMinutesAgo,
          dirty: false,
          extra: 'ignored',
        }),
      ),
    ).toEqual({
      type: 'local',
      rev: 'abc123',
      ts: fiveMinutesAgo,
      dirty: false,
    })
  })

  Vitest.it('parses nix stamps with optional buildTs', () => {
    expect(
      parseCliBuildStamp(
        JSON.stringify({
          type: 'nix',
          version: '0.1.0',
          rev: 'def456',
          commitTs: threeDaysAgo,
          buildTs: fiveMinutesAgo,
          dirty: false,
        }),
      ),
    ).toEqual({
      type: 'nix',
      version: '0.1.0',
      rev: 'def456',
      commitTs: threeDaysAgo,
      buildTs: fiveMinutesAgo,
      dirty: false,
    })
  })

  Vitest.it('ignores malformed stamps', () => {
    expect(parseCliBuildStamp('not-json')).toBeUndefined()
    expect(parseCliBuildStamp(JSON.stringify({ type: 'local', rev: 'abc123' }))).toBeUndefined()
  })
})

Vitest.describe('resolveCliBuildIdentity', () => {
  Vitest.it('falls back to package identity without build or runtime stamps', () => {
    expect(
      resolveCliBuildIdentity({ baseVersion: '0.1.0', buildStamp: placeholder, env: {}, now }),
    ).toEqual({
      baseVersion: '0.1.0',
      displayVersion: '0.1.0',
      machineVersion: '0.1.0',
      sourceKind: 'package',
      dirty: false,
    })
  })

  Vitest.it('resolves local runtime identity from CLI_BUILD_STAMP', () => {
    expect(
      resolveCliBuildIdentity({
        baseVersion: '0.1.0',
        buildStamp: placeholder,
        env: { CLI_BUILD_STAMP: localStamp },
        now,
      }),
    ).toEqual({
      baseVersion: '0.1.0',
      displayVersion: `0.1.0 ${dash} running from local source (abc123, 5 min ago, with uncommitted changes)`,
      machineVersion: '0.1.0+local.abc123.dirty',
      sourceKind: 'local',
      rev: 'abc123',
      dirty: true,
      buildTs: fiveMinutesAgo,
    })
  })

  Vitest.it('resolves nix runtime identity from CLI_BUILD_STAMP', () => {
    expect(
      resolveCliBuildIdentity({
        baseVersion: '0.1.0',
        buildStamp: placeholder,
        env: { CLI_BUILD_STAMP: nixStamp },
        now,
      }),
    ).toEqual({
      baseVersion: '0.1.0',
      displayVersion: `0.1.0+def456 ${dash} committed 3 days ago`,
      machineVersion: '0.1.0+def456',
      sourceKind: 'nix',
      rev: 'def456',
      dirty: false,
      commitTs: threeDaysAgo,
    })
  })

  Vitest.it('resolves nix identity from embedded stamps and ignores runtime env', () => {
    expect(
      resolveCliBuildIdentity({
        baseVersion: '0.1.0',
        buildStamp: nixStamp,
        env: { CLI_BUILD_STAMP: localStamp },
        now,
      }),
    ).toEqual({
      baseVersion: '0.1.0',
      displayVersion: `0.1.0+def456 ${dash} committed 3 days ago`,
      machineVersion: '0.1.0+def456',
      sourceKind: 'nix',
      rev: 'def456',
      dirty: false,
      commitTs: threeDaysAgo,
    })
  })

  Vitest.it('does not duplicate the dirty suffix for dirty nix revs', () => {
    const dirtyStamp = JSON.stringify({
      type: 'nix',
      version: '0.1.0',
      rev: 'def456-dirty',
      commitTs: threeDaysAgo,
      dirty: true,
    })

    expect(
      resolveCliBuildIdentity({ baseVersion: '0.1.0', buildStamp: dirtyStamp, env: {}, now }),
    ).toMatchObject({
      displayVersion: `0.1.0+def456-dirty ${dash} committed 3 days ago, with uncommitted changes`,
      machineVersion: '0.1.0+def456-dirty',
    })
  })

  Vitest.it('renders impure nix builds from buildTs while keeping machineVersion stable', () => {
    const impureStamp = JSON.stringify({
      type: 'nix',
      version: '0.1.0',
      rev: 'def456',
      commitTs: threeDaysAgo,
      buildTs: fiveMinutesAgo,
      dirty: false,
    })

    expect(
      resolveCliBuildIdentity({ baseVersion: '0.1.0', buildStamp: impureStamp, env: {}, now }),
    ).toMatchObject({
      displayVersion: `0.1.0+def456 ${dash} built 5 min ago`,
      machineVersion: '0.1.0+def456',
      buildTs: fiveMinutesAgo,
    })
  })

  Vitest.it('keeps the existing display-only API source-compatible', () => {
    expect(
      resolveCliVersion({
        baseVersion: '0.1.0',
        buildStamp: placeholder,
        runtimeStampEnvVar: 'CUSTOM_BUILD_STAMP',
      }),
    ).toBe('0.1.0')
  })

  Vitest.it('exposes a machine-version convenience wrapper', () => {
    expect(
      resolveCliMachineVersion({
        baseVersion: '0.1.0',
        buildStamp: nixStamp,
        env: { CLI_BUILD_STAMP: localStamp },
        now,
      }),
    ).toBe('0.1.0+def456')
  })
})

Vitest.describe('argvRequestsJsonStdout', () => {
  Vitest.it('matches explicit json/ndjson output requests', () => {
    expect(argvRequestsJsonStdout(['--output', 'json'])).toBe(true)
    expect(argvRequestsJsonStdout(['--output=ndjson'])).toBe(true)
    expect(argvRequestsJsonStdout(['-o', 'json'])).toBe(true)
    expect(argvRequestsJsonStdout(['-o=ndjson'])).toBe(true)
    expect(argvRequestsJsonStdout(['md', 'status', '--json', 'page.nmd'])).toBe(true)
    expect(argvRequestsJsonStdout(['schema', 'generate', '--output-mode', 'json'])).toBe(true)
    expect(argvRequestsJsonStdout(['schema', 'generate', '--output-mode=ndjson'])).toBe(true)
  })

  Vitest.it('leaves human invocations unguarded', () => {
    expect(argvRequestsJsonStdout([])).toBe(false)
    expect(argvRequestsJsonStdout(['--output', 'auto'])).toBe(false)
    expect(argvRequestsJsonStdout(['schema', 'generate', '--output-mode', 'text'])).toBe(false)
    expect(argvRequestsJsonStdout(['schema', 'generate', '--output', 'schema.json'])).toBe(false)
    expect(argvRequestsJsonStdout(['env', '--output', 'tty'])).toBe(false)
    expect(argvRequestsJsonStdout(['--output'])).toBe(false)
    expect(argvRequestsJsonStdout(['--jsonify'])).toBe(false)
  })
})

Vitest.describe('CliVersion.formatterLayer', () => {
  Vitest.it(
    'stamps rendered errors with the CLI version and keeps upstream version bytes',
    async () => {
      process.env.NO_COLOR = '1'
      const rendered = await Effect.runPromise(
        Effect.gen(function* () {
          const formatter = yield* CliOutput.Formatter
          return {
            error: formatter.formatError(new CliError.UserError({ cause: 'boom' })),
            errors: formatter.formatErrors([new CliError.UserError({ cause: 'nope' })]),
            version: formatter.formatVersion('mr', '0.1.0'),
          }
        }).pipe(
          Effect.provide(CliVersion.formatterLayer),
          Effect.provideService(CliVersion, { name: 'mr', version: '0.1.0' }),
        ),
      )
      expect(rendered.error).toBe('\nERROR\n  boom (mr 0.1.0)')
      expect(rendered.errors).toBe('\nERROR\n  nope (mr 0.1.0)')
      expect(rendered.version).toBe('mr v0.1.0')
    },
  )
})

Vitest.describe('jsonStdoutGuardLayer', () => {
  Vitest.it('binds the parse-phase Console to stderr for JSON invocations only', async () => {
    const stderrWrites: Array<string> = []
    const originalStderrWrite = process.stderr.write
    const capture =
      (sink: Array<string>) =>
      (chunk: Uint8Array | string): boolean => {
        sink.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
        return true
      }
    process.stderr.write = capture(stderrWrites) as typeof process.stderr.write
    const logViaConsole = Effect.flatMap(Console.Console, (console) =>
      Effect.sync(() => console.log('x')),
    )
    try {
      await Effect.runPromise(
        logViaConsole.pipe(Effect.provide(jsonStdoutGuardLayer(['--output', 'json']))),
      )
      expect(stderrWrites).toEqual(['x\n'])

      // Guard inert: the ambient console stays bound, so nothing new reaches stderr.
      await Effect.runPromise(
        logViaConsole.pipe(Effect.provide(jsonStdoutGuardLayer(['--output', 'tty']))),
      )
      expect(stderrWrites).toEqual(['x\n'])
    } finally {
      process.stderr.write = originalStderrWrite
    }
  })
})
