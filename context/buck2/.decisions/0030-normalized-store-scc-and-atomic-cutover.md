# 0030 Normalized Store, SCC Isolation, And Atomic Cutover

Status: accepted

## Context

Ratified by Johannes on 2026-09-04 while resolving issue #1212. The existing
pipeline copied a dependency closure into an importer tree, copied it again
into each package tree, and staged it again for emit. A dev3 run of PR #1209
was stopped after exceeding 30 minutes while still running and after reaching
at least 24 GB. Filesystem CoW could improve some hosts but could not make
per-consumer dependency-closure duplication correct or portable.

Three interview choices remained after the probes: whether to normalize the
whole admitted store now or migrate importer by importer; how to represent real
lockfile cycles; and whether to make staged prerequisites visible through mixed
production modes or preserve one authority boundary.

## Evidence and Argument

The 2026-09-04 probes established:

- a closure-free tui-react consumer layer reduced 2.14 GB to 2.4 MB;
  typecheck fell from 70.76 s to 0.76 s and emit from 62.18 s to 0.84 s; all 12
  then-green packages completed typecheck and emit in 16.46 s;
- a 17-package normalized graph restored 416/416 cacheable commands with zero
  local execution, occupied 736 MiB, and reduced its consumer layer from
  5.72 GiB/410,714 entries to 7.38 MB/1,243 entries;
- only nine direct-dependency entries vary by platform; tarballs and views do
  not. Five real multi-member SCCs exist repo-wide; the 17-package closure
  exercised four and the fifth was lock-analyzed only;
- a byte-materialized editor snapshot remained complete after deletion of all
  backing artifacts;
- direct Darwin probes proved filesystem, network, environment, and write
  controls. Nested pinned-Buck actions proved byte-identical outputs on Linux
  and mbp2021 plus denial of a required undeclared import;
- no repository consumer uses `.tsbuildinfo`; JavaScript, declarations, and
  maps are the durable TypeScript output boundary.

## Options

| Interview choice     | Selected                                                                                       | Alternatives rejected                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Migration unit       | Normalize the complete admitted per-package pnpm store now                                     | Per-importer migration retains duplicate mechanisms and delays the economic invariant                                                                              |
| Cycles               | One sandboxed assembly action per each of the five real SCCs, with distinct member namespaces  | Flatten members (path collisions and lost identity); source-level cycle breaking (changes package semantics); full importer assembly (restores per-consumer bytes) |
| Authority transition | Staged dependent PRs followed by one atomic final flip after all 17 packages are dist-servable | Mixed production source/dist fallback (two authorities); one monolithic prerequisite PR (unreviewable and hard to bisect)                                          |

## Decision

The admitted JavaScript dependency graph moves to one normalized per-package
pnpm store. Registry tarball extraction is shared across platforms. Each
acyclic peer-resolved store entry copies its own package tree under
`node_modules/<name>` so realpath preserves sibling dependency links; its
dependency edges and importer views are metadata symlinks. Exactly nine entries
with platform-selected edges have one distinct configured entry artifact and
own-package materialization per selected variant. All other entries are
platform-invariant, archive/extract bytes remain shared, and workspace/dist
entries and package execution views own only their small package boundary.

Each of the five real SCCs is assembled once in its platform sandbox. Members
retain distinct pnpm virtual-store namespaces, and consumers reference member
providers backed by the group rather than copying the group.

TypeScript actions build a metadata-only scratch overlay and execute with exact
tool closures: Bubblewrap on Linux, parameterized Seatbelt on Darwin, read-only
inputs, writable declared outputs and scratch, no undeclared filesystem or
network capability, and an environment allowlist. Seatbelt is deprecated, so a
supported macOS upgrade must pass an in-Buck smoke gate before admission. The
sandbox proves denial with explicit probes; an incidental undeclared read is
not assumed to make an arbitrary tool exit nonzero.

TypeScript writes JavaScript, declarations, and maps directly to the declared
output. Incremental build-info is disabled or scratch-only and never published.
The editor additionally receives a byte-owned atomic snapshot so it survives
backing-artifact deletion.

Prerequisites land as dependent PRs without changing production authority. The
single final authority change requires all 17 #1209 packages to be dist-servable
with no source fallback; both platform sandbox gates; editor deletion survival;
deterministic output bytes; cache-only upload/restore; a built fifth SCC; and an
accepted numeric cold wall/disk/staging/admission-slope envelope proven by the
full candidate namespace E2E. Raising timeout or disk alone cannot satisfy the
gate. The change then flips every consumer and deletes the old producer
atomically.

Cache uploads are enabled for cacheable outputs. True remote execution remains
disabled until a real remote backend separately proves tool-closure delivery,
sandboxing, path independence, and output identity.

## Consequences

- Decision 0025's reflink-first importer/package assembly is superseded; its
  mutable-hardlink warning remains valid. The normalized-store cutover delta
  remains open until implementation matches this decision.
- Cache-only restore is necessary but does not settle CI runner connectivity or
  true remote execution.
- The cold lane, peak disk/scratch, staging/action p95, and marginal admission
  slope become numeric admission gates alongside warm-cache latency.
- Vision criterion 9 still prescribes CoW assembly. Because `vision.md` is
  human-owned, the mismatch is recorded as an open root delta rather than
  silently editing the vision.

