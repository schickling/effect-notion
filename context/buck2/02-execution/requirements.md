# Execution Requirements

This subsystem owns platforms, toolchains, sandboxing, and admitted action
semantics for every language. It refines BUCK-R02 and BUCK-R04.

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
  configuration hash ([05-composition](../05-composition/requirements.md)).
- **EXEC-R02 Exact tool closures:** Every executable provider binds the exact
  executable and its complete immutable runtime closure, protocol, and
  execution-platform compatibility through normalized `/nix/store` paths.
  Per-worktree paths and ambient `PATH` discovery are forbidden.
- **EXEC-R03 No ambient discovery:** Missing or incompatible providers fail
  closed without selecting an undeclared host tool or legacy producer.
- **EXEC-R04 Narrow invalidation:** A tool, closure, or platform change
  invalidates exactly the actions consuming the changed identity.
- **EXEC-R05 Darwin capability split:** Darwin compilation, linking, signing,
  and inspection use exact Nix-provided tool closures. Seatbelt is a declared
  execution-platform/OS capability invoked at its fixed system path and bound
  to the admitted macOS version; no other Xcode, `xcrun`, or ambient system
  tool discovery is allowed.

### Actions and containment

- **EXEC-R06 Declared capability boundary:** An action sees only declared
  sources, dependency views, exact tool closures, configuration, platforms,
  and policy. Inputs and tools are read-only; only declared outputs and
  `BUCK_SCRATCH_PATH` are writable; undeclared filesystem paths and network
  are unavailable; the environment is an explicit allowlist.
- **EXEC-R07 Required native sandboxes:** TypeScript actions use Bubblewrap on
  Linux and a parameterized Seatbelt profile on Darwin. Both implementations
  must pass their platform smoke gate before the authority cutover. Seatbelt's
  public interface is deprecated, so every supported macOS upgrade re-runs the
  Darwin gate before that OS is admitted.
- **EXEC-R08 Deterministic contract:** Equal configured input produces
  byte-identical JavaScript, declaration, and source-map outputs and an equal
  semantic verdict. TypeScript build-info is disabled or redirected to scratch;
  `.tsbuildinfo` is not a declared or published output.
- **EXEC-R09 No live effects:** An action must not install against live state,
  publish, deploy, activate, or mutate anything outside its declared output
  and scratch boundaries.
- **EXEC-R10 Typed results:** Results expose typed providers; stdout and stderr
  remain diagnostic streams, never the verdict protocol. Tool failure,
  malformed output, missing output, and platform incompatibility remain
  distinguishable. A denied undeclared read is containment evidence; it is not
  required to make a tool exit nonzero unless that read is needed for the
  declared operation or an explicit negative probe asserts it.

### Transfer

- **EXEC-R11 Parity at transfer:** Authority transfer for an operation tuple
  proves semantic parity, a representative failure, positive declared access,
  negative undeclared filesystem and network access, environment filtering,
  relevant/irrelevant mutation controls, and byte-stable outputs on Linux and
  Darwin (BUCK-R12). After transfer, normal developer and CI surfaces delegate
  to Buck and the prior producer is deleted (BUCK-R09).
