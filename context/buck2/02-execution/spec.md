# Execution Spec

This document specifies platforms, providers, containment, and per-language
action mechanics. It builds on [requirements.md](./requirements.md).

## Status

Draft.

## Scope

**Defines:** configured platform identity, exact tool-closure providers,
platform sandboxes, stage zero, and TypeScript and Rust action shapes.

**Does not define:** dependency-store construction (03), cache transport (04),
or product import (06).

## Platforms

| Product platform label            | Execution platform label               | OS     | Architecture | ABI    | Native executable contract |
| --------------------------------- | -------------------------------------- | ------ | ------------ | ------ | -------------------------- |
| `//buck2/platforms:linux_x86_64`  | `//buck2/platforms:exec_linux_x86_64`  | linux  | x86_64       | glibc  | `elf-dynamic/v1`           |
| `//buck2/platforms:linux_aarch64` | `//buck2/platforms:exec_linux_aarch64` | linux  | aarch64      | glibc  | `elf-dynamic/v1`           |
| `//buck2/platforms:macos_aarch64` | `//buck2/platforms:exec_macos_aarch64` | darwin | aarch64      | darwin | `mach-o-dynamic/v1`        |

The canonical hub owns these labels. Host detection may select a declared tuple
for an interactive alias, but action and product identity use the configured
tuple and import never infers one.

## Executable Providers

```text
BuckSupportToolInfo {
  toolId, contentDigest, executable, executableStorePath,
  closureIdentity, closureStorePaths,
  protocol, executionPlatform, runtimeContract
}
```

Capability projection atomically publishes a complete immutable generation
under `.buck2/capabilities/`. Each action receives the executable and every
runtime path in `closureStorePaths`; the sandbox exposes those paths read-only
and no other store path. Toolchain paths in action commands are normalized
`/nix/store` paths. A missing path or stale generation fails before execution.
`local_only` selects placement but does not disable shared action-cache reads or
uploads. True remote execution requires a separately proven portable closure
and remains disabled.

## Sandboxed Action Boundary

The runner creates a metadata-only execution overlay in `BUCK_SCRATCH_PATH`:
symlinks project declared package files and the normalized dependency view into
one package-relative namespace, and links the configured `outDir` to the Buck
declared output. It copies no source or dependency bytes. On both platforms the
launcher clears the inherited environment and sets only the explicit
operation allowlist. The overlay and other temporary state remain scratch; only
declared result bytes leave the action.

On Linux the runner invokes exact Nix-provided Bubblewrap with fresh user,
mount, PID, IPC, network, UTS, and cgroup namespaces. It exposes a minimal
`/proc`, `/dev`, and a temporary directory; mounts declared inputs and exact
tool closures read-only; and mounts only declared outputs and scratch writable.

On Darwin the runner invokes the fixed system `sandbox-exec` as a declared OS
capability with a parameterized Seatbelt profile. Canonical input, output,
scratch, and each tool-closure path are passed as profile parameters. Reads are
allowed only for input and tool roots; writes only for output and scratch; and
network is denied.
Seatbelt is deprecated despite remaining available on supported macOS releases.
The Darwin smoke gate therefore runs inside the pinned Buck action on every OS
upgrade before that release becomes an admitted executor; disappearance or
semantic drift blocks the upgrade rather than silently weakening containment.

Containment tests assert allowed reads/writes as well as denied undeclared
repository, host, store, and network access. A denial may be ignored by a tool,
so the gate uses explicit negative probes; it does not infer containment merely
from the tool's exit status.

## TypeScript Actions

```text
PnpmPackageViewInfo + declared package sources + workspace dist entries
  -> metadata-only scratch overlay
  -> platform sandbox
  -> pinned tsgo
  -> TypecheckInfo verdict | TypeScriptDistInfo { js, d.ts, maps }
```

Workspace packages are consumed through their manifest-declared `dist`
boundary. A production action has no source fallback. Typecheck runs with
`--noEmit`; emit writes directly through the overlay's `dist` link to the
Buck-declared output. Incremental compilation is disabled and any unavoidable
build-info path is redirected to scratch, so `.tsbuildinfo` never enters a dist
or cache upload. JavaScript, declarations, and maps must remain byte-identical
across equivalent unsandboxed controls and both platform sandboxes.

The normalized importer dependency view and scratch overlay are metadata-only
and are not returned as outputs. The package execution view materializes only
package-owned sources/workspace dist boundaries, never a dependency closure.
Typecheck returns a slim verdict; emit returns only the declared dist. No
action hashes, copies, recursively chmods, or retains a private dependency tree
to enforce immutability: the sandbox enforces it.

## Darwin Capability

The Apple SDK and compiler tools are executor-local exact Nix capabilities,
not CAS inputs. Seatbelt is separately bound to the execution platform's macOS
version and fixed system path. Preflight fails before Buck when a required
tool, closure, SDK root, or Seatbelt capability is absent. Compilation sets an
invalid `DEVELOPER_DIR` so Xcode and
`xcrun` cannot become fallbacks; inspection binds Nix cctools and sigtool.
Native execution remains the proof that an ad-hoc signature is accepted.

## Rust Actions

Authored `Cargo.toml` is the request authority; workspace binding follows
rust-cargo decisions 0017–0019. Rust admission converges through the same
provider, platform, and sandbox contracts. Complete-lock Nix vendoring remains
the transitional packaging boundary until products cross the bridge.

## Action Lifecycle

```text
ConfiguredOperation
  -> validate typed payload, declared providers, and exact closures
  -> build metadata-only scratch overlay
  -> execute inside the platform sandbox
  -> validate declared outputs or semantic verdict
  -> return typed provider + native Buck result
```

| Operation kind | Required provider data                                           |
| -------------- | ---------------------------------------------------------------- |
| Check or lint  | semantic verdict, tool identity, configured operation identity   |
| Test           | semantic verdict, structured test summary, declared test outputs |
| Compilation    | declared output roles and content identities                     |
| Product        | `BuildProduct` descriptor path and payload path                  |
