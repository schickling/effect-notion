# Shutdown flush contract

## Status

accepted

## Context

`runTuiMain` CLIs need both reliable final OTLP export and fast exit. The Effect
OTLP exporter already flushes as a scope finalizer on natural exit, so correctness
does not require a fixed sleep. The failure mode was setting
`shutdownTimeout` below one collector round-trip, which interrupted the final
export and silently dropped telemetry. Separately, the process exit code has to
survive a signal: an interrupt must not be reported as success.

## Decision

- Natural exit awaits the exporter finalizer and adds no fixed delay.
- `shutdownTimeout` is a ceiling for slow or black-holed collectors, never a
  floor. Defaults are 30s non-interactive and 10s interactive; CLIs should not
  override this with tiny values.
- Ctrl-C remains interruptible and exits quickly even during a slow flush.
- Signal exit preserves code 130; uncaught failures map to 1 and success to 0.
  The code is derived from the fiber `Exit` only (`runTuiMain` leaves an
  interrupt in the error channel; its `teardown` delegates to
  `Runtime.defaultTeardown`). The mutable global `process.exitCode` is never an
  input to the interrupt/failure decision — it is read only to forward an
  app-level code on the success path, which is `createTuiApp`'s `exitCode`
  channel.

## Consequences

- Healthy collectors add only their round-trip latency.
- Dead collectors can delay natural exit up to the cap, while Ctrl-C still bails
  quickly.
- Mid-run exporter self-disable remains out of scope; `shutdownTimeout` is not a
  retry policy.
