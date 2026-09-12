# Execution Spec

This document specifies platforms, providers, and per-language action
mechanics. It builds on [requirements.md](./requirements.md).

## Status

Draft.

## Scope

**Defines:** configured platform identity, executable providers, stage zero,
and the TypeScript and Rust action shapes.

**Does not define:** dependency materialization (03), cache transport (04), or
product import (06).

## Platforms

| Product platform label            | Execution platform label               | OS     | Architecture | ABI    | Native executable contract |
| --------------------------------- | -------------------------------------- | ------ | ------------ | ------ | -------------------------- |
| `//buck2/platforms:linux_x86_64`  | `//buck2/platforms:exec_linux_x86_64`  | linux  | x86_64       | glibc  | `elf-dynamic/v1`           |
| `//buck2/platforms:linux_aarch64` | `//buck2/platforms:exec_linux_aarch64` | linux  | aarch64      | glibc  | `elf-dynamic/v1`           |
| `//buck2/platforms:macos_aarch64` | `//buck2/platforms:exec_macos_aarch64` | darwin | aarch64      | darwin | `mach-o-dynamic/v1`        |

Platform targets live in one canonical cell present in every composition
(effect-utils as the hub), so the same labels resolve everywhere
(EXEC-R01). Host detection may select among declared tuples for an interactive
alias; the configured tuple becomes part of action and evidence identity and is
never inferred during import. The `build_product` macro requires the intended
product platform explicitly and compares all resolved platform fields against
`ProductExecutableInfo` before packaging — a checked join, not a second
platform authority.

## Executable Providers

```text
BuckSupportToolInfo {
  toolId, contentDigest, executable, executableStorePath,
  closureIdentity, protocol, executionPlatform, runtimeContract
}
```

Provider descriptors are data read before execution; they never permit actions
to evaluate Nix. Devenv preparation projects exact files under the stable
`.buck2/capabilities/` cell in complete immutable generations; the
authoritative `defs.bzl` is atomically replaced only after a generation is
complete, and a missing or stale projection fails closed. Actions using
executor-local projected tools are explicitly local-only. Toolchain
executables referenced in action command lines are `/nix/store` paths
(EXEC-R02).

`local-only` constrains execution placement; it does not disable shared action
cache reads or writes. For an admitted local action, the canonical
`/nix/store` realization path participates in the action key and binds the
immutable local tool identity; the typed provider also binds protocol, runtime
requirements, and exact execution-platform compatibility. Stage-zero
capability descriptors additionally record explicit content and closure
identities. The executable remains executor-local and is not transported
through the Buck CAS.

Remote execution requires the portable archive or execution-image contract
from dependency-materialization
[decision 0006](../../dependency-materialization/05-buck2-evidence/.decisions/0006-nix-exported-buck-toolchains.md);
shared-cache reuse of a local action does not imply that contract has been met.

A stage-zero provider binds an exact Nix realization identity, executable,
protocol, and execution-platform constraint; a negative test proves an
undeclared ambient copy is ignored; a graph-built replacement retires it
(EXEC-T01).

## Darwin Capability

The Apple SDK is an executor-local Nix capability referenced by the compiler
environment, not a Buck dependency or CAS input. Preflight fails before Buck
when any exact tool or SDK root is absent. Compilation sets an invalid
`DEVELOPER_DIR` deliberately so Xcode and `xcrun` cannot become an implicit
fallback; inspection binds Nix cctools and sigtool identities. Native
execution remains the proof that an ad-hoc signature is accepted by macOS.

## TypeScript Actions

The typecheck/build action stages package sources plus its materialized
`node_modules` (03), then runs `tsgo` from a toolchain target. Prototype
evidence
([.experiments/2026-08-25-tsgo-rule-prototype.md](./.experiments/2026-08-25-tsgo-rule-prototype.md)):
a ~40-line rule checks real tui-core with negligible overhead — cold 0.58 s
including hashing a 104 MB closure, warm no-op 14 ms, single-file invalidation
75 ms via watchman. Materialized closures must contain no dangling symlinks
(pnpm's platform-excluded optional-dep aliases are pruned at materialization).
Workspace sibling sources enter as declared inputs of the dependent's check
(live-link model, 03). Output contract: a slim verdict/dist artifact, not the
staged tree, for cache-upload economics.

## Rust Actions

Authored `Cargo.toml` is the request authority; workspace binding follows the
rust-cargo decisions (0017–0019). Third-party source supply and product ordering
follow [decision 0023](../.decisions/0023-buck-fetched-rust-crates.md) and
[decision 0024](../.decisions/0024-rust-workspace-before-product-proof.md).
Rust admission converges through the same provider and platform contracts;
complete-lock Nix vendoring remains the transitional packaging boundary until
products cross the bridge (BUCK-R10, roadmap Phase 5).

## Action Lifecycle

```text
ConfiguredOperation
  -> validate typed payload and declared providers
  -> execute tool without ambient discovery
  -> validate declared outputs or semantic verdict
  -> return typed provider + native Buck result
```

| Operation kind | Required provider data                                           |
| -------------- | ---------------------------------------------------------------- |
| Check or lint  | semantic verdict, tool identity, configured operation identity   |
| Test           | semantic verdict, structured test summary, declared test outputs |
| Compilation    | declared output roles and content identities                     |
| Product        | `BuildProduct` descriptor path and payload path                  |
