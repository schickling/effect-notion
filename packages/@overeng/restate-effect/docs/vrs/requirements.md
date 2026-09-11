# Requirements: restate-effect

Cross-cutting, testable constraints for `@overeng/restate-effect`. Builds on
[vision.md](./vision.md). Terms are defined in [glossary.md](./glossary.md);
rationale for the hard-to-reverse choices lives in [.decisions/](./.decisions/)
and is cross-referenced by ID.

The per-subsystem requirements (preserving the GLOBAL R-IDs) live under the
numeric subsystem dirs — see [spec.md](./spec.md) for the architecture index and
the map of which subsystem owns which requirement. The global Assumptions
(`A01…`) and Tradeoffs (`T01…`) below are inherited downward by every subsystem.

## Context

- The binding wraps the Restate TypeScript SDK family (`@restatedev/restate-sdk`
  and siblings, v1.14.x) against a `restate-server` (≥1.6, see A10). It is
  Effect-native (`effect` ^3.21), so all behavior is expressed as Effects,
  Schemas, Layers, and Scopes.
- The design is fixed by nineteen accepted decision records,
  [0001](./.decisions/0001-thin-faithful-restate-binding.md)–[0019](./.decisions/0019-shared-ssot-helpers.md);
  the requirements (here + per subsystem) state the testable constraints those
  decisions imply. Where a requirement traces to a decision, the decision is
  cited.

## Assumptions

- **A01 Restate is the engine:** The `restate-server` owns the Journal, State,
  timers, retries, and Replay. The binding implements no durable-execution
  runtime of its own. (See [.decisions/0001](./.decisions/0001-thin-faithful-restate-binding.md).)
- **A02 SDK boundary shape:** A Restate handler is `(ctx, input) => Promise<O>`,
  invoked by the SDK; the per-invocation `ctx` carries the Journal, State, and
  key. The Effect runtime boundary therefore sits inside each handler body, not
  above the server.
- **A03 Single serde seam:** A Restate `Serde<T>` governs every Restate-managed
  value of type `T` (handler I/O, State, `ctx.run` results, awakeable payloads,
  durable promises, ingress). Its `serialize`/`deserialize` are synchronous over
  `Uint8Array`.
- **A04 Determinism contract:** Replay requires the same sequence of `ctx.*`
  operations in the same order. Nondeterminism (time, randomness, I/O) is only
  safe when funneled through `ctx` so its result is journaled. A journal mismatch
  is server error `RT0016`.
- **A05 Error duality:** Restate retries every thrown error except
  `TerminalError` (no retry, propagate to caller, trigger compensation). A
  suspension is not a failure (`isSuspendedError`).
- **A06 Standard Schema availability:** Effect `Schema` exposes JSON encode/decode
  and JSON Schema generation, which is sufficient to build the serde and the
  discovery payload over a JSON wire.
- **A07 Native server binary:** A native `restate-server` binary is available on
  `$PATH` (packaged via `nix/restate.nix`) for the testing harness and CI,
  without Docker.
- **A08 node-h2c target:** v1 targets a long-lived Node HTTP/2-cleartext (h2c)
  endpoint. Serverless targets (Lambda, fetch, Cloudflare Workers) are out of
  scope for v1.
- **A09 OTel opt-in:** The OpenTelemetry bridge and its dependencies
  (`@effect/opentelemetry`, `@restatedev/restate-sdk-opentelemetry`) are an
  opt-in subpath; the core stays dependency-light.
- **A10 Server floor ≥1.6:** The binding targets `restate-server` ≥1.6
  (`nix/restate.nix` pins 1.7.9). Features that need ≥1.6 (e.g. the
  `metadata._tag` best-effort extra on terminal errors) assume this floor.
- **A11 Deployment immutability:** A `Deployment` is immutable and versioned; the
  `restate-server` owns deployment versioning and the replay/upgrade contract
  (A01). The binding registers deployments and may serve multiple versions but
  does not manage version routing itself.

## Acceptable Tradeoffs

- **T01 Restate coupling over engine portability:** Handler code is coupled to
  Restate's model and vocabulary; there is no engine portability. Mechanical
  sympathy with the engine is worth more than a vendor-neutral abstraction. (See
  [.decisions/0001](./.decisions/0001-thin-faithful-restate-binding.md).)
- **T02 Explicit durable waits over a transparent remap:** Durable waits are
  named combinators (`Restate.sleep` / `Restate.timeout` / `Restate.race`), not a
  transparent `Clock.sleep → ctx.sleep` global remap. A bare in-handler
  `Effect.sleep` stays non-durable. This costs a deliberate choice at the wait
  site but avoids `Effect.timeout` suspending/interleaving nondeterministically
  and avoids library/AppLayer code silently journaling durable timers. (See
  [.decisions/0004](./.decisions/0004-determinism-layer.md).)
