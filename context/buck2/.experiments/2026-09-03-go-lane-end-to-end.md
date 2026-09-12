# Go Lane End to End: A Real Service Binary from Buck2

Date: 2026-09-03 — Host: dev3 (x86_64-linux, 6+ concurrent agents) — Buck2 pin
`unstable-2026-08-22` with the bundled prelude, nixpkgs `go-1.26.5`, isolation
dir `golane`.

## Question

Can a consumer cell build a real Go service — 3 direct and 28 indirect module
requirements, deployed as a system service today by `buildGoModule` with a
`vendorHash` fixed-output derivation — from Buck2, with the module supply
content-addressed per module rather than behind an FOD, and does the resulting
binary satisfy a runtime contract the Nix importer already admits?

## Method

A composed scratch root (cells `workspace`/`prelude`/`effect_utils`/`dotfiles`,
hub mounted by `cp -a`, capabilities projected by mr's resolver only) on top of
the hub-toolchain change. The hub gained a `go` `ToolchainAuthority`, the two
toolchain rules, the root `toolchain_alias`es, and `buck2/go/defs.bzl`. The
consumer cell was a copy of the service's source tree with its `default.nix`,
`flake.nix` and `flake.lock` removed.

1. A generator read `go.mod`/`go.sum`, ran `go mod vendor` in a temp copy with
   `GOPROXY=https://proxy.golang.org` and `GOSUMDB=sum.golang.org` so Go itself
   authenticated every module, then for each module in the resulting
   `vendor/modules.txt` fetched the proxy zip independently over HTTPS and
   refused to emit unless its sha256 matched the `go.sum`-verified module-cache
   zip.
2. `go_vendored_binary` assembled the 31 archives into `vendor/` beside the
   first-party sources with the generated `modules.txt` and ran one
   `go build -mod=vendor -trimpath -tags netgo -ldflags "-s -w"` with
   `CGO_ENABLED=0`, `GOTOOLCHAIN=local`, `GOPROXY=off`.
3. Cross-root: the tree was tarred without `buck-out` into a second, longer
   absolute path; fresh daemon; same build.
4. Runtime contract: the artifact-scan script was built from the repository's
   own `nix/workspace-tools/lib/buck2-artifact-scan.nix` and run against staged
   trees containing the product built with the Nix-realized Go and, separately,
   with the official `go1.26.5` distribution.
5. Two prelude-native probes: a dependency-free `go_binary`, and a `go_library`
   whose `srcs` are sub-targets of a hash-pinned module zip.

## Result

| measurement                          | value                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| cold build, empty `buck-out`         | 9.8 s, `Commands: 32 (cached: 0, remote: 0, local: 32)`, 22 MiB fetched, BUILD SUCCEEDED                   |
| no-op                                | 0.089 s, 0 commands                                                                                        |
| one-file edit                        | `Commands: 1`, 10.7 s at low host load and 26.6 s at high load — always a full recompile of all 31 modules |
| one-file edit, scratch dir wiped     | 27.2 s — no hidden warm `GOCACHE`; the lane is hermetic                                                    |
| binary                               | 15,990,946 B, `statically linked`, stripped, no `PT_INTERP`, no `DT_NEEDED`; runs under `env -i`           |
| `buildGoModule` comparator           | 15,999,256 B, `dynamically linked` against a store glibc, 4 store references, 56,559,176 B closure         |
| cross-root reuse                     | `Commands: 32 (cached: 32, remote: 0, local: 0)`, 100 % hits, artifact `sha256 074aac42…` identical        |
| pin generation, 31 modules           | 4.8 s; all 31 proxy zips byte-identical to the `go.sum`-authenticated cache zips                           |
| capability projection with `go`      | 21.7 s warm, 21 tool ids                                                                                   |
| `buck2-artifact-scan` (Nix Go)       | rc=1, `forbidden Nix store reference in bin/runner-scaler`                                                 |
| `buck2-artifact-scan` (official Go)  | rc=0                                                                                                       |
| prelude `go_binary`, no deps         | 415 actions, 22.9 s cold — the complete per-package stdlib — runs                                          |
| prelude `go_library` from an archive | 6 actions, 2.3 s on a warm stdlib — runs, correct output                                                   |
| GOROOT materialization               | 250 MB per configuration; 2 configurations present in the probe root                                       |

The three store references in the product are `tzdata`, `mailcap` and
`iana-etc`, and they come from nixpkgs' patches to Go's own standard library
(`mime/type_unix.go`, `time/zoneinfo_unix.go`, `net/{port,lookup}_unix.go`), not
from the build. The `buildGoModule` comparator carries the same three plus
glibc, which the static link drops. Building the identical target with the
official distribution leaves exactly one `/nix/store` string — the service's own
`DiskPressurePath` default, which has no trailing slash and is program data —
and the scan passes.

## Conclusion

The Go lane works end to end and the module supply is content-addressed with no
fixed-output derivation anywhere. Cross-root reuse is total and the artifact is
reproducible byte-for-byte, so the shared cache serves Go the way it serves
Rust.

Three results change the plan rather than confirming it. Prelude's Go rules
accept module-archive sub-targets as `srcs`, so the per-package graph needs no
vendor tree and no lock→BUCK translator beyond a file-list generator — that is a
cheaper long-term shape than the `go build` wrapper this experiment shipped, and
both are proven. `elf-static/v1` covers Go on Linux with zero added lines, which
makes the second consumer of that contract free and strengthens the case for one
Linux runtime contract rather than two. And the Go toolchain is the first
capability that cannot be `pkgs.<lang>` unmodified, because its stdlib patches
put store paths into every product it compiles; that question is now settled by
[decision 0029](../.decisions/0029-official-go-release-toolchain.md) in favour of
the official release archive, pinned per platform by the `sha256` go.dev
publishes.

Two hub gaps surfaced and neither is Go-specific: the `cxx` toolchain declares no
assembler, so any cgo-enabled Go package (and any Rust crate with `.S` sources)
fails analysis with `Could not find compiler for extension '.S'`; and
`http_archive` on a `.zip` shells out to `unzip` from the ambient PATH, which
only the Go lane exercises because the module proxy serves nothing else.

## VRS Impact

- [decision 0029](../.decisions/0029-official-go-release-toolchain.md) settles
  the Go toolchain source in favour of the official release archive.
- `02-execution` gains no new requirement: `elf-static/v1` covers Go on Linux
  unchanged, so the runtime contract stays singular.
- Two hub gaps are recorded as work, not as requirements: the `cxx` toolchain
  declares no assembler, and `http_archive` on `.zip` depends on ambient
  `unzip` (BUCK-R04 hermeticity is violated on that path until fixed).
