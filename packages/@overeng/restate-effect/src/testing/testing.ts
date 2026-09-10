/**
 * `@overeng/restate-effect/testing` — a Docker-free, Effect-native testing
 * harness (decision 0009, docs/vrs/09-testing/spec.md). Boots a real native `restate-server` (no
 * Docker) on EPHEMERAL ports against an isolated temp base dir, serves the
 * consumer's endpoint (their `appLayer` threaded into the served runtime so
 * handler `R` is satisfied), registers the deployment, and exposes a typed
 * ingress client + typed `stateOf` State inspection — all as ONE scoped `Layer`.
 *
 * This is the Effect-idiomatic counterpart to Restate's
 * `@restatedev/restate-sdk-testcontainers`: a scoped `Layer` instead of a
 * `TestEnvironment` object, no container runtime, ephemeral ports for ALL
 * listeners (parallel-safe, R27). Consumers wire `it.effect` / `Vitest.layer`
 * themselves (no `@effect/vitest` dependency here).
 *
 * ```ts
 * it.effect('greet round-trips', () =>
 *   Effect.gen(function* () {
 *     const harness = yield* RestateTestHarness
 *     const result = yield* harness.ingress.call({ contract: Greeter, method: 'greet', input: { name: 'Sarah' } })
 *     expect(result.message).toBe('Hello Sarah')
 *     yield* harness.stateOf({ contract: Onboard, key: 'wf-1' }).set({ key: 'status', value: 'pending' })
 *   }).pipe(
 *     Effect.provide(RestateTestHarness.layer({ services: [GreeterLive], appLayer: AppLayer })),
 *   ),
 * )
 * ```
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type * as restate from '@restatedev/restate-sdk'
import * as clients from '@restatedev/restate-sdk-clients'
import {
  Clock,
  type Config,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  type Schema,
  Scope,
} from 'effect'

import { freePorts } from '@overeng/utils/node'

import {
  type AdminClientConfig,
  queryStateRows as adminQueryStateRows,
  putState as adminPutState,
  registerDeployment as adminRegisterDeployment,
} from '../admin/AdminApi.ts'
import {
  type AwakeableId,
  normalizeStateSchema,
  type StateSchemas,
  type StateValueType,
} from '../authoring/RestateContext.ts'
import type {
  Contract,
  ErrorOf,
  HandlerSpecMap,
  InputOf,
  MethodsOf,
  ObjectContract,
  ObjectErrorOf,
  ObjectInputOf,
  ObjectMethodsOf,
  ObjectSuccessOf,
  SuccessOf,
  WorkflowContract,
  WorkflowRunErrorOf,
  WorkflowRunInputOf,
  WorkflowRunSuccessOf,
  WorkflowSignalInputOf,
  WorkflowSignalQueryOf,
  WorkflowSignalSuccessOf,
} from '../authoring/Service.ts'
import {
  call as ingressCall,
  callTyped as ingressCallTyped,
  objectCall as ingressObjectCall,
  objectCallTyped as ingressObjectCallTyped,
  objectSend as ingressObjectSend,
  resolveAwakeable as ingressResolveAwakeable,
  RestateIngress,
  type RestateIngressService,
  result as ingressResult,
  workflowAttach as ingressWorkflowAttach,
  workflowCall as ingressWorkflowCall,
  workflowOutput as ingressWorkflowOutput,
  workflowSubmit as ingressWorkflowSubmit,
} from '../clients/Client.ts'
import { contractSerdeFactory } from '../clients/InvocationPolicy.ts'
import {
  BoundEndpoint,
  type AnyImplementation,
  layerWithBoundEndpoint,
} from '../endpoint/Endpoint.ts'
import { type BoundaryObserver, type EndpointHooks, type HandlerWrap } from '../error/Boundary.ts'
import { type RedactionCipher, RestateRedaction } from '../schema/Redaction.ts'
import { RestateError } from '../schema/RestateError.ts'

/**
 * The faithful in-memory `RestateContext` (decision 0013, docs/vrs/09-testing/spec.md §5): a REAL
 * in-memory implementation of the durable `ctx` for SERVER-FREE unit tests of
 * handler logic + State transitions. NOT a substitute for `RestateTestHarness`
 * (it deliberately does not model durability/replay/single-writer/
 * cross-invocation) — see `TestContext.ts` for the full contract.
 */
export {
  type AwakeableRegistry,
  makeAwakeableRegistry,
  makeTestContext,
  makeTestContextLayer,
  type TestContextHandle,
  type TestContextOptions,
  type TestHandlerKind,
} from './TestContext.ts'

/**
 * The swappable mock⟷real `RestateTestEnv` façade (decision 0017, docs/vrs/09-testing/spec.md): ONE
 * contract-addressed invocation surface (`invokeService(contract, method, input)`)
 * with TWO Layer impls — `RestateTestEnv.mock` (in-process, no server, fast) and
 * `RestateTestEnv.real` (a thin wrapper over `RestateTestHarness`). The SAME test
 * body runs on either backend; `invoke*` carries `RestateError | ErrorOf` (the
 * TYPED declared error) on BOTH, so a `catchTag(DomainError)` compiles identically.
 * The lower-level `RestateTestHarness` + `makeTestContextLayer` primitives stay
 * available (additive — `RestateTestEnv` composes over them).
 */
export { RestateTestEnv, type RestateTestEnvService } from './TestEnv.ts'