- **T03 Contract/impl ceremony over client-bundle pollution:** A service is
  authored as a separate `contract` and `implement`, adding ceremony for a
  trivial single-package service, to keep client bundles free of server code and
  dependencies. (See [.decisions/0010](./.decisions/0010-separated-contract-impl.md).)
- **T04 Explicit concurrency combinators over raw fibers:** Concurrency over
  durable operations must use `Restate.all` / `race` / `any`, not raw
  `Effect.fork` / concurrent `Effect.all`, trading some Effect ergonomics for
  deterministic journal ordering. (See [.decisions/0005](./.decisions/0005-deterministic-concurrency.md).)
- **T05 Internal type machinery over an untyped surface:** Encoding the
  capability hierarchy and preserving typed handler maps requires non-trivial
  internal generics; the cost is contained inside the builders so the authoring
  and calling surfaces stay clean. (See
  [.decisions/0002](./.decisions/0002-typed-capability-contexts.md),
  [.decisions/0008](./.decisions/0008-typed-client-inference.md).)
- **T06 Shared error Schema for typed cross-wire transport:** Decoding a terminal
  error back into its tagged form requires both sides to share the error Schema
  (natural within a codebase); cross-language callers get the encoded JSON body
  plus the `_tag` only. (See [.decisions/0003](./.decisions/0003-error-boundary-model.md).)
- **T07 Journal-shape sensitivity to refactors:** The determinism layer increases
  the journal's sensitivity to ordinary Effect refactors — reordering durable ops,
  adding/removing a `Restate.run`, or changing combinator order alters the journal
  shape and is a redeploy/replay hazard the lint does NOT catch. The mitigation is
  the testing harness's multi-deployment replay/upgrade tests (R26a, R26c), not a
  static guarantee. (A11; [.decisions/0004](./.decisions/0004-determinism-layer.md).)
- **T08 Annotation as single source over call-site options:** Restate facts that
  belong to a Schema (retryable/terminal, custom serde, idempotency key) are
  carried as Schema annotations read at one site, dropping the equivalent
  call-site option (e.g. the `{ idempotencyKey }` send option). This removes drift
  at the cost of a one-time migration of those options onto the schema. (See
  [.decisions/0011](./.decisions/0011-restate-schema-annotations.md).)

## Requirements

The remaining requirements are distributed across the subsystem dirs, each
keeping its GLOBAL ID. The cross-cutting "faithful binding" stance lives here;
everything else lives with the subsystem that owns it (see the
[spec.md](./spec.md) index).

### Must be a faithful Restate binding

- **R01 Restate-native surface:** The binding MUST expose Restate's own
  constructs and durable primitives — Services, Virtual Objects, Workflows,
  `ctx.run`, durable sleep, awakeables, durable promises, keyed State,
  service-to-service calls/sends — each as an Effect-returning combinator using
  Restate's vocabulary. (Vision; [.decisions/0001](./.decisions/0001-thin-faithful-restate-binding.md).)
- **R02 No competing engine dependency:** The binding MUST NOT depend on
  `@effect/cluster` or `@effect/workflow` as a durable engine, and MUST NOT
  introduce a pluggable-engine abstraction over Restate. (Vision.)
- **R03 Avoidable external dependencies:** The core MUST keep its dependency
  surface to the Restate SDK family and `effect`; OTel dependencies MUST be
  reachable only through the opt-in subpath. (A09.)

### Distributed to subsystems

| Subsystem                                                  | Requirements                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [01-authoring](./01-authoring/requirements.md)             | R04, R05, R06, R09, R30, R34, R35, R36                                                |
| [02-schema-serde](./02-schema-serde/requirements.md)       | R07, R08                                                                              |
| [03-effect-runtime](./03-effect-runtime/requirements.md)   | R17, R18, R19, R20, R37                                                               |
| [04-error-boundary](./04-error-boundary/requirements.md)   | R11, R12, R13, R14, R15, R16, R21, R22, R31                                           |
| [05-clients](./05-clients/requirements.md)                 | R10, R32, R33                                                                         |
| [06-scheduling](./06-scheduling/requirements.md)           | (role-only; traces [.decisions/0012](./.decisions/0012-self-reschedule.md), R10/R32)  |
| [07-endpoint-deploy](./07-endpoint-deploy/requirements.md) | R29, R38, R39, R40                                                                    |
| [08-observability](./08-observability/requirements.md)     | R23, R23b, R24, R25                                                                   |
| [09-testing](./09-testing/requirements.md)                 | R26, R26a, R26b, R26c, R26d, R26e, R27, R28                                           |
| [10-admin](./10-admin/requirements.md)                     | (role-only; traces [.decisions/0018](./.decisions/0018-admin-management-api.md), R31) |
