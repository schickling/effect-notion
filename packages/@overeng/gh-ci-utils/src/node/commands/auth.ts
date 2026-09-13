import { Console, Effect, Option, Schema, Stream } from 'effect'
/**
 * gh-ci-utils auth
 *
 * Session management for internal GitHub API access.
 * Opens a Playwright browser for GitHub login, extracts the `user_session` cookie.
 */
import * as Cli from 'effect/unstable/cli'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'

import {
  type OutputModeValue,
  outputModeLayer,
  outputOption,
  resolveOutputMode,
} from '@overeng/tui-react/node'

import { ConfigError } from '../../isomorphic/Errors.ts'
import {
  type SessionData,
  saveSession,
  loadSession,
  isSessionNearExpiry,
} from '../GitHubSession.ts'

const LoginResult = Schema.Struct({
  userSession: Schema.String,
  expiresAt: Schema.Finite,
  user: Schema.NullOr(Schema.String),
})

/** Structured, non-secret result emitted by auth commands in JSON modes. */
const AuthOutputSchema = Schema.Union([
  Schema.TaggedStruct('Authenticated', {
    user: Schema.NullOr(Schema.String),
    expiresAt: Schema.NullOr(Schema.String),
    nearExpiry: Schema.Boolean,
  }),
  Schema.TaggedStruct('Unauthenticated', {}),
])
type AuthOutput = typeof AuthOutputSchema.Type

/** Project a stored session into the public auth result without exposing its cookie. */
const authOutputForSession = (session: SessionData | undefined): AuthOutput =>
  session === undefined
    ? { _tag: 'Unauthenticated' }
    : {
        _tag: 'Authenticated',
        user: session.user ?? null,
        expiresAt: session.expiresAt > 0 ? new Date(session.expiresAt * 1000).toISOString() : null,
        nearExpiry: isSessionNearExpiry(session),
      }

const encodeAuthOutput = Schema.encodeSync(Schema.fromJsonString(AuthOutputSchema))

/** Emit structured stdout in JSON modes, otherwise preserve the command's human log line. */
export const reportAuthResult = ({
  output,
  session,
  humanMessage,
}: {
  output: OutputModeValue
  session: SessionData | undefined
  humanMessage: string
}) =>
  resolveOutputMode(output)._tag === 'json'
    ? Console.log(encodeAuthOutput(authOutputForSession(session)))
    : Effect.log(humanMessage)

/**
 * Launch Playwright browser for GitHub login and extract the user_session cookie.
 * Uses a persistent browser profile so the user stays logged in across runs.
 *
 * The browser runs headed, in a `node -e` child: it needs both a resolvable
 * `playwright` module and a display. Neither exists in the packaged CLI or on
 * a headless host, so both preconditions are reported as such.
 */