/* ════════════════════════════════════════════════════════════════════════
 * Live-clock test util (docs-worker friction #3).
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * A REAL-time sleep that IGNORES `@effect/vitest`'s `it.effect` virtual
 * `TestClock` (under which a bare `Effect.sleep` is virtual and never advances).
 * An integration test coordinating with a real native server across
 * suspend/resume must let wall-clock time actually elapse — `Effect.sleep(ms)`
 * under `TestClock` would HANG forever (the clock never ticks). This pins the
 * sleep to a live `Clock`, so it elapses in real time regardless of the ambient
 * test clock.
 *
 * ```ts
 * it.effect('polls a durable timer', () =>
 *   Effect.gen(function* () {
 *     yield* harness.ingress.objectCall({ contract: Loop, key, method: 'start', input: undefined })
 *     yield* liveSleep(200) // real time, NOT virtual
 *     // ... assert the timer fired ...
 *   }),
 * )
 * ```
 */
const liveClock: Clock.Clock = Context.get(Context.empty(), Clock.Clock)

/** Sleep that always uses the live (real) clock, bypassing journaled time. */
export const liveSleep = (millis: number): Effect.Effect<void> =>
  Effect.sleep(millis).pipe(Effect.provideService(Clock.Clock, liveClock))

/**
 * Run `effect` under a LIVE `Clock` (ignoring the ambient `it.effect`
 * `TestClock`), so any `Effect.sleep` / timer inside it elapses in real time —
 * the general form of {@link liveSleep} for a sub-program that must coordinate
 * with the real server in wall-clock time.
 */
export const withLiveClock = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(Effect.provideService(Clock.Clock, liveClock))

/* ════════════════════════════════════════════════════════════════════════
 * Native server lifecycle (productized from `test/restate-server.ts`).
 * ════════════════════════════════════════════════════════════════════════ */

/** Resolve the `restate-server` binary (built from `nix/restate.nix`), or `$PATH`. */
const serverBin = (): string => {
  const override = process.env['RESTATE_SERVER_BIN']
  /* An empty/whitespace override is treated as UNSET (an empty `RESTATE_SERVER_BIN=`
   * must not become `execFile('')`, which throws `ERR_INVALID_ARG_VALUE`). */
  return override !== undefined && override.trim() !== '' ? override : 'restate-server'
}

/**
 * Whether a usable native `restate-server` binary is available without spawning
 * a long-lived process — a consumer's test can `skipIf(!serverAvailable)` to
 * gracefully skip when the binary is absent (e.g. outside the integration job).
 */
export const serverAvailable: boolean = (() => {
  try {
    execFileSync(serverBin(), ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The native-server determinism env fragment for the two hunting modes (DQ5, docs/vrs/09-testing/spec.md §2). */
const determinismEnv = (opts: {
  readonly alwaysReplay?: boolean
  readonly disableRetries?: boolean
}): Record<string, string> => ({
  /* `alwaysReplay` — force replay at every suspension to surface journal-shape
   * divergence (RESTATE_WORKER__INVOKER__INACTIVITY_TIMEOUT=0s). */
  ...(opts.alwaysReplay === true ? { RESTATE_WORKER__INVOKER__INACTIVITY_TIMEOUT: '0s' } : {}),
  /* `disableRetries` — surface failures immediately instead of retrying
   * (max-attempts=1 + kill-on-max). */
  ...(opts.disableRetries === true
    ? {
        RESTATE_DEFAULT_RETRY_POLICY__MAX_ATTEMPTS: '1',
        RESTATE_DEFAULT_RETRY_POLICY__ON_MAX_ATTEMPTS: 'kill',
      }
    : {}),
})

/** A running native server: its ingress + admin URLs and a deployment register call. */
interface ServerHandle {
  readonly ingressUrl: string
  readonly adminUrl: string
  readonly requestIdentityPublicKey: string
  readonly register: (uri: string) => Promise<void>
  readonly shutdown: () => Promise<void>
}

const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

const base58Encode = (bytes: Uint8Array): string => {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1

  const digits = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let i = 0; i < digits.length; i += 1) {
      const value = digits[i]! * 256 + carry
      digits[i] = value % 58
      carry = Math.floor(value / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }

  return `${'1'.repeat(zeros)}${digits
    .toReversed()
    .map((digit) => base58Alphabet[digit]!)
    .join('')}`
}

const makeRequestIdentity = async (
  baseDir: string,
): Promise<{ readonly privateKeyPath: string; readonly publicKey: string }> => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPath = join(baseDir, 'request-identity-private.pem')
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))

  const publicDer = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }))
  const rawPublicKey = publicDer.slice(-32)
  return { privateKeyPath, publicKey: `publickeyv1_${base58Encode(rawPublicKey)}` }
}

/**
 * The `freePort` TOCTOU (known-flakes #1): the OS hands us a port that is free at
 * read-time but RELEASED before `restate-server` (a separate child process that
 * must bind by NUMBER — we cannot hand it our listening socket) rebinds it, so a
 * co-tenant can steal it in the gap. The child then exits early with an
 * `Address already in use` in its logs. We detect that signature and RETRY the
 * whole boot on FRESH ports rather than failing the harness — closing the gap.
 */
const isPortCollisionLog = (logs: string): boolean =>
  /address (already )?in use|EADDRINUSE/i.test(logs)

/** One boot attempt against fixed ports, or `'port-collision'` if the child died on a taken port. */
type BootAttempt = ServerHandle | 'port-collision'

/**
 * Spawn a native `restate-server` on EPHEMERAL ports (ingress, admin, AND the
 * internal node-to-node message-fabric port — all OS port-0, so parallel
 * instances never collide, R27) against an isolated temp base dir, poll the
 * admin `/health` endpoint until ready, and buffer all output for diagnostics.
 * On any startup failure the buffered server logs are dumped into the error.
 *
 * The boot is retried on a port collision ({@link isPortCollisionLog}) with fresh
 * ports — robust under PARALLEL server boots where the `freePort` TOCTOU bites.
 */