## Amendment 1: Whole-Repository Cutover, Ten Variants, Watch Loop

Date: 2026-09-04. Status: accepted. Ratified by Johannes while implementing
issue #1212 after PRs #1209 and #1213 were integrated: q4 selected
whole-repository migration with root-install deletion over a per-consumer
migration, and selected a Buck-watch plus atomic editor-snapshot development
loop over a manual refresh command. The original Decision is not rewritten; the
following items supersede or extend it.

### 1. Ten platform-selected entries, derived not asserted

"Exactly nine entries with platform-selected edges" is superseded by ten. Nine
was the count inside the 17-package #1209 closure that the 2026-09-04 probe
built; it was never a whole-lock count. A recount over the complete
`pnpm-lock.yaml` snapshot graph — every snapshot whose `dependencies` or
`optionalDependencies` edges select a package carrying an `os`, `cpu`, or
`libc` constraint — yields ten parents over 113 platform-constrained packages:
`playwright@1.61.0`, `vite@8.0.16`, `esbuild@0.28.2`, `rolldown@1.0.3`,
`lightningcss@1.33.0`, `msgpackr-extract@3.0.4`, `oxc-resolver@11.21.2`,
`oxc-parser@0.127.0`, `@opentui/core@0.4.1`, and `oxlint-tsgolint@0.23.0`. The
tenth is absent from the #1209 closure, which is why the probe did not see it.

The count is lockfile-derived and not a constant: a lock change may change it.
Admission recomputes the set from the lock and fails closed on a
platform-varying entry that carries no configured variant; no rule, test, or
document may hard-code the number as a correctness assertion.

### 2. The final flip covers the whole repository

The gate "all 17 #1209 packages are dist-servable" is a prerequisite subset,
not the gate. The single final authority change covers every repository
consumer of the superseded surface: all root-solution TypeScript projects, the
package check/build tasks, unit/integration and Storybook runners, Genie, lint
and other package-bin consumers, and every editor configuration. It deletes the
root install and its task edges in the same change (retiring DEPS-T02), and no
production consumer retains a source or package-manager fallback afterwards.

### 3. Three staged sandbox gates before the consumer flip

The Decision named "both platform sandbox gates". The staged gates are three,
one per admitted execution platform label: `exec_linux_x86_64`,
`exec_linux_aarch64`, and `exec_macos_aarch64`. Each passes its own in-Buck
positive-access, explicit negative-probe, and byte-identity smoke gate before
the consumer flip. Linux aarch64 uses the same Bubblewrap closure as x86_64 but
is a distinct execution platform and does not inherit x86_64 evidence; Darwin
arm64 additionally re-runs its gate on every supported macOS upgrade.

### 4. Mutation hashing is retired per platform, not globally

The pinned runner currently hashes the complete input tree before and after
`tsgo` to prove write-freedom without a sandbox. That control remains in force
on a platform until that platform's sandbox gate passes, and is deleted per
platform in the change that admits its gate. At no point does a platform
execute with neither the sandbox nor the hash control.

### 5. The development loop is Buck watch plus atomic snapshot refresh

Deleting the root install removes the pnpm inner loop, so the replacement loop
is part of this decision. A persistent watch loop drives the Buck daemon's
watchman-backed file watcher: a source change rebuilds exactly the affected
admitted typecheck/dist closure, and each package whose view fingerprint
changed gets its byte-owned editor snapshot republished through the existing
atomic candidate-rename-pointer sequence. The loop is an ordinary caller of
Buck — it interposes no launcher (decision 0011), holds no authority, and a
failed build or refusal to take the publication lock leaves the previous
pointer intact and fails loudly. Its steady-state latency is a BUCK-R07 budget,
because it is the inner loop developers now live in. Task and shell wiring is
deliberately outside this decision.

### 6. Candidate namespace builds are explicit while staging

Staged prerequisite PRs build the new store, sandbox, editor, and adoption
targets in an explicitly named candidate cache namespace and isolation dir.
Production namespace keys are untouched until the flip, and each staged PR's
evidence names the namespace it measured. The full candidate namespace E2E that
DQ4 requires runs in that same namespace.

### 7. DQ4 additionally bounds editor snapshot disk and retention

The byte-owned editor snapshot is a deliberate duplication boundary, so the
numeric envelope includes per-package snapshot bytes, the whole-repository
snapshot total, and the retained-generation count with its GC bound. An
unbounded snapshot store is a capacity regression even when every action is a
cache hit.

### 8. Open questions at amendment time

DQ1 (CI fetch without a warm `buck-out`) and DQ4 (numeric cold envelope) remain
blocked and both still block the flip. DQ3 (true remote execution) is
explicitly out of scope for this cutover: `remote_enabled` stays false and no
staged PR may enable it.

### Consequences of this amendment

- The vision criterion 9 root delta and the normalized-store cutover delta stay
  open; both now read "ten" and the whole-repository flip scope.
- Decision 0015's editor-surface cutover gate widens from whole-required
  consumer coverage on the dependency surface to the same single
  whole-repository flip (0015 Amendment 4).
- Phase 3 and Phase 4 of the roadmap converge into one staged sequence followed
  by one flip, instead of package-layer flips followed by a separate editor
  cutover.
