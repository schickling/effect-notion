/**
 * DURABILITY — SIGKILL the native server mid inter-cycle wait (the wake-mode held
 * race) and confirm the composed loop RESUMES after restart: the cursor keeps
 * climbing past the kill. The held inter-cycle race is journaled, so on replay the
 * wait re-issues and its timer fires post-restart; the chain continues.
 *
 * The package harness (`withRestateServer`) uses a THROWAWAY base dir, so we drive
 * the server manually here with a PERSISTENT base dir + fixed ports across a
 * kill+restart (durable state + timers persist). The SDK endpoint stays up
 * in-process the whole time. Productizes `tmp/restate-spike-pollloop-compose/
 * durability.integration.test.ts`. Skips when no native server is DECLARED.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type * as restate from '@restatedev/restate-sdk'
import * as clients from '@restatedev/restate-sdk-clients'
import { Context, Effect, Exit, Layer, Scope } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { freePorts } from '@overeng/utils/node'

import {
  installComposedSource,
  makeComposedDaemon,
  resetComposedSources,
} from '../../examples/12-self-reschedule.ts'
import {
  objectCall as ingressObjectCall,
  objectSend as ingressObjectSend,
  RestateIngress,
  type RestateIngressService,
} from '../clients/Client.ts'
import { BoundEndpoint, layerWithBoundEndpoint } from '../endpoint/Endpoint.ts'

/** Reads one Buck-declared immutable tool path; nothing resolves through an ambient PATH. */
const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

/**
 * The capability-gated live lane runs only when the `restate-server` tool is
 * DECLARED (`test_capabilities.restate-server`, empty when unprojected). The
 * binary itself is never probed and never resolved through `PATH`: once the
 * declaration exists, {@link requireTool} names the exact nix-store path.
 */
const serverAvailable = (process.env['RESTATE_SERVER_BIN'] ?? '').trim() !== ''

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

interface SdkLogRecord {
  readonly metadata: restate.LogMetadata
  readonly message: unknown
  readonly optionalParams: ReadonlyArray<unknown>
}

interface Ports {
  ingress: number
  admin: number
  node: number
}

const spawnServer = (baseDir: string, ports: Ports): ChildProcess => {
  const child = spawn(requireTool('RESTATE_SERVER_BIN'), ['--base-dir', baseDir], {
    env: {
      ...process.env,
      RESTATE_INGRESS__BIND_ADDRESS: `0.0.0.0:${ports.ingress}`,
      RESTATE_ADMIN__BIND_ADDRESS: `0.0.0.0:${ports.admin}`,
      RESTATE_BIND_ADDRESS: `0.0.0.0:${ports.node}`,
      RESTATE_ADVERTISED_ADDRESS: `http://127.0.0.1:${ports.node}/`,
      RESTATE_LOG_FILTER: process.env['RESTATE_LOG_FILTER'] ?? 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', () => {})
  child.stderr?.on('data', () => {})
  return child
}

const waitHealthy = async (adminUrl: string, deadlineMs = 30_000): Promise<void> => {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    try {
      const res = await fetch(`${adminUrl}/health`)
      if (res.ok === true) {
        const q = await fetch(`${adminUrl}/query`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: 'SELECT count(1) FROM sys_invocation' }),
        })
        if (q.ok === true) return
      }
    } catch {
      /* not up */
    }
    if (Date.now() >= deadline) throw new Error('server not healthy in time')
    await sleep(200)
  }
}

const register = async (adminUrl: string, uri: string): Promise<void> => {
  const res = await fetch(`${adminUrl}/deployments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uri, force: true }),
  })
  if (res.ok === false)
    throw new Error(`register failed ${res.status}: ${await res.text().catch(() => '')}`)
}

const readCursor = async (adminUrl: string, serviceName: string, key: string): Promise<number> => {
  const res = await fetch(`${adminUrl}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      query: `SELECT key, value FROM state WHERE service_name = '${serviceName}' AND service_key = '${key}'`,
    }),
  })
  if (res.ok === false) return -1
  const body = (await res.json()) as { rows?: Array<Record<string, unknown>> }
  const row = (body.rows ?? []).find((r) => r['key'] === 'cursor')
  if (row === undefined) return 0
  const value = row['value']
  if (typeof value !== 'string') return -1
  return Number(JSON.parse(Buffer.from(value, 'hex').toString('utf8')) as number)
}

const unknownText = (value: unknown): string => {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const sdkLogText = (record: SdkLogRecord): string =>
  [
    unknownText(record.metadata),
    unknownText(record.message),
    ...record.optionalParams.map(unknownText),
  ].join('\n')

const isExpectedKillAbortLog = (record: SdkLogRecord): boolean => {
  const text = sdkLogText(record)
  return (
    text.includes('Premature close') === true ||
    text.includes('ERR_STREAM_PREMATURE_CLOSE') === true ||
    text.includes('The stream has been destroyed') === true
  )
}

const waitForExpectedKillAbortLog = async (
  sdkLogs: ReadonlyArray<SdkLogRecord>,
  deadlineMs = 5_000,
): Promise<void> => {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (sdkLogs.some(isExpectedKillAbortLog) === true) return
    await sleep(100)
  }
}