const startServer = async (opts: {
  readonly alwaysReplay?: boolean
  readonly disableRetries?: boolean
}): Promise<ServerHandle> => {
  const baseDir = await mkdtemp(join(tmpdir(), 'restate-harness-'))
  const requestIdentity = await makeRequestIdentity(baseDir)
  const bin = serverBin()

  /* One boot attempt: allocate a fresh, internally-collision-free port batch,
   * spawn, and poll readiness. Returns `'port-collision'` (caller retries) if the
   * child died early with an address-in-use; throws on any other startup failure. */
  const bootOnce = async (): Promise<BootAttempt> => {
    const [ingressPort, adminPort, nodePort] = await freePorts(3)
    const ingressUrl = `http://localhost:${ingressPort}`
    const adminUrl = `http://localhost:${adminPort}`

    let logs = ''
    const capture = (chunk: Buffer | string) => {
      logs += chunk.toString()
    }

    let child: ChildProcess
    try {
      child = spawn(bin, ['--base-dir', baseDir], {
        env: {
          ...process.env,
          /* Ephemeral bind addresses → parallel-safe instances (R27, verified). */
          RESTATE_INGRESS__BIND_ADDRESS: `0.0.0.0:${ingressPort}`,
          RESTATE_ADMIN__BIND_ADDRESS: `0.0.0.0:${adminPort}`,
          /* The internal node-to-node (message-fabric) port also needs an ephemeral
           * bind, else concurrent instances collide on the fixed default 5122. */
          RESTATE_BIND_ADDRESS: `0.0.0.0:${nodePort}`,
          RESTATE_ADVERTISED_ADDRESS: `http://127.0.0.1:${nodePort}/`,
          RESTATE_REQUEST_IDENTITY_PRIVATE_KEY_PEM_FILE: requestIdentity.privateKeyPath,
          /* Quiet but still capture warnings/errors for diagnostics. */
          RESTATE_LOG_FILTER: process.env['RESTATE_LOG_FILTER'] ?? 'warn',
          ...determinismEnv(opts),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (cause) {
      throw new Error(`failed to spawn restate-server (bin: ${bin}): ${String(cause)}`, { cause })
    }

    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)

    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined
    child.on('exit', (code, signal) => {
      exited = { code, signal }
    })

    const fail = (msg: string): never => {
      throw new Error(
        `${msg}\n--- restate-server output ---\n${logs}\n-----------------------------`,
      )
    }

    /* On an early exit, distinguish a recoverable port collision (caller retries
     * on fresh ports) from a hard startup failure (surface with logs). */
    const earlyExit = (): BootAttempt | undefined => {
      if (exited === undefined) return undefined
      if (isPortCollisionLog(logs) === true) return 'port-collision'
      return fail(
        `restate-server exited early (code=${exited.code} signal=${exited.signal}) bin=${bin}`,
      )
    }

    /* Poll the admin health endpoint until ready (or the process dies). */
    const deadline = Date.now() + 30_000
    for (;;) {
      const exit = earlyExit()
      if (exit !== undefined) return exit
      try {
        const res = await fetch(`${adminUrl}/health`)
        if (res.ok === true) break
      } catch {
        /* not up yet */
      }
      if (Date.now() >= deadline) {
        child.kill('SIGKILL')
        fail(`restate-server did not become healthy within 30s (admin: ${adminUrl}/health)`)
      }
      await sleep(200)
    }

    /* Health alone is not enough for the Admin `/query` SQL endpoint (used by
     * `stateOf`): partitions must be initialized + queryable first, else a State
     * query 500s with `node lookup for partition N failed`. Poll a trivial query
     * until it succeeds (mirrors testcontainers' partition-readiness wait). */
    for (;;) {
      const exit = earlyExit()
      if (exit !== undefined) return exit
      try {
        const res = await fetch(`${adminUrl}/query`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: 'SELECT count(1) FROM sys_invocation' }),
        })
        if (res.ok === true) break
      } catch {
        /* partitions not ready yet */
      }
      if (Date.now() >= deadline) {
        child.kill('SIGKILL')
        fail(`restate-server partitions not ready within 30s (admin: ${adminUrl}/query)`)
      }
      await sleep(200)
    }

    const register = async (uri: string): Promise<void> => {
      /* Reuse the shared bare admin client (the same one `./admin` lifts) so the
       * harness and the public admin surface never drift on the registration call. */
      try {
        await adminRegisterDeployment({ config: { adminUrl }, uri, opts: { force: true } })
      } catch (cause) {
        fail(`deployment registration failed for uri=${uri}: ${String(cause)}`)
      }
    }

    const shutdown = async (): Promise<void> => {
      if (exited === undefined) {
        child.kill('SIGTERM')
        const killDeadline = Date.now() + 5_000
        // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- `exited` is set from the child's `exit` event handler (line ~340), a closure mutation the rule cannot see; the loop awaits that async transition.
        while (exited === undefined && Date.now() < killDeadline) await sleep(50)
        if (exited === undefined) child.kill('SIGKILL')
      }
      await rm(baseDir, { recursive: true, force: true })
    }

    return {
      ingressUrl,
      adminUrl,
      requestIdentityPublicKey: requestIdentity.publicKey,
      register,
      shutdown,
    }
  }

  try {
    /* Retry the boot on a port collision (the `freePort` TOCTOU under parallel
     * boots) — a fresh port batch each attempt. A few attempts is ample: a real
     * co-tenant collision is rare and uncorrelated across attempts. */
    const maxAttempts = 6
    for (let attempt = 1; ; attempt++) {
      const result = await bootOnce()
      if (result !== 'port-collision') return result
      if (attempt >= maxAttempts) {
        throw new Error(
          `restate-server lost the port race ${maxAttempts}× in a row (freePort TOCTOU under parallel boot)`,
        )
      }
    }
  } catch (cause) {
    /* Any unrecoverable failure (or exhausted retries): clean up the base dir the
     * successful path hands to `shutdown`. */
    await rm(baseDir, { recursive: true, force: true })
    throw cause
  }
}

