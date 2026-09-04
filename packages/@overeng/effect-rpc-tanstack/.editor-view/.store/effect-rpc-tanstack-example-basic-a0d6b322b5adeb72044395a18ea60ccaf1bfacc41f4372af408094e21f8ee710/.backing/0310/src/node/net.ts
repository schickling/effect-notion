/**
 * Dependency-free TCP-port helpers for tests and dev servers.
 *
 * The SSOT for "ask the OS for a free port" — previously hand-copied across the
 * playwright config factory and the restate-effect test harness (4+ copies that
 * drifted in error wording and, worse, all shared the same TOCTOU race below).
 *
 * @module
 */
import { createServer } from 'node:net'

/**
 * Ask the OS for a free TCP port (bind `:0`, read the bound port, release it).
 *
 * INHERENT TOCTOU: the port is free at the instant we read it but is RELEASED
 * before the caller rebinds, so a co-tenant can grab it in the gap. This is fine
 * for a single non-contended bind, but under parallel boots prefer
 * {@link withFreePort} (retry-on-`EADDRINUSE`) for a bind-by-number consumer, or
 * {@link freePorts} when you need several DISTINCT ports allocated as one batch.
 */
export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        srv.close(() => reject(new Error('could not allocate a free port')))
        return
      }
      const port = addr.port
      srv.close(() => resolve(port))
    })
  })

/**
 * Allocate `count` DISTINCT free ports as one batch.
 *
 * Unlike `Promise.all([freePort(), freePort()])` — where each helper closes its
 * listener independently, so the OS may hand the SAME `:0` port to two of them —
 * this holds every listener open until all ports are read, guaranteeing the
 * batch is internally collision-free. The cross-process TOCTOU still applies (a
 * co-tenant can still grab one in the gap before the caller binds); pair with
 * {@link withFreePort} per port when that matters.
 */
export const freePorts = (count: number): Promise<number[]> => {
  if (count <= 0) return Promise.resolve([])
  return new Promise((resolve, reject) => {
    const servers = Array.from({ length: count }, () => createServer())
    let settled = false
    const cleanup = (cb: () => void) => {
      let remaining = servers.length
      for (const srv of servers) srv.close(() => (--remaining === 0 ? cb() : undefined))
    }
    const fail = (cause: unknown) => {
      if (settled === true) return
      settled = true
      cleanup(() => reject(cause instanceof Error ? cause : new Error(String(cause))))
    }

    let listening = 0
    for (const srv of servers) {
      srv.unref()
      srv.on('error', fail)
      srv.listen(0, '127.0.0.1', () => {
        if (++listening < servers.length) return
        const ports: number[] = []
        for (const s of servers) {
          const addr = s.address()
          if (addr === null || typeof addr === 'string') {
            fail(new Error('could not allocate a free port'))
            return
          }
          ports.push(addr.port)
        }
        settled = true
        cleanup(() => resolve(ports))
      })
    }
  })
}

/** Whether a thrown error is an `EADDRINUSE` (the port was taken in the TOCTOU gap). */
const isAddrInUse = (cause: unknown): boolean =>
  typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'EADDRINUSE'

/**
 * Run `fn(port)` against a freshly-allocated port, RETRYING on `EADDRINUSE` with
 * a new port (up to `retries`). This closes the {@link freePort} TOCTOU gap for a
 * consumer that binds by port NUMBER (e.g. a child process such as
 * `restate-server` that cannot be handed an already-listening socket): when a
 * co-tenant grabs the port in the gap, the bind fails with `EADDRINUSE` and we
 * simply try again on a different port instead of failing the whole boot.
 *
 * `fn` MUST reject with an `EADDRINUSE`-coded error (or one whose message
 * contains `EADDRINUSE` / `address in use`) when its bind loses the race; any
 * other rejection propagates immediately (it is not a port collision).
 */
export const withFreePort = async <A>({
  fn,
  opts,
}: {
  readonly fn: (port: number) => Promise<A>
  readonly opts?: { readonly retries?: number }
}): Promise<A> => {
  const retries = opts?.retries ?? 5
  let lastErr: unknown
  // Retry-on-collision: each attempt binds a fresh port and depends on the prior
  // attempt having failed (EADDRINUSE), so the awaits are intentionally
  // sequential — parallelizing the retries is nonsensical.
  for (let attempt = 0; attempt <= retries; attempt++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- intentional sequential retry (see above)
    const port = await freePort()
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- intentional sequential retry (see above)
      return await fn(port)
    } catch (cause) {
      lastErr = cause
      const msg = cause instanceof Error ? cause.message.toLowerCase() : String(cause).toLowerCase()
      const collided =
        isAddrInUse(cause) || msg.includes('eaddrinuse') || msg.includes('address in use')
      if (collided === false) throw cause
      /* port collision — retry with a fresh port */
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`withFreePort: exhausted ${retries} retries: ${String(lastErr)}`)
}
