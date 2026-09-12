# Execution Requirements

This subsystem owns platforms, toolchains, and admitted action semantics for
every language. It refines BUCK-R02 and BUCK-R04, merging the former
execution-platforms and target-execution subsystems.

## Assumptions

- **EXEC-A01 Input authority:** Reviewed pins name immutable executables and
  data used by Buck; Nix may independently verify and consume the same bytes.
- **EXEC-A02 Distinct platforms:** Target and execution platforms are
  independent compatibility dimensions.
- **EXEC-A03 Native result:** Buck's action result and native evidence are
  authoritative for execution.

## Acceptable Tradeoffs

- **EXEC-T01 Finite stage zero:** A minimal support tool may begin as an exact
  Nix-produced provider outside the graph; once the graph reproduces the same
  contract, consumers move to the graph-built provider and the bootstrap
  provider is removed
  ([decision 0010](../.decisions/0010-admit-rust-stage-zero-support-tools.md)).
- **EXEC-T02 Ecosystem executors:** Languages may use distinct typed executor
  payloads implementing the same action lifecycle.

## Requirements

### Platforms and tools

- **EXEC-R01 Configured platforms:** Every admitted action selects an explicit
  target platform and execution platform. Platform labels are canonical and
  shared across composition shapes: the label, not its content, enters the
  configuration hash ([decision 0003](../.decisions/0003-platform-proof-and-rust-convergence.md)).
- **EXEC-R02 Exact tools from the store:** Every executable provider binds tool
  bytes, protocol, runtime requirements, and execution-platform compatibility,
  and resolves through `/nix/store` paths. Per-worktree tool paths are
  forbidden: they enter action command lines and split cache keys
  ([decision 0009](../.decisions/0009-admitted-prelude-live-origin.md);
  [decision 0029](../.decisions/0029-official-go-release-toolchain.md)).
- **EXEC-R03 No ambient discovery:** An action must not discover an
  authoritative executable through `PATH`, shell startup, or mutable host
  state; missing or incompatible providers fail closed without selecting a
  legacy producer.
- **EXEC-R04 Narrow invalidation:** A tool or platform change invalidates
  exactly the actions consuming the changed identity.
- **EXEC-R05 Nix-owned Darwin capability:** Darwin compilation, linking,
  signing, and inspection use exact Nix-provided Rust, LLVM, cctools, Apple
  SDK, and sigtool identities; actions must not discover Xcode, `xcrun`, or
  `/usr/bin` tools.

### Actions

- **EXEC-R06 Declared closure:** An action receives only declared sources,
  dependency closure, configuration, tools, platforms, and policy.
- **EXEC-R07 Deterministic contract:** Equal configured input produces equal
  declared output where an artifact is promised, and an equal semantic verdict
  for checks and tests
  ([decision 0026](../.decisions/0026-buck-owned-unit-tests.md)).
- **EXEC-R08 No live effects:** An action must not install against live state,
  publish, deploy, activate, or mutate anything outside its declared output
  boundary.
- **EXEC-R09 Typed results:** Results expose typed providers; stdout and
  stderr remain diagnostic streams, never the verdict protocol. Tool failure,
  malformed output, missing declared output, and platform incompatibility stay
  distinguishable.

### Transfer

- **EXEC-R10 Parity at transfer:** Authority transfer for an operation tuple
  proves semantic parity against the existing producer, a representative
  failure, an undeclared-access failure, and relevant/irrelevant mutation
  controls (BUCK-R12); after transfer, normal developer and CI surfaces
  delegate to Buck and the prior producer is deleted (BUCK-R09).
  Foundation changes and product joins remain independently reviewable
  ([decision 0007](../.decisions/0007-sibling-foundations-and-product-joins.md)).