/* ════════════════════════════════════════════════════════════════════════
 * Typed State inspection (`stateOf`) over the Admin API (docs/vrs/09-testing/spec.md §1).
 * ════════════════════════════════════════════════════════════════════════ */

/* eslint-disable @typescript-eslint/no-explicit-any -- generic-State boundary; the public StateProxy stays precise via the contract's `state` map */

/** A contract that carries a typed `state` block (Object or Workflow). */
type StatefulContract<S extends StateSchemas> =
  | ObjectContract<string, S, any>
  | WorkflowContract<string, S, any, any, any>

/**
 * A typed State proxy for one Virtual Object / Workflow key (docs/vrs/09-testing/spec.md §1). `get` /
 * `getAll` / `set` / `setAll` are key- AND value-typed against the contract's
 * `state` block, serialized via `effectSerde` (the same per-key Schema the
 * handlers use), and driven over the Admin API. Used to seed pre-conditions and
 * assert post-conditions without going through a handler.
 */
export interface StateProxy<S extends StateSchemas> {
  /** Read a single typed State value (or `undefined` when unset). */
  readonly get: <K extends keyof S & string>(
    key: K,
  ) => Effect.Effect<StateValueType<S[K]> | undefined, RestateError>
  /** Read every set State value as a partial typed record. */
  readonly getAll: Effect.Effect<{ readonly [K in keyof S]?: StateValueType<S[K]> }, RestateError>
  /**
   * Seed a single typed State value (read-modify-write of the full key set).
   * Writing `undefined` to an OPTIONAL field REMOVES the key (`set(key, undefined)`
   * ≡ `clear(key)`), matching State's "absent key → undefined" semantics and the
   * in-handler `State.set` (#1).
   */
  readonly set: <K extends keyof S & string>(args: {
    key: K
    value: StateValueType<S[K]>
  }) => Effect.Effect<void, RestateError>
  /** Remove a single State key (read-modify-write of the full key set). */
  readonly clear: <K extends keyof S & string>(key: K) => Effect.Effect<void, RestateError>
  /** Replace the entire State for the key with the given typed record. */
  readonly setAll: (values: {
    readonly [K in keyof S]?: StateValueType<S[K]>
  }) => Effect.Effect<void, RestateError>
}

const stateError = ({ method, cause }: { method: string; cause: unknown }): RestateError =>
  new RestateError({ reason: 'IngressFailed', method, cause })

/* The State read/write helpers now delegate to the shared bare admin client
 * (`AdminApi.ts`) — the same SQL `/query` HEX-decode + `POST /services/{service}/state`
 * mutation the `./admin` surface uses — so the harness and `./admin` never drift. */
const adminConfigFor = (adminUrl: string): AdminClientConfig => ({ adminUrl })