const performLogin = Effect.gen(function* () {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return yield* new ConfigError({
      message:
        'Browser login needs a graphical session (no DISPLAY/WAYLAND_DISPLAY). Run `gh-ci-utils auth login` on a desktop machine.',
      cause: 'no display',
    })
  }

  const script = `
    const { chromium } = require('playwright');
    const path = require('path');
    const os = require('os');

    (async () => {
      const profileDir = path.join(os.homedir(), '.config/gh-ci-utils/browser-profile');
      const context = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        channel: 'chromium',
      });

      const page = context.pages()[0] || await context.newPage();
      await page.goto('https://github.com/login');

      // Wait for successful login (logged_in cookie appears)
      await page.waitForFunction(
        () => document.cookie.includes('logged_in=yes'),
        null,
        { timeout: 120000 },
      );
      await page.waitForTimeout(2000);
      await page.goto('https://github.com');
      await page.waitForTimeout(1000);

      const cookies = await context.cookies('https://github.com');
      const userSession = cookies.find(c => c.name === 'user_session');
      const dotcomUser = cookies.find(c => c.name === 'dotcom_user');

      if (!userSession) {
        console.error('No user_session cookie found');
        process.exit(1);
      }

      console.log(JSON.stringify({
        userSession: userSession.value,
        expiresAt: userSession.expires,
        user: dotcomUser?.value ?? null,
      }));

      await context.close();
    })().catch(e => { console.error(e.message); process.exit(1); });
  `

  /**
   * `spawner.string` collects stdout only and ignores the exit code, so a
   * child that dies (e.g. `Cannot find module 'playwright'`) looks like an
   * empty success and surfaces as a bogus JSON decode error. Read stdout,
   * stderr and the exit code instead.
   */
  const child = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcessSpawner.use((spawner) =>
        spawner.spawn(ChildProcess.make('node', ['-e', script])),
      )
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: 3 },
      )
      return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
    }),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigError({
          message: 'Failed to launch browser for login. Is Playwright installed?',
          cause,
        }),
    ),
  )

  if (child.exitCode !== 0 || child.stdout.length === 0) {
    return yield* new ConfigError({
      message: child.stderr.includes("Cannot find module 'playwright'")
        ? 'Browser login needs the `playwright` package, which the packaged CLI does not ship. Run it from a gh-ci-utils checkout with Playwright installed.'
        : `Browser login helper exited with code ${child.exitCode} without returning a session`,
      cause: child.stderr.length > 0 ? child.stderr : `exit code ${child.exitCode}`,
    })
  }

  const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LoginResult))(
    child.stdout,
  ).pipe(
    Effect.mapError((cause) => new ConfigError({ message: 'Failed to parse login result', cause })),
  )

  const session: SessionData = {
    userSession: parsed.userSession,
    expiresAt: parsed.expiresAt,
    savedAt: new Date().toISOString(),
    user: parsed.user ?? undefined,
  }

  yield* saveSession(session)
  return session
})

const loginCommand = Cli.Command.make('login', { output: outputOption }).pipe(
  Cli.Command.withHandler(({ output }) =>
    Effect.gen(function* () {
      yield* Effect.log('Opening browser for GitHub login...')
      const session = yield* performLogin
      const expiresStr =
        session.expiresAt > 0
          ? new Date(session.expiresAt * 1000).toISOString().split('T')[0]
          : 'unknown'
      yield* reportAuthResult({
        output,
        session,
        humanMessage: `Logged in as ${session.user ?? 'unknown'}. Session expires ${expiresStr}.`,
      })
    }).pipe(Effect.provide(outputModeLayer(output))),
  ),
  Cli.Command.withDescription('Log in to GitHub via browser for enhanced CI features'),
)

const authStatusCommand = Cli.Command.make('status', { output: outputOption }).pipe(
  Cli.Command.withHandler(({ output }) =>
    Effect.gen(function* () {
      const session = yield* loadSession.pipe(
        Effect.orElseSucceed(() => Option.none<SessionData>()),
      )

      if (Option.isNone(session)) {
        yield* reportAuthResult({
          output,
          session: undefined,
          humanMessage:
            'No active session. Run `gh-ci-utils auth login` for per-step logs and live streaming.',
        })
        return
      }

      const data = session.value
      const nearExpiry = isSessionNearExpiry(data)
      const expiresStr =
        data.expiresAt > 0 ? new Date(data.expiresAt * 1000).toISOString().split('T')[0] : 'unknown'
      yield* reportAuthResult({
        output,
        session: data,
        humanMessage: `Session: ${data.user ?? 'unknown'} | Expires: ${expiresStr}${nearExpiry ? ' (expiring soon, run auth login)' : ''}`,
      })
    }).pipe(Effect.provide(outputModeLayer(output))),
  ),
  Cli.Command.withDescription('Show session status'),
)

/** CLI subcommand for GitHub session authentication */
export const authCommand = Cli.Command.make('auth').pipe(
  Cli.Command.withSubcommands([loginCommand, authStatusCommand]),
  Cli.Command.withDescription('Manage GitHub session for enhanced CI features'),
)