/* A wake-enabled composed daemon with a slow-ish delay so a kill reliably lands
 * mid-wait (the held wake race). */
const Daemon = makeComposedDaemon({ name: 'cmp-durab', delayMillis: 1_500, wake: true })

describe.skipIf(!serverAvailable)(
  'pollLoop composition durability (SIGKILL mid inter-cycle wait)',
  () => {
    let baseDir: string
    let ports: Ports
    let child: ChildProcess
    let endpointScope: Scope.Closeable
    let ingressUrl: string
    let adminUrl: string
    let sdkUrl: string
    let sdkLogs: Array<SdkLogRecord>

    const provideIngress = <X, E, R>(eff: Effect.Effect<X, E, R>) => {
      const svc: RestateIngressService = { ingress: clients.connect({ url: ingressUrl }) }
      return eff.pipe(Effect.provideService(RestateIngress, svc)) as Effect.Effect<
        X,
        E,
        Exclude<R, RestateIngress>
      >
    }

    beforeAll(async () => {
      if (serverAvailable === false) return
      resetComposedSources()
      sdkLogs = []
      const sdkLogger: restate.LoggerTransport = (metadata, message, ...optionalParams) => {
        sdkLogs.push({ metadata, message, optionalParams })
      }
      baseDir = await mkdtemp(join(tmpdir(), 'restate-compose-durab-'))
      const allocatedPorts = await freePorts(3)
      const [ingress, admin, node] = [allocatedPorts[0]!, allocatedPorts[1]!, allocatedPorts[2]!]
      ports = { ingress, admin, node }
      ingressUrl = `http://localhost:${ingress}`
      adminUrl = `http://localhost:${admin}`

      endpointScope = await Effect.runPromise(Scope.make())
      try {
        const endpointContext = await Effect.runPromise(
          Layer.buildWithScope(
            layerWithBoundEndpoint({
              services: [Daemon.implementation],
              port: 0,
              sdkLogger,
            }).pipe(Layer.provide(Layer.empty)),
            endpointScope,
          ),
        )
        sdkUrl = Context.get(endpointContext, BoundEndpoint).url
      } catch (cause) {
        await Effect.runPromise(Scope.close(endpointScope, Exit.void))
        throw cause
      }

      child = spawnServer(baseDir, ports)
      try {
        await waitHealthy(adminUrl)
      } catch (cause) {
        if (child.exitCode === null) {
          child.kill('SIGKILL')
          await sleep(300)
        }
        throw cause
      }
      await register(adminUrl, sdkUrl)
    }, 90_000)

    afterAll(async () => {
      if (serverAvailable === false) return
      if (child !== undefined && child.exitCode === null) {
        child.kill('SIGKILL')
        await sleep(300)
      }
      if (endpointScope !== undefined)
        await Effect.runPromise(Scope.close(endpointScope, Exit.void))
      if (baseDir !== undefined) await rm(baseDir, { recursive: true, force: true })
    }, 90_000)

    it('SIGKILL mid inter-cycle wait → the loop resumes (cursor climbs past the kill)', async () => {
      const key = 'durab-1'
      installComposedSource({
        key,
        behavior: (cursor) => ({
          nextCursor: cursor + 1,
          itemCount: 1,
          done: false,
        }),
      })
      await Effect.runPromise(
        provideIngress(
          ingressObjectCall({ contract: Daemon.contract, key, method: 'start', input: undefined }),
        ),
      )

      /* Let a couple cycles run, then capture the cursor. The 1.5s held wake-race means
       * a kill ~2.2s in lands DURING an inter-cycle wait. */
      await sleep(2_200)
      const cursorBefore = await readCursor(adminUrl, 'cmp-durab', key)
      expect(cursorBefore).toBeGreaterThanOrEqual(1)

      /* KILL the server mid-wait (a held inter-cycle race + a pending re-arm). */
      child.kill('SIGKILL')
      await sleep(500)

      /* RESTART against the same base-dir + ports (durable state + timers persist). */
      child = spawnServer(baseDir, ports)
      await waitHealthy(adminUrl)

      /* The loop should resume: the held inter-cycle wait's timer fires post-restart
       * and the chain continues → cursor keeps climbing. */
      const deadline = Date.now() + 25_000
      let cursorAfter = cursorBefore
      while (cursorAfter <= cursorBefore && Date.now() < deadline) {
        cursorAfter = await readCursor(adminUrl, 'cmp-durab', key)
        await sleep(300)
      }
      expect(cursorAfter).toBeGreaterThan(cursorBefore)
      await waitForExpectedKillAbortLog(sdkLogs)
      expect(sdkLogs.some(isExpectedKillAbortLog)).toBe(true)

      await Effect.runPromise(
        provideIngress(
          ingressObjectSend({ contract: Daemon.contract, key, method: 'stop', input: undefined }),
        ),
      )
    }, 90_000)
  },
)