/** Build a typed `StateProxy` bound to a contract's `state` block + an Admin URL. */
const makeStateProxy = <S extends StateSchemas>({
  adminUrl,
  contract,
  serviceKey,
  redaction,
}: {
  adminUrl: string
  contract: StatefulContract<S>
  serviceKey: string
  redaction: RedactionCipher | undefined
}): StateProxy<S> => {
  const schemas = contract.state
  const service = contract.name
  /* The per-key serde is built through the SAME shared contract-invocation policy
   * the handlers use for State (decision 0020) — the redaction cipher threaded on
   * the `internal` slot (State is journaled), with the same optional-field
   * normalization — so a seed written here decodes identically inside a handler and
   * vice-versa, AND a `Restate.sensitive` State field is encrypted at rest exactly
   * as the handler writes it (no parallel `effectSerde` drift). */
  const serdes = contractSerdeFactory(redaction)
  const serdeFor = <K extends keyof S & string>(key: K) =>
    serdes.forSchema({
      schema: normalizeStateSchema(schemas[key]!) as Schema.Codec<unknown, unknown>,
      slot: 'internal',
    })

  const config = adminConfigFor(adminUrl)
  const readAll = (): Effect.Effect<ReadonlyArray<readonly [string, Uint8Array]>, RestateError> =>
    Effect.tryPromise({
      try: () =>
        adminQueryStateRows({ config, service, serviceKey }).then((rows) =>
          rows.map((r) => [r.key, r.value] as const),
        ),
      catch: (cause) => stateError({ method: `stateOf(${service}/${serviceKey}).read`, cause }),
    })

  const writeAll = (
    entries: ReadonlyArray<readonly [string, Uint8Array]>,
  ): Effect.Effect<void, RestateError> =>
    Effect.tryPromise({
      try: () => adminPutState({ config, service, serviceKey, entries }),
      catch: (cause) => stateError({ method: `stateOf(${service}/${serviceKey}).write`, cause }),
    })

  return {
    get: (key) =>
      readAll().pipe(
        Effect.flatMap((rows) => {
          const hit = rows.find(([k]) => k === key)
          // @effect-diagnostics-next-line effectSucceedWithVoid:off -- `get` returns a meaningful `StateValueType | undefined` union (undefined = key absent), not void; `Effect.void` would break the `StateProxy.get` signature.
          if (hit === undefined) return Effect.succeed(undefined)
          return Effect.try({
            try: () => serdeFor(key).deserialize(hit[1]) as StateValueType<S[typeof key]>,
            catch: (cause) =>
              stateError({ method: `stateOf(${service}/${serviceKey}).get(${key})`, cause }),
          })
        }),
      ),
    getAll: readAll().pipe(
      Effect.flatMap((rows) =>
        Effect.try({
          try: () =>
            Object.fromEntries(
              rows.map(([k, bytes]) => [k, serdeFor(k as keyof S & string).deserialize(bytes)]),
            ) as { readonly [K in keyof S]?: StateValueType<S[K]> },
          catch: (cause) =>
            stateError({ method: `stateOf(${service}/${serviceKey}).getAll`, cause }),
        }),
      ),
    ),
    set: ({ key, value }) =>
      Effect.gen(function* () {
        const existing = yield* readAll()
        const others = existing.filter(([k]) => k !== key)
        /* `set(key, undefined)` on an OPTIONAL field REMOVES the key (≡ `clear`),
         * matching the in-handler `State.set` semantics: an absent key reads back
         * as `undefined`, so the present-value serde is never asked to encode it. */
        if (value === undefined) {
          yield* writeAll(others)
          return
        }
        const encoded = yield* Effect.try({
          try: () => serdeFor(key).serialize(value),
          catch: (cause) =>
            stateError({ method: `stateOf(${service}/${serviceKey}).set(${key})`, cause }),
        })
        yield* writeAll([...others, [key, encoded] as const])
      }),
    clear: (key) =>
      Effect.gen(function* () {
        const existing = yield* readAll()
        yield* writeAll(existing.filter(([k]) => k !== key))
      }),
    setAll: (values) =>
      Effect.gen(function* () {
        const entries = yield* Effect.try({
          try: () =>
            Object.entries(values)
              .filter(([, v]) => v !== undefined)
              .map(([k, v]) => [k, serdeFor(k as keyof S & string).serialize(v)] as const),
          catch: (cause) =>
            stateError({ method: `stateOf(${service}/${serviceKey}).setAll`, cause }),
        })
        yield* writeAll(entries)
      }),
  }
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/* ════════════════════════════════════════════════════════════════════════
 * The harness service + scoped Layer (docs/vrs/09-testing/spec.md, decision 0009).
 * ════════════════════════════════════════════════════════════════════════ */

/** One structured Restate SDK endpoint log record captured by the test harness. */
export interface RestateSdkLogRecord {
  readonly metadata: restate.LogMetadata
  readonly message: unknown
  readonly optionalParams: ReadonlyArray<unknown>
}

/** Snapshot access to Restate SDK endpoint logs captured by the test harness. */
export interface RestateSdkLogCapture {
  /** Snapshot of SDK endpoint logs captured by the harness logger. */
  readonly records: () => ReadonlyArray<RestateSdkLogRecord>
}

/** The harness service value: a bound ingress + a typed `stateOf` factory. */
export interface RestateTestHarnessService {
  /** The spawned server's ingress URL. */
  readonly ingressUrl: string
  /** The spawned server's admin URL (deployment registration + State inspection). */
  readonly adminUrl: string
  /** Structured SDK endpoint logs captured without writing them to process stderr. */
  readonly sdkLogs: RestateSdkLogCapture
  /**
   * The typed ingress client surface, each pre-bound to the spawned ingress (no
   * need to thread `RestateIngress` — the harness provides it internally). Mirrors
   * the top-level `Client` call surface (Services / Objects / Workflows / result).
   */
  readonly ingress: BoundIngress
  /**
   * A typed State proxy for one Virtual Object / Workflow key (docs/vrs/09-testing/spec.md §1):
   * `get` / `getAll` / `set` / `setAll`, key+value typed against the contract's
   * `state` block, over the Admin API. Seed pre-conditions and assert
   * post-conditions without going through a handler.
   */
  readonly stateOf: <S extends StateSchemas>(args: {
    contract: StatefulContract<S>
    key: string
  }) => StateProxy<S>
  /**
   * Serve an ADDITIONAL `services` array on a fresh ephemeral SDK port and register
   * it as a SECOND deployment version against the running server (docs/vrs/09-testing/spec.md §2,
   * multi-deployment). The new endpoint is built into the harness scope (its
   * finalizer closes before the server shuts down), so a test can register two
   * endpoint VERSIONS of the same service and assert replay/upgrade across them. The
   * new version's `appLayer` is threaded into its served runtime. Returns the served
   * SDK URL of the new deployment.
   */
  readonly registerDeployment: <AppR2, RIn2 = never>(opts: {
    readonly services: ReadonlyArray<AnyImplementation<AppR2>>
    readonly appLayer: Layer.Layer<AppR2, never, RIn2>
  }) => Effect.Effect<string, RestateError, RIn2>
}

/* eslint-disable @typescript-eslint/no-explicit-any -- contract phantoms, matching the `Client` signatures these mirror */

/**
 * The harness ingress surface: the standalone `Client` call functions with their
 * trailing `RestateIngress` requirement already discharged (the harness provides
 * the connected ingress). A test reaches these via `harness.ingress.*`.
 *
 * Each method MIRRORS the corresponding `Client` function's GENERIC signature so
 * the precise per-call typed-error + success channels survive (the old
 * `BindLast<typeof fn>` mapped type collapsed each generic's `E` to its widest
 * constraint, losing per-call `ErrorOf` — so `catchTag<DomainError>` would not
 * compile). The only difference is `R = never` (the harness provides
 * `RestateIngress`). The `*Of` helpers keep these derived from the contract, so a
 * contract change still flows through.
 */
export interface BoundIngress {
  readonly call: <C extends Contract<string, HandlerSpecMap>, M extends MethodsOf<C>>(args: {
    contract: C
    method: M
    input: InputOf<C, M>
  }) => Effect.Effect<SuccessOf<C, M>, RestateError, never>
  readonly callTyped: <C extends Contract<string, HandlerSpecMap>, M extends MethodsOf<C>>(args: {
    contract: C
    method: M
    input: InputOf<C, M>
  }) => Effect.Effect<SuccessOf<C, M>, RestateError | ErrorOf<C, M>, never>
  readonly objectCall: <
    C extends ObjectContract<string, any, any>,
    M extends ObjectMethodsOf<C>,
  >(args: {
    contract: C
    key: string
    method: M
    input: ObjectInputOf<C, M>
  }) => Effect.Effect<ObjectSuccessOf<C, M>, RestateError, never>
  readonly objectCallTyped: <
    C extends ObjectContract<string, any, any>,
    M extends ObjectMethodsOf<C>,
  >(args: {
    contract: C
    key: string
    method: M
    input: ObjectInputOf<C, M>
  }) => Effect.Effect<ObjectSuccessOf<C, M>, RestateError | ObjectErrorOf<C, M>, never>
  readonly objectSend: <
    C extends ObjectContract<string, any, any>,
    M extends ObjectMethodsOf<C>,
  >(args: {
    contract: C
    key: string
    method: M
    input: ObjectInputOf<C, M>
    opts?: { readonly delayMillis?: number }
  }) => Effect.Effect<clients.Send, RestateError, never>
  readonly workflowSubmit: <C extends WorkflowContract<string, any, any, any, any>>(args: {
    contract: C
    key: string
    input: WorkflowRunInputOf<C>
  }) => Effect.Effect<clients.WorkflowSubmission<WorkflowRunSuccessOf<C>>, RestateError, never>
  readonly workflowAttach: <C extends WorkflowContract<string, any, any, any, any>>(args: {
    contract: C
    key: string
  }) => Effect.Effect<WorkflowRunSuccessOf<C>, RestateError | WorkflowRunErrorOf<C>, never>
  readonly workflowOutput: <C extends WorkflowContract<string, any, any, any, any>>(args: {
    contract: C
    key: string
  }) => Effect.Effect<clients.Output<WorkflowRunSuccessOf<C>>, RestateError, never>
  readonly workflowCall: <
    C extends WorkflowContract<string, any, any, any, any>,
    M extends WorkflowSignalQueryOf<C>,
  >(args: {
    contract: C
    key: string
    method: M
    input: WorkflowSignalInputOf<C, M>
  }) => Effect.Effect<WorkflowSignalSuccessOf<C, M>, RestateError, never>
  readonly result: <T, I>(args: {
    send: clients.Send<unknown> | clients.WorkflowSubmission<unknown>
    outputSchema: Schema.Codec<T, I>
  }) => Effect.Effect<T, RestateError, never>
  readonly resolveAwakeable: <T, I>(args: {
    schema: Schema.Codec<T, I>
    id: AwakeableId<T>
    payload: T
  }) => Effect.Effect<void, RestateError, never>
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/** The harness service tag. The `layer` factory below is the only constructor. */
export class RestateTestHarness extends Context.Service<
  RestateTestHarness,
  RestateTestHarnessService
>()('@overeng/restate-effect/RestateTestHarness') {
  /**
   * A scoped `Layer` that, on ACQUIRE: allocates an isolated temp base dir +
   * EPHEMERAL ports for every listener (server ingress / admin / node-to-node AND
   * the SDK endpoint), spawns `restate-server` with the optional
   * `alwaysReplay` / `disableRetries` determinism env, polls admin `/health`,
   * serves the consumer's `services` endpoint (their `appLayer` threaded into the
   * served runtime so handler `R` is satisfied) on its ephemeral port, and
   * registers the deployment. On RELEASE (reverse order, same scope): close the
   * endpoint → SIGTERM/SIGKILL the server → remove the base dir. Buffered server
   * logs are surfaced on any startup failure.
   *
   * `appLayer` is the consumer's application Layer (the same one they provide to
   * `serve` in production); `RIn` is whatever it still requires (usually
   * `never`). The harness output is `RestateTestHarness` (the typed ingress +
   * `stateOf`).
   */
  static layer = <AppR, RIn = never>(opts: {
    readonly services: ReadonlyArray<AnyImplementation<AppR>>
    readonly appLayer: Layer.Layer<AppR, never, RIn>
    readonly alwaysReplay?: boolean
    readonly disableRetries?: boolean
    /**
     * Endpoint observability wiring threaded into the served endpoint (docs/vrs/08-observability/spec.md):
     * the Restate `hooks` (e.g. the otel `openTelemetryHook`), the per-invocation
     * `inboundBridge` (attempt-span → Effect-parent), and the `boundaryObserver`
     * (per-invocation span-stamp + outcome metric). Supply the `./otel`
     * `RestateOtel.{hook,inboundBridge,boundaryObserver}` here to exercise OTel
     * end-to-end against the real server (gap: OTel reparenting under REAL replay).
     */
    readonly hooks?: ReadonlyArray<EndpointHooks>
    readonly inboundBridge?: HandlerWrap
    readonly boundaryObserver?: BoundaryObserver
  }): Layer.Layer<RestateTestHarness, RestateError, RIn> =>
    Layer.effect(
      RestateTestHarness,
      Effect.gen(function* () {
        const sdkLogRecords: Array<RestateSdkLogRecord> = []
        // oxlint-disable-next-line overeng/named-args -- implements the Restate SDK's positional LoggerTransport callback.
        const sdkLogger: restate.LoggerTransport = (metadata, message, ...optionalParams) => {
          sdkLogRecords.push({ metadata, message, optionalParams })
        }
        /* 1. Spawn the native server (ephemeral ports + isolated base dir). The
         * finalizer SIGTERM/SIGKILLs it and removes the base dir LAST. */
        const server = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              startServer({
                ...(opts.alwaysReplay !== undefined ? { alwaysReplay: opts.alwaysReplay } : {}),
                ...(opts.disableRetries !== undefined
                  ? { disableRetries: opts.disableRetries }
                  : {}),
              }),
            catch: (cause) =>
              new RestateError({ reason: 'EndpointFailed', method: 'startServer', cause }),
          }),
          (s) => Effect.promise(() => s.shutdown()),
        )

        /* Serve one `services` array on a fresh ephemeral SDK port (the consumer's
         * `appLayer` provided so handler `R` is discharged) and register it as a
         * deployment. The endpoint `layer` is itself scoped — building it into the
         * GIVEN scope registers its finalizer (close the HTTP/2 server) BEFORE the
         * server-shutdown finalizer (close endpoint → kill server → rm base dir).
         * Reused for the primary deployment AND `registerDeployment` (multi-version,
         * docs/vrs/09-testing/spec.md §2) — each gets its own port + scope-managed endpoint. */
        const serveAndRegister = <AppR2, RIn2>({
          services,
          appLayer,
          endpointScope,
        }: {
          services: ReadonlyArray<AnyImplementation<AppR2>>
          appLayer: Layer.Layer<AppR2, never, RIn2>
          endpointScope: Scope.Scope
        }): Effect.Effect<string, RestateError, RIn2> =>
          Effect.gen(function* () {
            const endpointContext = yield* Layer.buildWithScope(
              layerWithBoundEndpoint({
                services,
                port: 0,
                ...(opts.hooks !== undefined ? { hooks: opts.hooks } : {}),
                ...(opts.inboundBridge !== undefined ? { inboundBridge: opts.inboundBridge } : {}),
                ...(opts.boundaryObserver !== undefined
                  ? { boundaryObserver: opts.boundaryObserver }
                  : {}),
                identityKeys: [server.requestIdentityPublicKey],
                sdkLogger,
              }).pipe(Layer.provide(appLayer)),
              endpointScope,
            ).pipe(
              /* The endpoint layer's channel is `RestateError | ConfigError`, but
               * the `ConfigError` arm fires ONLY for a `Config<number>` port — here
               * the port is literal `0`, so it is structurally impossible.
               * Re-fail a real `RestateError` (a bind/listen failure) and die on the
               * unreachable `ConfigError`, keeping the harness channel clean. */
              Effect.catchIf(
                (cause): cause is Config.ConfigError => !(cause instanceof RestateError),
                (cause) => Effect.die(cause),
              ),
            )
            const uri = Context.get(endpointContext, BoundEndpoint).url
            yield* Effect.tryPromise({
              try: () => server.register(uri),
              catch: (cause) =>
                new RestateError({ reason: 'EndpointFailed', method: 'register', cause }),
            })
            return uri
          })

        /* MEMOIZE the primary `appLayer` so it is built EXACTLY ONCE into the
         * harness scope and shared by (a) the served endpoint and (b) the redaction
         * read below — no double-acquisition of resourceful app services. The
         * memoized layer is provided to the endpoint AND read for `RestateRedaction`,
         * so the harness uses the SAME cipher instance the handlers do. */
        const harnessScope = yield* Effect.scope
        const appContext = yield* Layer.build(opts.appLayer)
        const memoAppLayer = Layer.succeedContext(appContext)

        /* 2.+3. Serve + register the primary deployment into the harness scope. */
        yield* serveAndRegister({
          services: opts.services,
          appLayer: memoAppLayer,
          endpointScope: harnessScope,
        })

        /* Resolve the OPTIONAL `RestateRedaction` cipher from the consumer's
         * `appLayer` — the SAME cipher the served endpoint resolves (decision 0020),
         * so the harness ingress + `stateOf` use the IDENTICAL contract-invocation
         * policy as production rather than a parallel `effectSerde` path (closes the
         * harness-drift gap). Read from the memoized build; absent → no cipher. */
        const redaction = Context.getOption(appContext, RestateRedaction).pipe(
          Option.getOrUndefined,
        )

        /* 4. Build the connected ingress runtime once, so the bound call surface
         * provides `RestateIngress` internally (the test never threads it). The
         * redaction cipher rides on the ingress service, so a `Restate.sensitive`
         * field is encrypted on the wire through the SAME policy as production. */
        const ingressService: RestateIngressService = {
          ingress: clients.connect({ url: server.ingressUrl }),
          ...(redaction !== undefined ? { redaction } : {}),
        }
        const provideIngress = <X, E, R>(
          effect: Effect.Effect<X, E, R>,
        ): Effect.Effect<X, E, Exclude<R, RestateIngress>> =>
          effect.pipe(Effect.provideService(RestateIngress, ingressService)) as Effect.Effect<
            X,
            E,
            Exclude<R, RestateIngress>
          >

        const bound: BoundIngress = {
          call: ((...a: Parameters<typeof ingressCall>) =>
            provideIngress(ingressCall(...a))) as BoundIngress['call'],
          callTyped: ((...a: Parameters<typeof ingressCallTyped>) =>
            provideIngress(ingressCallTyped(...a))) as BoundIngress['callTyped'],
          objectCall: ((...a: Parameters<typeof ingressObjectCall>) =>
            provideIngress(ingressObjectCall(...a))) as BoundIngress['objectCall'],
          /* Generic wrapper (not `Parameters<typeof ...>`-spread) so the deferred
           * conditional `ObjectErrorOf<C, M>` stays in the error channel instead of
           * collapsing to `unknown` at the constraint defaults. */
          objectCallTyped: (<
            C extends ObjectContract<string, any, any>,
            M extends ObjectMethodsOf<C>,
          >(args: {
            contract: C
            key: string
            method: M
            input: ObjectInputOf<C, M>
          }) => provideIngress(ingressObjectCallTyped(args))) as BoundIngress['objectCallTyped'],
          objectSend: ((...a: Parameters<typeof ingressObjectSend>) =>
            provideIngress(ingressObjectSend(...a))) as BoundIngress['objectSend'],
          workflowSubmit: ((...a: Parameters<typeof ingressWorkflowSubmit>) =>
            provideIngress(ingressWorkflowSubmit(...a))) as BoundIngress['workflowSubmit'],
          /* Generic wrapper (see `objectCallTyped`) so `WorkflowRunErrorOf<C>` stays
           * a deferred conditional rather than degrading to `unknown`. */
          workflowAttach: (<C extends WorkflowContract<string, any, any, any, any>>(args: {
            contract: C
            key: string
          }) => provideIngress(ingressWorkflowAttach(args))) as BoundIngress['workflowAttach'],
          workflowOutput: ((...a: Parameters<typeof ingressWorkflowOutput>) =>
            provideIngress(ingressWorkflowOutput(...a))) as BoundIngress['workflowOutput'],
          workflowCall: ((...a: Parameters<typeof ingressWorkflowCall>) =>
            provideIngress(ingressWorkflowCall(...a))) as BoundIngress['workflowCall'],
          result: ((...a: Parameters<typeof ingressResult>) =>
            provideIngress(ingressResult(...a))) as BoundIngress['result'],
          resolveAwakeable: ((...a: Parameters<typeof ingressResolveAwakeable>) =>
            provideIngress(ingressResolveAwakeable(...a))) as BoundIngress['resolveAwakeable'],
        }

        return {
          ingressUrl: server.ingressUrl,
          adminUrl: server.adminUrl,
          sdkLogs: {
            records: () => [...sdkLogRecords],
          },
          ingress: bound,
          stateOf: <S extends StateSchemas>(args: { contract: StatefulContract<S>; key: string }) =>
            makeStateProxy({
              adminUrl: server.adminUrl,
              contract: args.contract,
              serviceKey: args.key,
              redaction,
            }),
          registerDeployment: (<AppR2, RIn2>(deployOpts: {
            readonly services: ReadonlyArray<AnyImplementation<AppR2>>
            readonly appLayer: Layer.Layer<AppR2, never, RIn2>
          }) =>
            serveAndRegister({
              services: deployOpts.services,
              appLayer: deployOpts.appLayer,
              endpointScope: harnessScope,
            })) as RestateTestHarnessService['registerDeployment'],
        }
      }),
    )
}

/* ════════════════════════════════════════════════════════════════════════
 * `withRestateServer` — a manual-scope harness holder (#5, docs/vrs/09-testing/spec.md §5).
 * ════════════════════════════════════════════════════════════════════════ */

/** A held, lazily-booted harness: `setup`/`teardown` for `beforeAll`/`afterAll`, plus the live `harness` accessor. */
export interface HeldRestateServer {
  /** Build the harness Layer into a held scope (boots the native server). Wire as the suite's `beforeAll`. */
  readonly setup: () => Promise<void>
  /** Close the held scope (shuts the server down + removes the temp dir). Wire as the suite's `afterAll`. */
  readonly teardown: () => Promise<void>
  /** The live harness service (typed ingress + `stateOf`). THROWS if read before `setup` completed. */
  readonly harness: () => RestateTestHarnessService
}

/**
 * Collapse the ~25-line copy-pasted `beforeAll`/`afterAll` that manually makes a
 * `Scope`, builds `RestateTestHarness.layer` into it, extracts the service, and
 * closes the scope. A suite calls this ONCE and wires `setup`/`teardown` into its
 * `beforeAll`/`afterAll`, then reads the booted service via `harness()`:
 *
 * ```ts
 * const held = withRestateServer({ services, appLayer: Layer.empty })
 * beforeAll(held.setup, 90_000)
 * afterAll(held.teardown, 90_000)
 * // ... in a test:
 * const result = yield* held.harness().ingress.objectCall({ contract: Loop, key, method: 'start', input: undefined })
 * ```
 *
 * This is the manual-scope sibling of `RestateTestHarness.layer` (which a suite
 * provides via `@effect/vitest`'s `it.layer`). Prefer `it.layer` for `it.effect`
 * suites; use `withRestateServer` when the suite drives the ingress from plain
 * `async` test bodies and needs ONE server held across all tests (e.g. a poll-loop
 * stress suite). The same `serverAvailable` skip applies — `setup` is a no-op when
 * no native binary is present, and `harness()` then throws (guard the suite with
 * `describe.skipIf(!serverAvailable)`).
 */
export const withRestateServer = <AppR>(opts: {
  readonly services: ReadonlyArray<AnyImplementation<AppR>>
  readonly appLayer: Layer.Layer<AppR, never, never>
  readonly alwaysReplay?: boolean
  readonly disableRetries?: boolean
}): HeldRestateServer => {
  let scope: Scope.Closeable | undefined
  let service: RestateTestHarnessService | undefined
  const built = RestateTestHarness.layer(opts)

  return {
    setup: async () => {
      if (serverAvailable === false) return
      scope = await Effect.runPromise(Scope.make())
      service = await Effect.runPromise(
        Layer.buildWithScope(built, scope).pipe(
          Effect.map((ctx) => Context.get(ctx, RestateTestHarness)),
        ),
      )
    },
    teardown: async () => {
      if (scope !== undefined) await Effect.runPromise(Scope.close(scope, Exit.void))
      scope = undefined
      service = undefined
    },
    harness: () => {
      if (service === undefined) {
        throw new Error(
          'withRestateServer: harness() read before setup() completed (or no restate-server available)',
        )
      }
      return service
    },
  }
}
